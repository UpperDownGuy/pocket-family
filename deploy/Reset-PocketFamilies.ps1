#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$RepoPath,
    [string]$Confirmation,
    [string]$StateDirectory = (Join-Path $env:ProgramData 'Pocket\Updater'),
    [string]$ResetScript = (Join-Path $PSScriptRoot '..\server\reset-families.mjs'),
    [string]$HealthUrl = 'https://pocket.alexxweb.com/health'
)

# Use the same process runner, volume validation, HTTPS checks and exclusive
# update.lock as the updater. Dot-sourcing never starts an update.
$resetRepoArgument = $RepoPath
$resetStateArgument = $StateDirectory
$resetHealthArgument = $HealthUrl
. (Join-Path $PSScriptRoot 'Update-PocketServer.ps1') -RepoPath $resetRepoArgument -StateDirectory $resetStateArgument -HealthUrl $resetHealthArgument

function Assert-PocketResetPath {
    param([string]$Path, [switch]$Directory)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $item = Get-Item -LiteralPath $full -Force
    if ($Directory -and $item -isnot [IO.DirectoryInfo]) { throw 'Expected a directory for Pocket maintenance.' }
    if (-not $Directory -and $item -is [IO.DirectoryInfo]) { throw 'Expected a regular Pocket maintenance file.' }
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Pocket maintenance paths must not contain symlinks or junctions.' }
        $item = if ($item -is [IO.DirectoryInfo]) { $item.Parent } else { $item.Directory }
    }
    return $full
}

function Invoke-PocketFamilyReset {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$RepoPath,
        [Parameter(Mandatory = $true)][string]$Confirmation,
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$ResetScript,
        [string]$HealthUrl = 'https://pocket.alexxweb.com/health',
        [scriptblock]$Runner = { param($request) Invoke-PocketNativeProcess $request }
    )
    if ($Confirmation -cne 'WIPE-ALL-FAMILIES') { throw 'Pass -Confirmation WIPE-ALL-FAMILIES to reset every family.' }
    $repo = Assert-PocketResetPath $RepoPath -Directory
    $cli = Assert-PocketResetPath $ResetScript
    if ([IO.Path]::GetFileName($cli) -cne 'reset-families.mjs' -or $cli.Contains(',')) { throw 'Use the downloaded server\reset-families.mjs maintenance script.' }
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw 'RepoPath must be the existing live Git checkout.' }
    $healthUri = $null
    if (-not [Uri]::TryCreate($HealthUrl, [UriKind]::Absolute, [ref]$healthUri) -or $healthUri.Scheme -ne 'https' -or $healthUri.UserInfo -or $healthUri.Query -or $healthUri.Fragment) {
        throw 'HealthUrl must be an absolute HTTPS URL without credentials, query or fragment.'
    }
    $stateDir = [IO.Path]::GetFullPath($StateDirectory).TrimEnd('\', '/')
    if ($stateDir -ieq $repo -or $stateDir.StartsWith($repo + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'StateDirectory must be outside the live checkout.' }
    $null = New-Item -ItemType Directory -Path $stateDir -Force
    $stateDir = Assert-PocketResetPath $stateDir -Directory
    $lock = Join-Path $stateDir 'update.lock'
    if (Test-Path -LiteralPath $lock) { $null = Assert-PocketResetPath $lock }
    try { $lease = [IO.File]::Open($lock, 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { return [pscustomobject]@{ ExitCode = 2; Status = 'Another Pocket update or reset is running. Wait for it to finish, then retry.' } }
    $stopped = $false
    $resetAttempted = $false
    $resetCompleted = $false
    $context = $null
    try {
        $files = @((Assert-PocketResetPath (Join-Path $repo 'compose.yaml')))
        $override = Join-Path $repo 'compose.override.yaml'
        if (Test-Path -LiteralPath $override) { $files += Assert-PocketResetPath $override }
        $null = Assert-PocketResetPath (Join-Path $repo 'deploy\backup.ps1')
        $compose = @('compose', '--ansi', 'never', '--project-directory', $repo, '--project-name', 'pocket')
        foreach ($file in $files) { $compose += @('-f', $file) }
        $context = [pscustomobject]@{ RepoPath = $repo; StateDirectory = $stateDir; Runner = $Runner;
            LogPath = Join-Path $stateDir ('reset-' + [DateTime]::UtcNow.ToString('yyyy-MM-dd') + '.log');
            ComposeArguments = $compose; LastPurpose = 'Start'; HealthUrl = $healthUri.AbsoluteUri }
        $origin = (Invoke-PocketCommand $context 'ReadOrigin' 'git.exe' @('-C', $repo, 'remote', 'get-url', 'origin')).Trim()
        if (-not (Test-PocketOrigin $origin)) { throw 'Origin must be the approved UpperDownGuy/pocket-family repository.' }
        $config = Get-PocketComposeConfig $context
        $before = Get-PocketSnapshot $context
        $composeImage = Get-PocketProperty $config.Api 'image' 'pocket-api'
        if ($composeImage -cne $before.ImageReference) { throw 'Compose no longer names the running API image. Nothing was reset.' }
        $capabilities = "fetch('http://127.0.0.1:8787/health',{signal:AbortSignal.timeout(5000)}).then(async r=>{const h=await r.json();if(!r.ok||h.capabilities?.families?.multiple!==true||h.capabilities?.families?.registration!==true)throw Error();console.log('ready');}).catch(()=>process.exit(1))"
        $null = Invoke-PocketCommand $context 'CheckFamilyRegistration' 'docker.exe' @('exec', $before.ApiId, 'node', '-e', $capabilities) 15
        $taggedImage = (Invoke-PocketCommand $context 'InspectResetImage' 'docker.exe' @('image', 'inspect', '--format', '{{.Id}}', $before.ImageReference)).Trim()
        if ($taggedImage -cne $before.ImageId) { throw 'The Compose image tag no longer matches the running API. Nothing was reset.' }
        $null = Invoke-PocketCommand $context 'ValidateNginx' 'docker.exe' @('exec', $before.TlsId, 'nginx', '-t') 30
        $dbPath = (Invoke-PocketCommand $context 'ReadDatabasePath' 'docker.exe' @('exec', $before.ApiId, 'node', '-e', "console.log(require('node:path').resolve(process.env.DB_PATH || './data/pocket.sqlite'))") 20).Trim()
        if ($dbPath -cnotmatch '^/app/data/[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$') { throw 'The API database must be a .sqlite file directly in the verified /app/data volume.' }
        # Check the downloaded CLI using the same image with no data/secrets.
        # The image may predate maintenance tooling; no COPY change is required.
        $mount = 'type=bind,source=' + $cli + ',target=/maintenance/reset-families.mjs,readonly'
        $version = (Invoke-PocketCommand $context 'CheckResetScript' 'docker.exe' @('run', '--rm', '--network', 'none', '--read-only', '--mount', $mount,
            '--entrypoint', 'node', $before.ImageId, '/maintenance/reset-families.mjs', '--version') 30).Trim()
        if ($version -cne 'pocket-family-reset-v1') { throw 'The downloaded reset tool did not pass its version check.' }
        Invoke-PocketBackup $context
        if ((Get-PocketComposeConfig $context).Hash -ne $config.Hash) { throw 'Compose changed during backup. Nothing was reset.' }
        Assert-PocketSnapshot $before (Get-PocketSnapshot $context) $before.ImageId
        $taggedImage = (Invoke-PocketCommand $context 'InspectResetImage' 'docker.exe' @('image', 'inspect', '--format', '{{.Id}}', $before.ImageReference)).Trim()
        if ($taggedImage -cne $before.ImageId) { throw 'The Compose image tag changed during backup. Nothing was reset.' }
        # Set the flag first: even a partially failed stop must not proceed to
        # reset, and the recovery path should try to restore the original API.
        $stopped = $true
        $null = Invoke-PocketCommand $context 'StopApi' 'docker.exe' ($compose + @('stop', '--timeout', '30', 'api')) 60
        $consumers = (Invoke-PocketCommand $context 'CheckDataOffline' 'docker.exe' @('ps', '-q', '--filter', 'volume=pocket-data')).Trim()
        if ($consumers) { throw 'A container still uses pocket-data. No reset was attempted.' }
        $resetAttempted = $true
        $result = ConvertFrom-PocketJSON (Invoke-PocketCommand $context 'ResetFamilies' 'docker.exe' ($compose + @('run', '--rm', '--no-deps', '--pull', 'never',
            '--volume', ($cli + ':/maintenance/reset-families.mjs:ro'), '--entrypoint', 'node', 'api', '/maintenance/reset-families.mjs',
            '--db-path', $dbPath, '--confirm', 'WIPE-ALL-FAMILIES')) 600) 'family reset result'
        if ((Get-PocketProperty $result 'status' '') -notin @('reset', 'already-empty')) { throw 'The reset tool did not report completion.' }
        $resetCompleted = $true
        $null = Invoke-PocketCommand $context 'StartApi' 'docker.exe' ($compose + @('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'api')) 120
        # An empty database is the explicit purpose of this operation. Preserve
        # the usual mount/image/TLS checks while allowing that one state change.
        $expected = [pscustomobject]@{ Mounts = $before.Mounts; TlsId = $before.TlsId; TlsVolume = $before.TlsVolume; SetupRequired = $true }
        $after = Wait-PocketSnapshot $context $expected $before.ImageId 90
        Assert-PocketSnapshot $expected $after $before.ImageId
        if (-not $after.SetupRequired) { throw 'The API still reports a configured family after reset.' }
        Update-PocketProxyRouting $context $expected 90
        if (-not (Get-PocketHTTPSHealth $context).setupRequired) { throw 'HTTPS still reports a configured family after reset.' }
        $backupPath = Get-PocketProperty $result 'backupPath' ''
        Write-PocketLog $context ('All families reset. Offline backup: ' + $backupPath)
        return [pscustomobject]@{ ExitCode = 0; Status = ('All families were reset. Pocket is healthy. Offline backup in pocket-data: ' + $backupPath); BackupPath = $backupPath }
    } catch {
        if ($null -ne $context) { Write-PocketLog $context ('Reset stopped at ' + $context.LastPurpose + '.') }
        if ($stopped -and -not $resetAttempted) {
            try {
                $null = Invoke-PocketCommand $context 'RecoverApi' 'docker.exe' ($context.ComposeArguments + @('up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90', 'api')) 120
                Update-PocketProxyRouting $context $before 90
            } catch { throw 'No reset was attempted, but restarting the API failed. Inspect the server before retrying.' }
        }
        if ($resetAttempted -and -not $resetCompleted) { throw 'The offline reset did not report completion. The API remains stopped; inspect its protected backup before restarting. No automatic restore was attempted.' }
        if ($resetCompleted) { throw 'All families were reset and backed up, but the API/HTTPS recovery check failed. Inspect the server; do not repeat the wipe to fix startup.' }
        throw
    } finally { $lease.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ([string]::IsNullOrWhiteSpace($resetRepoArgument)) { throw 'Pass -RepoPath with the existing live Pocket checkout.' }
        $result = Invoke-PocketFamilyReset -RepoPath $resetRepoArgument -Confirmation $Confirmation -StateDirectory $resetStateArgument -ResetScript $ResetScript -HealthUrl $resetHealthArgument
        Write-Output $result.Status
        exit $result.ExitCode
    } catch { Write-Error $_.Exception.Message; exit 1 }
}
