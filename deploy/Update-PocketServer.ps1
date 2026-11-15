#requires -Version 5.1
[CmdletBinding()]
param(
    [Alias('RepositoryPath')][string]$RepoPath,
    [string]$StateDirectory = (Join-Path $env:ProgramData 'Pocket\Updater'),
    [string]$UpstreamRef = 'main',
    [string]$HealthUrl = 'https://pocket.alexxweb.com/health',
    [ValidateRange(15, 600)][int]$HealthTimeoutSeconds = 90,
    [switch]$RetryFailed,
    [switch]$CheckOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-PocketProperty {
    param($Value, [string]$Name, $Default = $null)
    if ($null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]) { return $Value.$Name }
    return $Default
}

function ConvertTo-PocketNativeArgument {
    param([AllowEmptyString()][string]$Value)
    # ProcessStartInfo on Windows PowerShell 5.1 has no ArgumentList property.
    # Quote according to the Windows CRT rules; never invoke a command shell.
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-PocketNativeProcess {
    param($Request)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Request.FilePath
    $info.Arguments = (($Request.Arguments | ForEach-Object { ConvertTo-PocketNativeArgument ([string]$_) }) -join ' ')
    $info.WorkingDirectory = $Request.WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $info.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Could not start the required process.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Request.TimeoutSeconds * 1000)) {
            try { $process.Kill() } catch { }
            throw ('{0} timed out. No further update commands will run.' -f $Request.Purpose)
        }
        $process.WaitForExit()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Result; StdErr = $stderr.Result }
    } finally { $process.Dispose() }
}

function Invoke-PocketCommand {
    param($Context, [string]$Purpose, [string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 120)
    $request = [pscustomobject]@{ Purpose = $Purpose; FilePath = $FilePath; Arguments = $Arguments;
        WorkingDirectory = $Context.RepoPath; TimeoutSeconds = $TimeoutSeconds }
    $Context.LastPurpose = $Purpose
    $result = & $Context.Runner $request
    if ($null -eq $result -or $result.ExitCode -ne 0) {
        # CLI output can contain credentials expanded from Compose. Never persist
        # commands, stdout, stderr, environment values or effective config.
        $code = if ($null -eq $result) { 'unknown' } else { [string]$result.ExitCode }
        throw ('{0} failed (exit {1}). Review that command privately on the server.' -f $Purpose, $code)
    }
    return [string]$result.StdOut
}

function ConvertFrom-PocketJSON {
    param([string]$Text, [string]$Description)
    try { return ConvertFrom-Json -InputObject $Text } catch { throw ('Invalid JSON returned for {0}.' -f $Description) }
}

function Get-PocketHash {
    param([string]$Text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Write-PocketLog {
    param($Context, [string]$Message)
    $line = '{0} {1}' -f [DateTime]::UtcNow.ToString('o'), $Message
    # A log write failure must not roll back a deployment after its durable
    # success marker has committed. State writes remain mandatory/atomic.
    try { Add-Content -LiteralPath $Context.LogPath -Value $line -Encoding UTF8 }
    catch { Write-Warning 'Pocket updater could not write its log; check updater storage.' }
}

function Write-PocketJSONFile {
    param([string]$Path, $Value)
    $pending = $Path + '.pending'
    [IO.File]::WriteAllText($pending, (ConvertTo-Json $Value -Depth 10), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($pending, $Path, $null) }
    else { [IO.File]::Move($pending, $Path) }
}

function Test-PocketRevisionMarker {
    param($Marker, [string]$RemoteHead, [string]$LiveHead, [string]$ImageId, [string]$ConfigHash)
    return $null -ne $Marker -and $Marker.RemoteHead -eq $RemoteHead -and $Marker.LiveHead -eq $LiveHead -and $Marker.ImageId -eq $ImageId -and $Marker.ConfigHash -eq $ConfigHash
}

function Test-PocketOrigin {
    param([string]$Origin)
    return $Origin -match '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)UpperDownGuy/pocket-family(?:\.git)?/?$'
}

function Get-PocketMountIdentity {
    param($Mounts)
    $selected = @($Mounts | Sort-Object Destination | ForEach-Object {
        [ordered]@{ Type = $_.Type; Name = Get-PocketProperty $_ 'Name' ''; Source = $_.Source;
            Destination = $_.Destination; RW = $_.RW; Propagation = Get-PocketProperty $_ 'Propagation' '' }
    })
    return ConvertTo-Json -InputObject $selected -Depth 8 -Compress
}

function Get-PocketComposeConfig {
    param($Context)
    $raw = Invoke-PocketCommand $Context 'ReadComposeConfig' 'docker.exe' ($Context.ComposeArguments + @('config', '--format', 'json'))
    $config = ConvertFrom-PocketJSON $raw 'Compose configuration'
    $api = Get-PocketProperty $config.services 'api'
    if ($null -eq $api) { throw 'The live Compose project has no api service.' }
    $build = Get-PocketProperty $api 'build'
    if ($null -eq $build) { throw 'The api service must have a local build context.' }
    $contextPath = Get-PocketProperty $build 'context' ''
    if (-not [IO.Path]::IsPathRooted($contextPath)) { $contextPath = Join-Path $Context.RepoPath $contextPath }
    if ([IO.Path]::GetFullPath($contextPath).TrimEnd('\', '/') -ine (Join-Path $Context.RepoPath 'server')) {
        throw 'The api build context must be this checkout''s server directory.'
    }
    foreach ($unsupported in @('additional_contexts', 'dockerfile_inline', 'secrets', 'ssh')) {
        if ($null -ne (Get-PocketProperty $build $unsupported)) { throw ('Review the api build option {0} before enabling automatic updates.' -f $unsupported) }
    }
    $dockerfile = Get-PocketProperty $build 'dockerfile' 'Dockerfile'
    if ([IO.Path]::IsPathRooted($dockerfile) -or $dockerfile -match '(^|[\\/])\.\.([\\/]|$)') {
        throw 'The Dockerfile must be inside the server build context.'
    }
    $volume = @($api.volumes | Where-Object { $_.type -eq 'volume' -and $_.target -eq '/app/data' })
    if ($volume.Count -ne 1) { throw 'Compose must retain one named data volume at /app/data.' }
    $declared = Get-PocketProperty $config.volumes $volume[0].source
    if ((Get-PocketProperty $declared 'name' '') -ne 'pocket-data' -or (Get-PocketProperty $volume[0] 'read_only' $false)) {
        throw 'Compose must retain the writable pocket-data volume.'
    }
    return [pscustomobject]@{ Config = $config; Api = $api; Dockerfile = $dockerfile; Hash = Get-PocketHash $raw }
}

function Get-PocketSnapshot {
    param($Context)
    $apiID = (Invoke-PocketCommand $Context 'FindApiContainer' 'docker.exe' ($Context.ComposeArguments + @('ps', '-q', 'api'))).Trim()
    if ($apiID -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected exactly one running api container.' }
    $api = @(ConvertFrom-PocketJSON (Invoke-PocketCommand $Context 'InspectApi' 'docker.exe' @('inspect', $apiID)) 'api container')[0]
    if ($api.Config.Labels.'com.docker.compose.project' -ne 'pocket' -or $api.Config.Labels.'com.docker.compose.service' -ne 'api') {
        throw 'The API container does not belong to pocket/api.'
    }
    $composeWorkingDir = Get-PocketProperty $api.Config.Labels 'com.docker.compose.project.working_dir' ''
    if ($composeWorkingDir -and [IO.Path]::GetFullPath($composeWorkingDir).TrimEnd('\', '/') -ine $Context.RepoPath) {
        throw 'The running Pocket container belongs to a different checkout.'
    }
    if (-not $api.State.Running) { throw 'The existing API is not running; restore it before enabling updates.' }
    $dataMount = @($api.Mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -eq 'pocket-data' -and $_.Destination -eq '/app/data' -and $_.RW })
    if ($dataMount.Count -ne 1) { throw 'Expected the existing pocket-data volume at /app/data. No update was activated.' }
    $tlsVolume = @(ConvertFrom-PocketJSON (Invoke-PocketCommand $Context 'InspectTlsVolume' 'docker.exe' @('volume', 'inspect', 'pocket-tls')) 'TLS volume')[0]
    $tlsID = (Invoke-PocketCommand $Context 'FindTlsContainer' 'docker.exe' @('ps', '-q', '--filter', 'label=com.docker.compose.project=pocket', '--filter', 'volume=pocket-tls')).Trim()
    if ($tlsID -notmatch '^[a-f0-9]{12,64}$') { throw 'Expected exactly one running Pocket HTTPS container using pocket-tls.' }
    $healthScript = "fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error();const x=await r.json();if(typeof x.setupRequired!=='boolean')throw Error();console.log(JSON.stringify({setupRequired:x.setupRequired}));}).catch(()=>process.exit(1))"
    $health = ConvertFrom-PocketJSON (Invoke-PocketCommand $Context 'CheckApiHealth' 'docker.exe' @('exec', $apiID, 'node', '-e', $healthScript) 15) 'API health'
    return [pscustomobject]@{ ApiId = $apiID; ImageId = $api.Image; ImageReference = $api.Config.Image;
        Mounts = Get-PocketMountIdentity $api.Mounts; TlsId = $tlsID;
        TlsVolume = Get-PocketHash (ConvertTo-Json $tlsVolume -Depth 10 -Compress); SetupRequired = $health.setupRequired }
}

function Assert-PocketSnapshot {
    param($Before, $After, [string]$ExpectedImage)
    if ($Before.Mounts -cne $After.Mounts -or $Before.TlsVolume -ne $After.TlsVolume -or $Before.TlsId -ne $After.TlsId) {
        throw 'Container mount or HTTPS identity changed. Automatic update cannot continue.'
    }
    if ($After.ImageId -ne $ExpectedImage) { throw 'The API is not running the expected image.' }
    if (-not $Before.SetupRequired -and $After.SetupRequired) { throw 'The API unexpectedly reports an empty family database.' }
}

function Wait-PocketSnapshot {
    param($Context, $Before, [string]$ExpectedImage, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $snapshot = Get-PocketSnapshot $Context
            Assert-PocketSnapshot $Before $snapshot $ExpectedImage
            return $snapshot
        } catch {
            # Compose --wait may only wait for "running" when no Docker health
            # check is defined. Retry that HTTP-startup race; never retry away
            # a mount, image or unexpectedly empty database mismatch.
            if ($_.Exception.Message -notmatch '^CheckApiHealth failed' -or [DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

function Get-PocketHTTPSHealth {
    param($Context)
    # A separate native PowerShell process keeps this probe injectable in tests.
    # HttpWebRequest uses normal Windows certificate validation. Redirects and
    # ambient/default credentials are explicitly disabled; response text is
    # bounded and never logged. TLS 1.2 supports Windows PowerShell 5.1 hosts.
    $escapedUrl = $Context.HealthUrl.Replace("'", "''")
    $command = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$response = $null
$reader = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $request = [Net.HttpWebRequest]::Create('__POCKET_HEALTH_URL__')
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $false
    $request.UseDefaultCredentials = $false
    $request.Credentials = $null
    if ($null -ne $request.Proxy) { $request.Proxy.Credentials = $null }
    $request.Timeout = 10000
    $request.ReadWriteTimeout = 10000
    $request.Accept = 'application/json'
    $request.UserAgent = 'Pocket-Server-Updater'
    $response = $request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { throw 'Unexpected status.' }
    $reader = New-Object IO.StreamReader($response.GetResponseStream())
    $buffer = New-Object char[] 4097
    $count = $reader.ReadBlock($buffer, 0, $buffer.Length)
    if ($count -lt 1 -or $count -gt 4096) { throw 'Invalid response length.' }
    $value = ConvertFrom-Json (-join $buffer[0..($count - 1)])
    if ($value.setupRequired -isnot [bool]) { throw 'Unexpected health payload.' }
    Write-Output (ConvertTo-Json @{ setupRequired = $value.setupRequired } -Compress)
} catch { exit 1 }
finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $response) { $response.Close() }
}
'@
    $command = $command.Replace('__POCKET_HEALTH_URL__', $escapedUrl)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    return ConvertFrom-PocketJSON (Invoke-PocketCommand $Context 'CheckHTTPSHealth' 'powershell.exe' @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) 25) 'HTTPS API health'
}

function Wait-PocketHTTPSHealth {
    param($Context, $Before, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $health = Get-PocketHTTPSHealth $Context
            if (-not $Before.SetupRequired -and $health.setupRequired) { throw 'HTTPS unexpectedly reports an empty family database.' }
            return
        } catch {
            # Allow old nginx workers to drain after reload. A valid response
            # showing lost data is not a transient startup error.
            if ($_.Exception.Message -notmatch '^CheckHTTPSHealth failed' -or [DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

function Update-PocketProxyRouting {
    param($Context, $Before, [int]$TimeoutSeconds)
    $null = Invoke-PocketCommand $Context 'ValidateNginx' 'docker.exe' @('exec', $Before.TlsId, 'nginx', '-t') 30
    # Reload the same container so nginx resolves the replacement API address.
    # No HTTPS container or TLS volume is recreated or modified by Compose.
    $null = Invoke-PocketCommand $Context 'ReloadNginx' 'docker.exe' @('exec', $Before.TlsId, 'nginx', '-s', 'reload') 30
    Wait-PocketHTTPSHealth $Context $Before $TimeoutSeconds
}

function Assert-PocketLiveSource {
    param($Context, [string]$ExpectedHead, [string]$ExpectedConfigHash)
    $head = (Invoke-PocketCommand $Context 'ReadLiveHead' 'git.exe' @('-C', $Context.RepoPath, 'rev-parse', 'HEAD')).Trim()
    if ($head -ne $ExpectedHead) { throw 'The live checkout changed during this update; try again after edits finish.' }
    $dirty = Invoke-PocketCommand $Context 'ReadTrackedStatus' 'git.exe' @('-C', $Context.RepoPath, 'status', '--porcelain', '--untracked-files=no')
    if (-not [string]::IsNullOrWhiteSpace($dirty)) { throw 'The live checkout has uncommitted tracked edits. Commit or review them before updating.' }
    if ((Get-PocketComposeConfig $Context).Hash -ne $ExpectedConfigHash) { throw 'The live Compose configuration changed during this update.' }
}

function Invoke-PocketBackup {
    param($Context)
    $backup = Join-Path $Context.RepoPath 'deploy\backup.ps1'
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) { throw 'The required live deploy\backup.ps1 is missing. Nothing will be built or activated.' }
    # Run the user's existing backup in a separate Windows PowerShell process.
    # Set terminating PowerShell error behavior and propagate native exit status.
    $quotedPath = $backup.Replace("'", "''")
    $command = "`$ErrorActionPreference='Stop'; `$global:LASTEXITCODE=0; & '$quotedPath'; if (-not `$?) { exit 1 }; if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }; exit 0"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $null = Invoke-PocketCommand $Context 'Backup' 'powershell.exe' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) 600
    Write-PocketLog $Context 'The existing backup script exited successfully. Its output was not copied into updater logs.'
}

function Remove-PocketCandidate {
    param($Context, [string]$RunPath)
    if (-not $RunPath -or -not (Test-Path -LiteralPath $RunPath)) { return }
    $root = [IO.Path]::GetFullPath((Join-Path $Context.StateDirectory 'work')).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($RunPath)
    if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or $resolved -eq $root.TrimEnd('\')) {
        throw 'Refusing cleanup outside the updater work directory.'
    }
    if ((Get-Item -LiteralPath $RunPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing cleanup of a redirected work directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-PocketUpdate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoPath,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [string]$UpstreamRef = 'main',
        [string]$HealthUrl = 'https://pocket.alexxweb.com/health',
        [int]$HealthTimeoutSeconds = 90,
        [switch]$CheckOnly,
        [switch]$RetryFailed,
        [scriptblock]$Runner = { param($request) Invoke-PocketNativeProcess $request }
    )
    $repo = [IO.Path]::GetFullPath($RepoPath).TrimEnd('\', '/')
    $stateDir = [IO.Path]::GetFullPath($StateDirectory).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'RepoPath must be the existing live Git checkout.' }
    if ($stateDir -ieq $repo -or $stateDir.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'StateDirectory must be outside the live checkout.'
    }
    if ($UpstreamRef -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$' -or $UpstreamRef.Contains('..')) { throw 'Invalid upstream branch name.' }
    $healthUri = $null
    if (-not [Uri]::TryCreate($HealthUrl, [UriKind]::Absolute, [ref]$healthUri) -or $healthUri.Scheme -ne 'https' -or $healthUri.UserInfo -or $healthUri.Query -or $healthUri.Fragment) {
        throw 'HealthUrl must be an absolute HTTPS URL without credentials, a query or a fragment.'
    }
    $null = New-Item -ItemType Directory -Path $stateDir -Force
    if ((Get-Item -LiteralPath $stateDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'StateDirectory must not be a junction or symlink.' }
    try { $lease = [IO.File]::Open((Join-Path $stateDir 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { return [pscustomobject]@{ ExitCode = 2; Status = 'Another Pocket updater is running.' } }
    $runPath = $null
    $context = $null
    $before = $null
    $config = $null
    $liveHead = $null
    $remoteHead = $null
    try {
        $composeFiles = @((Join-Path $repo 'compose.yaml'))
        if (-not (Test-Path -LiteralPath $composeFiles[0] -PathType Leaf)) { throw 'The live compose.yaml is missing.' }
        $override = Join-Path $repo 'compose.override.yaml'
        if (Test-Path -LiteralPath $override -PathType Leaf) { $composeFiles += $override }
        $composeArgs = @('compose', '--ansi', 'never', '--project-directory', $repo, '--project-name', 'pocket')
        foreach ($file in $composeFiles) { $composeArgs += @('-f', $file) }
        $context = [pscustomobject]@{ RepoPath = $repo; StateDirectory = $stateDir; Runner = $Runner;
            LogPath = Join-Path $stateDir ('update-' + [DateTime]::UtcNow.ToString('yyyy-MM-dd') + '.log'); ComposeArguments = $composeArgs; LastPurpose = 'Start'; HealthUrl = $healthUri.AbsoluteUri }
        Write-PocketLog $context 'Started update check.'
        $null = Invoke-PocketCommand $context 'CheckUpstreamRef' 'git.exe' @('check-ref-format', ('refs/heads/' + $UpstreamRef))
        $origin = (Invoke-PocketCommand $context 'ReadOrigin' 'git.exe' @('-C', $repo, 'remote', 'get-url', 'origin')).Trim()
        if (-not (Test-PocketOrigin $origin)) { throw 'Origin must be the approved GitHub UpperDownGuy/pocket-family repository, without URL credentials.' }
        $liveHead = (Invoke-PocketCommand $context 'ReadLiveHead' 'git.exe' @('-C', $repo, 'rev-parse', 'HEAD')).Trim()
        if ($liveHead -notmatch '^[a-f0-9]{40,64}$') { throw 'Could not identify the live Git commit.' }
        $config = Get-PocketComposeConfig $context
        Assert-PocketLiveSource $context $liveHead $config.Hash
        $untracked = Invoke-PocketCommand $context 'ReadUntrackedServer' 'git.exe' @('-C', $repo, 'ls-files', '--others', '--exclude-standard', '--', 'server')
        if (-not [string]::IsNullOrWhiteSpace($untracked)) { throw 'Untracked build files exist under server. Commit or review them before updating; they will not be copied.' }
        $before = Get-PocketSnapshot $context
        $null = Invoke-PocketCommand $context 'ValidateNginx' 'docker.exe' @('exec', $before.TlsId, 'nginx', '-t') 30
        Wait-PocketHTTPSHealth $context $before $HealthTimeoutSeconds
        $activeTag = Get-PocketProperty $config.Api 'image' ''
        if ([string]::IsNullOrWhiteSpace($activeTag)) {
            if ($before.ImageReference -ne 'pocket-api') { throw 'The implicit API image tag is not pocket-api. Set and review an explicit Compose image first.' }
            $activeTag = 'pocket-api'
        }
        if ($activeTag -ne $before.ImageReference -or $activeTag -match '[@\s]' -or $activeTag.StartsWith('sha256:')) {
            throw 'The effective Compose image must match the running API and use a mutable local tag.'
        }
        $successPath = Join-Path $stateDir 'last-success.json'
        $previous = $null
        if (Test-Path -LiteralPath $successPath -PathType Leaf) {
            $previous = ConvertFrom-PocketJSON (Get-Content -Raw -LiteralPath $successPath) 'last successful deployment'
            if ($previous.ImageId -ne $before.ImageId) { throw 'The running image changed outside the updater. Review deployment state before continuing.' }
        }
        $remoteLine = (Invoke-PocketCommand $context 'CheckRemoteHead' 'git.exe' @('-C', $repo, 'ls-remote', '--exit-code', 'origin', ('refs/heads/' + $UpstreamRef)) 120).Trim()
        if ($remoteLine -notmatch '^([a-f0-9]{40,64})\s+refs/heads/') { throw 'Could not identify the upstream branch.' }
        $remoteHead = $Matches[1]
        if ($null -ne $previous -and $previous.UpstreamCommit -eq $remoteHead -and $previous.LiveHead -eq $liveHead -and (Get-PocketProperty $previous 'ConfigHash' '') -eq $config.Hash) {
            Write-PocketLog $context 'Upstream, live source and active image match the successful deployment; no build needed.'
            return [pscustomobject]@{ ExitCode = 0; Status = 'Already up to date.' }
        }
        $checkPath = Join-Path $stateDir 'last-check.json'
        if (Test-Path -LiteralPath $checkPath) {
            $checked = ConvertFrom-PocketJSON (Get-Content -Raw -LiteralPath $checkPath) 'last check cache'
            if (Test-PocketRevisionMarker $checked $remoteHead $liveHead $before.ImageId $config.Hash) {
                Write-PocketLog $context 'Previously checked revision has no server changes; skipping clone and merge.'
                return [pscustomobject]@{ ExitCode = 0; Status = 'Already checked; no server changes.' }
            }
        }
        $failurePath = Join-Path $stateDir 'last-failure.json'
        if (-not $RetryFailed -and -not $CheckOnly -and (Test-Path -LiteralPath $failurePath)) {
            $failed = ConvertFrom-PocketJSON (Get-Content -Raw -LiteralPath $failurePath) 'failure backoff'
            if ((Test-PocketRevisionMarker $failed $remoteHead $liveHead $before.ImageId $config.Hash) -and ([DateTime]$failed.NextAttemptUtc).ToUniversalTime() -gt [DateTime]::UtcNow) {
                Write-PocketLog $context 'This unchanged failed revision is in its 15-minute retry backoff; no backup or build.'
                return [pscustomobject]@{ ExitCode = 0; Status = 'Failed revision is waiting for retry; use -RetryFailed to retry now.' }
            }
        }
        $workRoot = Join-Path $stateDir 'work'
        $null = New-Item -ItemType Directory -Path $workRoot -Force
        if ((Get-Item -LiteralPath $workRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The updater work directory must not be redirected.' }
        $runPath = Join-Path $workRoot ([Guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $runPath
        $candidate = Join-Path $runPath 'candidate'
        $hooks = Join-Path $runPath 'empty-hooks'
        $null = New-Item -ItemType Directory -Path $hooks
        $null = Invoke-PocketCommand $context 'CloneCandidate' 'git.exe' @('-c', ('core.hooksPath=' + $hooks), 'clone', '--no-hardlinks', '--no-checkout', '--', $repo, $candidate)
        $null = Invoke-PocketCommand $context 'CheckoutCandidate' 'git.exe' @('-C', $candidate, '-c', ('core.hooksPath=' + $hooks), 'checkout', '--detach', $liveHead)
        $null = Invoke-PocketCommand $context 'ConfigureCandidateOrigin' 'git.exe' @('-C', $candidate, 'remote', 'set-url', 'origin', $origin)
        $remoteRef = 'refs/remotes/origin/' + $UpstreamRef
        $null = Invoke-PocketCommand $context 'FetchUpstream' 'git.exe' @('-C', $candidate, 'fetch', '--no-tags', 'origin', ('+refs/heads/' + $UpstreamRef + ':' + $remoteRef)) 180
        $upstreamCommit = (Invoke-PocketCommand $context 'ReadUpstreamCommit' 'git.exe' @('-C', $candidate, 'rev-parse', $remoteRef)).Trim()
        $null = Invoke-PocketCommand $context 'MergeCandidate' 'git.exe' @('-C', $candidate, '-c', ('core.hooksPath=' + $hooks), '-c', 'commit.gpgsign=false', '-c', 'user.name=Pocket Updater', '-c', 'user.email=pocket-updater@localhost', 'merge', '--no-edit', '--no-verify', $remoteRef)
        $mergedCommit = (Invoke-PocketCommand $context 'ReadMergedCommit' 'git.exe' @('-C', $candidate, 'rev-parse', 'HEAD')).Trim()
        $serverTree = (Invoke-PocketCommand $context 'ReadCandidateTree' 'git.exe' @('-C', $candidate, 'rev-parse', 'HEAD:server')).Trim()
        if ($upstreamCommit -notmatch '^[a-f0-9]{40,64}$' -or $mergedCommit -notmatch '^[a-f0-9]{40,64}$' -or $serverTree -notmatch '^[a-f0-9]{40,64}$') { throw 'Candidate source identifiers are invalid.' }
        $baselineTree = if ($null -ne $previous) { $previous.ServerTree } else { (Invoke-PocketCommand $context 'ReadLiveTree' 'git.exe' @('-C', $repo, 'rev-parse', 'HEAD:server')).Trim() }
        if ($serverTree -eq $baselineTree) {
            Write-PocketJSONFile $checkPath ([ordered]@{ CheckedAt = [DateTime]::UtcNow.ToString('o'); RemoteHead = $upstreamCommit;
                LiveHead = $liveHead; ImageId = $before.ImageId; ConfigHash = $config.Hash; ServerTree = $serverTree })
            Write-PocketLog $context 'No server-tree changes. No backup, build or activation was run.'
            return [pscustomobject]@{ ExitCode = 0; Status = 'No server changes.' }
        }
        $candidateServer = Join-Path $candidate 'server'
        if (-not (Test-Path -LiteralPath (Join-Path $candidateServer $config.Dockerfile) -PathType Leaf)) { throw 'The merged candidate lacks the live deployment Dockerfile. Commit it locally before updating.' }
        if ($CheckOnly) {
            Write-PocketLog $context 'Server changes merge successfully in isolation. CheckOnly performed no deployment.'
            return [pscustomobject]@{ ExitCode = 0; Status = 'Server update available; isolated merge passed.' }
        }
        Assert-PocketLiveSource $context $liveHead $config.Hash
        Invoke-PocketBackup $context
        Assert-PocketLiveSource $context $liveHead $config.Hash
        Assert-PocketSnapshot $before (Get-PocketSnapshot $context) $before.ImageId
        $candidateTag = 'pocket-api-candidate:' + $serverTree.Substring(0, 12) + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
        $buildOverride = Join-Path $runPath 'candidate-build.json'
        $buildConfig = @{ services = @{ api = @{ image = $candidateTag; build = @{ context = $candidateServer; dockerfile = $config.Dockerfile;
            labels = @{ 'org.opencontainers.image.revision' = $mergedCommit; 'com.pocket.server-tree' = $serverTree } } } } }
        [IO.File]::WriteAllText($buildOverride, (ConvertTo-Json $buildConfig -Depth 10), (New-Object Text.UTF8Encoding($false)))
        $null = Invoke-PocketCommand $context 'BuildCandidate' 'docker.exe' ($composeArgs + @('-f', $buildOverride, 'build', '--pull', 'api')) 1800
        $candidateImage = (Invoke-PocketCommand $context 'InspectCandidateImage' 'docker.exe' @('image', 'inspect', '--format', '{{.Id}}', $candidateTag)).Trim()
        if ($candidateImage -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Docker did not return a valid candidate image ID.' }
        $testDirectory = Join-Path $candidateServer 'tests'
        if (-not (Test-Path -LiteralPath $testDirectory -PathType Container)) { throw 'The candidate has no server test directory; review before deployment.' }
        $tests = @(Get-ChildItem -LiteralPath $testDirectory -File -Filter '*.test.mjs')
        if ($tests.Count -eq 0) { throw 'The candidate has no server tests; review before deployment.' }
        $testArguments = @('run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,mode=1777',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--mount', ('type=bind,src=' + $candidateServer + ',dst=/verify,readonly'),
            '--workdir', '/verify', '--entrypoint', 'node', $candidateImage, '--test')
        foreach ($test in $tests) { $testArguments += '/verify/tests/' + $test.Name }
        $null = Invoke-PocketCommand $context 'TestCandidate' 'docker.exe' $testArguments 600
        Assert-PocketLiveSource $context $liveHead $config.Hash
        Assert-PocketSnapshot $before (Get-PocketSnapshot $context) $before.ImageId
        $activationStarted = $false
        try {
            $activationStarted = $true
            $null = Invoke-PocketCommand $context 'TagCandidateActive' 'docker.exe' @('image', 'tag', $candidateImage, $activeTag)
            $upArguments = $composeArgs + @('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', [string]$HealthTimeoutSeconds, 'api')
            $null = Invoke-PocketCommand $context 'ActivateCandidate' 'docker.exe' $upArguments ($HealthTimeoutSeconds + 60)
            $after = Wait-PocketSnapshot $context $before $candidateImage $HealthTimeoutSeconds
            Update-PocketProxyRouting $context $before $HealthTimeoutSeconds
            $state = [ordered]@{ Version = 1; DeployedAt = [DateTime]::UtcNow.ToString('o'); UpstreamCommit = $upstreamCommit;
                MergedCommit = $mergedCommit; LiveHead = $liveHead; ServerTree = $serverTree; ImageId = $candidateImage;
                PreviousImageId = $before.ImageId; ImageReference = $activeTag; ConfigHash = $config.Hash }
            Write-PocketJSONFile $successPath $state
            Write-PocketLog $context ('Deployment healthy. Server tree {0}; upstream {1}.' -f $serverTree, $upstreamCommit)
            return [pscustomobject]@{ ExitCode = 0; Status = 'Pocket API updated and healthy.' }
        } catch {
            if ($activationStarted) {
                Write-PocketLog $context 'Activation failed; restoring the previous image tag and API container. Database and TLS volumes remain untouched.'
                try {
                    $null = Invoke-PocketCommand $context 'TagPreviousActive' 'docker.exe' @('image', 'tag', $before.ImageId, $activeTag)
                    $null = Invoke-PocketCommand $context 'RollbackApi' 'docker.exe' ($composeArgs + @('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', [string]$HealthTimeoutSeconds, 'api')) ($HealthTimeoutSeconds + 60)
                    $null = Wait-PocketSnapshot $context $before $before.ImageId $HealthTimeoutSeconds
                    Update-PocketProxyRouting $context $before $HealthTimeoutSeconds
                    Write-PocketLog $context 'Previous API image restored and healthy. Update was not recorded as successful.'
                } catch { throw 'Update and image rollback did not both complete. Inspect the live API privately; no volume or database restore was attempted.' }
            }
            throw 'Update failed. The previous API image was restored and verified; successful deployment state was not advanced.'
        }
    } catch {
        if (-not $CheckOnly -and $null -ne $context -and $null -ne $before -and $null -ne $config -and $remoteHead) {
            try {
                Write-PocketJSONFile (Join-Path $stateDir 'last-failure.json') ([ordered]@{
                    FailedAtUtc = [DateTime]::UtcNow.ToString('o'); NextAttemptUtc = [DateTime]::UtcNow.AddMinutes(15).ToString('o');
                    RemoteHead = $remoteHead; LiveHead = $liveHead; ImageId = $before.ImageId; ConfigHash = $config.Hash; Stage = $context.LastPurpose })
            } catch { Write-PocketLog $context 'Could not persist failure backoff; review updater storage before the next scheduled check.' }
        }
        if ($null -ne $context) { Write-PocketLog $context ('Stopped: ' + $_.Exception.Message) }
        throw
    } finally {
        if ($null -ne $context -and $null -ne $runPath) {
            try { Remove-PocketCandidate $context $runPath } catch { Write-PocketLog $context 'Could not remove the isolated candidate directory; review updater work storage.' }
        }
        $lease.Dispose()
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ([string]::IsNullOrWhiteSpace($RepoPath)) { throw 'Pass -RepoPath with the existing live Pocket checkout.' }
        $result = Invoke-PocketUpdate -RepoPath $RepoPath -StateDirectory $StateDirectory -UpstreamRef $UpstreamRef -HealthUrl $HealthUrl -HealthTimeoutSeconds $HealthTimeoutSeconds -CheckOnly:$CheckOnly -RetryFailed:$RetryFailed
        Write-Output $result.Status
        exit $result.ExitCode
    } catch {
        Write-Error $_.Exception.Message
        exit 1
    }
}
