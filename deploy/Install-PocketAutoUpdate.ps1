#requires -Version 5.1
<#
.SYNOPSIS
Installs Pocket's one-minute server update task on the Windows server.
.DESCRIPTION
Run in elevated Windows PowerShell as the signed-in user running Docker Desktop.
The updater beside this installer is copied to a protected ProgramData directory.
Rerun this installer to update that stable script. No credentials are stored.
.EXAMPLE
.\Install-PocketAutoUpdate.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoPath = 'C:\Users\Administrator.WIN-SERVER-1\Documents\Codex\2026-11-11\deploy-pocket-s-api-server-as\work\pocket-family',
    [switch]$RunNow
)

function ConvertTo-PocketTaskArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    if ($Value -match '["\r\n\x00]') { throw 'Task paths cannot contain quotes or control characters.' }
    # All values are directories/files, never a drive root; avoid a backslash escaping the quote.
    return '"' + $Value.TrimEnd('\') + '"'
}

function New-PocketAutoUpdateTaskXml {
    param(
        [Parameter(Mandatory = $true)][string]$UserSid,
        [Parameter(Mandatory = $true)][string]$RepoPath,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$PowerShellPath,
        [datetime]$StartAt = (Get-Date).AddMinutes(1)
    )
    $runner = Join-Path $StateDirectory 'Update-PocketServer.ps1'
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File {0} -RepoPath {1} -StateDirectory {2}' -f `
        (ConvertTo-PocketTaskArgument $runner), (ConvertTo-PocketTaskArgument $RepoPath), (ConvertTo-PocketTaskArgument $StateDirectory)
    $sidXml = [System.Security.SecurityElement]::Escape($UserSid)
    $commandXml = [System.Security.SecurityElement]::Escape($PowerShellPath)
    $argumentsXml = [System.Security.SecurityElement]::Escape($arguments)
    $directoryXml = [System.Security.SecurityElement]::Escape($RepoPath)
    $startXml = $StartAt.ToString('yyyy-MM-ddTHH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
    # Omitting Duration gives an indefinite repetition, without an overflowing TimeSpan.MaxValue.
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Pocket server updates from upstream main. Requires this user to remain signed in with Docker Desktop running.</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$sidXml</UserId><Delay>PT1M</Delay></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>$startXml</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="PocketUser"><UserId>$sidXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT1H</ExecutionTimeLimit><Priority>7</Priority>
  </Settings>
  <Actions Context="PocketUser"><Exec><Command>$commandXml</Command><Arguments>$argumentsXml</Arguments><WorkingDirectory>$directoryXml</WorkingDirectory></Exec></Actions>
</Task>
"@
}

function Invoke-PocketInstallReadCommand {
    param([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage)
    # Native stderr is captured, never printed with potentially sensitive local configuration.
    $ErrorActionPreference = 'Continue'
    $output = @(& $FilePath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
    return ($output | ForEach-Object { $_.ToString() })
}

function Assert-PocketNoReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)
    $cursor = [System.IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing a junction or symbolic link in the updater path: $cursor"
            }
        }
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Get-PocketAutoUpdateInstallContext {
    param([Parameter(Mandatory = $true)][string]$RepoPath)
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open Windows PowerShell as administrator on the Pocket server, using the signed-in Docker Desktop user, then rerun this command.'
    }
    if ((Get-Process -Id $PID).SessionId -eq 0 -or $identity.IsSystem) {
        throw 'Run from the signed-in Docker Desktop user session, not SYSTEM or a background service.'
    }
    foreach ($command in @('git.exe', 'docker.exe', 'Get-ScheduledTask', 'Register-ScheduledTask', 'Start-ScheduledTask')) {
        $null = Get-Command $command -ErrorAction Stop
    }
    $repository = (Resolve-Path -LiteralPath $RepoPath -ErrorAction Stop).ProviderPath.TrimEnd('\')
    if (-not (Test-Path -LiteralPath (Join-Path $repository 'deploy\backup.ps1') -PathType Leaf)) {
        throw 'The live repository must contain deploy\backup.ps1. Use the existing server checkout, including its local deployment commits.'
    }
    $git = (Get-Command git.exe -ErrorAction Stop).Source
    $docker = (Get-Command docker.exe -ErrorAction Stop).Source
    $gitRoot = (Invoke-PocketInstallReadCommand $git @('-C', $repository, 'rev-parse', '--show-toplevel') 'The server checkout is not a readable Git repository.' | Select-Object -Last 1)
    if ([System.IO.Path]::GetFullPath($gitRoot).TrimEnd('\') -ine $repository) {
        throw 'RepoPath must name the root of the live Pocket Git checkout.'
    }
    $origin = (Invoke-PocketInstallReadCommand $git @('-C', $repository, 'remote', 'get-url', 'origin') 'The checkout needs its Pocket origin remote.' | Select-Object -Last 1)
    if ($origin -notmatch '^(https://github\.com/UpperDownGuy/pocket-family(?:\.git)?/?|git@github\.com:UpperDownGuy/pocket-family(?:\.git)?)$') {
        throw 'The live checkout origin must be UpperDownGuy/pocket-family on GitHub.'
    }
    $engine = (Invoke-PocketInstallReadCommand $docker @('info', '--format', '{{.OSType}}') 'Docker Desktop is unavailable for this user. Start its Linux engine on the server first.' | Select-Object -Last 1)
    if ($engine.Trim() -ne 'linux') { throw 'Pocket requires the Docker Desktop Linux engine.' }
    $null = Invoke-PocketInstallReadCommand $docker @('compose', 'version', '--short') 'Docker Compose v2 is required.'
    foreach ($service in @('api', 'https')) {
        $containers = @(Invoke-PocketInstallReadCommand $docker @('ps', '--filter', 'label=com.docker.compose.project=pocket', '--filter', "label=com.docker.compose.service=$service", '--filter', 'status=running', '--format', '{{.ID}}') "Cannot inspect the running pocket/$service service." | Where-Object { $_ -match '^[0-9a-f]{12,64}$' })
        if ($containers.Count -ne 1) { throw "Expected exactly one running pocket/$service container. This installer belongs on the existing Pocket server." }
    }
    # The source is the adjacent, downloaded deployment bundle or repository file, never a fetched HEAD script.
    $source = Join-Path $PSScriptRoot 'Update-PocketServer.ps1'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Keep Update-PocketServer.ps1 beside this installer in the same deployment bundle.' }
    $uninstaller = Join-Path $PSScriptRoot 'Uninstall-PocketAutoUpdate.ps1'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Keep Uninstall-PocketAutoUpdate.ps1 beside this installer in the same deployment bundle.' }
    Assert-PocketNoReparsePoint $source
    Assert-PocketNoReparsePoint $uninstaller
    $tokens = $null
    $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'The adjacent updater has PowerShell syntax errors; no task was installed.' }
    $stateDirectory = Join-Path $env:ProgramData 'Pocket\Updater'
    Assert-PocketNoReparsePoint $stateDirectory
    Assert-PocketNoReparsePoint (Join-Path $stateDirectory 'Update-PocketServer.ps1')
    Assert-PocketNoReparsePoint (Join-Path $stateDirectory 'Uninstall-PocketAutoUpdate.ps1')
    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) { throw 'Windows PowerShell 5.1 is required.' }
    $task = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq 'Pocket Server Auto Update' }
    if ($null -ne $task -and $task.State -eq 'Running') { throw 'Pocket is currently checking or deploying an update. Wait for that task to finish before reinstalling it.' }
    return [pscustomobject]@{
        RepoPath = $repository
        StateDirectory = $stateDirectory
        Source = $source
        SourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
        Uninstaller = $uninstaller
        UninstallerHash = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash
        UserSid = $identity.User.Value
        UserName = $identity.Name
        PowerShellPath = $powerShellPath
    }
}

function Set-PocketUpdaterDirectoryAcl {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$UserSid)
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($UserSid)))
    foreach ($sid in @($UserSid, 'S-1-5-32-544', 'S-1-5-18') | Select-Object -Unique) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            (New-Object System.Security.Principal.SecurityIdentifier($sid)),
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $security.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $security -ErrorAction Stop
}

function Install-PocketAutoUpdate {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param([Parameter(Mandatory = $true)][string]$RepoPath, [switch]$RunNow)
    $ErrorActionPreference = 'Stop'
    $context = Get-PocketAutoUpdateInstallContext -RepoPath $RepoPath
    $taskXml = New-PocketAutoUpdateTaskXml -UserSid $context.UserSid -RepoPath $context.RepoPath -StateDirectory $context.StateDirectory -PowerShellPath $context.PowerShellPath
    $target = Join-Path $context.StateDirectory 'Update-PocketServer.ps1'
    $action = "Copy updater SHA256 $($context.SourceHash), restrict its directory to this user/Administrators/SYSTEM, and register the one-minute task as $($context.UserName)"
    if ($RunNow) { $action += ', then start the first update check now' }
    if (-not $PSCmdlet.ShouldProcess("$target; scheduled task '\Pocket Server Auto Update'", $action)) { return }

    # Both task code and logs/state stay outside the mutable application checkout.
    $pocketDirectory = Split-Path -Parent $context.StateDirectory
    foreach ($directory in @($pocketDirectory, $context.StateDirectory)) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { $null = New-Item -ItemType Directory -Path $directory -ErrorAction Stop }
        Set-PocketUpdaterDirectoryAcl -Path $directory -UserSid $context.UserSid
    }
    $temporary = Join-Path $context.StateDirectory ('updater-install-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Copy-Item -LiteralPath $context.Source -Destination $temporary -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $context.SourceHash) { throw 'The updater changed during installation. Rerun using an unchanged deployment bundle.' }
        Move-Item -LiteralPath $temporary -Destination $target -Force -ErrorAction Stop
        Copy-Item -LiteralPath $context.Uninstaller -Destination $temporary -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $context.UninstallerHash) { throw 'The uninstaller changed during installation. Rerun using an unchanged deployment bundle.' }
        Move-Item -LiteralPath $temporary -Destination (Join-Path $context.StateDirectory 'Uninstall-PocketAutoUpdate.ps1') -Force -ErrorAction Stop
        $null = Register-ScheduledTask -TaskName 'Pocket Server Auto Update' -TaskPath '\' -Xml $taskXml -Force -ErrorAction Stop
        if ($RunNow) { Start-ScheduledTask -TaskName 'Pocket Server Auto Update' -TaskPath '\' -ErrorAction Stop }
    }
    finally {
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -ErrorAction SilentlyContinue }
    }
    Write-Output "Installed '\Pocket Server Auto Update' for $($context.UserName). Checks repeat every minute and after sign-in."
    if ($RunNow) { Write-Output 'Started the first update check in the background. Check the updater log for its result.' }
    else { Write-Output 'The first check is in about one minute.' }
    Write-Output "Keep this Windows user signed in and Docker Desktop running. Logs and state: $($context.StateDirectory). Rerun the installer to update the stable updater script."
}

# Dot-sourcing loads functions for verification without inspecting or changing the server.
if ($MyInvocation.InvocationName -ne '.') {
    Install-PocketAutoUpdate -RepoPath $RepoPath -RunNow:$RunNow -WhatIf:$WhatIfPreference
}
