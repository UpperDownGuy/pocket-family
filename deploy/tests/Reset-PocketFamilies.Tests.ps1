#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Reset-PocketFamilies.ps1')

$script:Passed = 0
$script:Fixture = $null
function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Equal { param($Actual, $Expected, [string]$Message) if ($Actual -cne $Expected) { throw ($Message + ": expected '$Expected', got '$Actual'.") } }
function New-Fixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('Pocket reset test ' + [Guid]::NewGuid().ToString('N'))
    $repo = Join-Path $root 'live checkout'
    $state = Join-Path $root 'state'
    foreach ($path in @($repo, (Join-Path $repo '.git'), (Join-Path $repo 'deploy'), (Join-Path $repo 'server'), $state)) { $null = New-Item -ItemType Directory -Path $path -Force }
    foreach ($name in @('compose.yaml', 'compose.override.yaml', 'deploy\backup.ps1', 'server\reset-families.mjs')) { Set-Content -LiteralPath (Join-Path $repo $name) -Value '# fixture' }
    return [pscustomobject]@{ Root=$root; Repo=$repo; State=$state; Cli=(Join-Path $repo 'server\reset-families.mjs'); Mode='normal';
        Calls=(New-Object 'System.Collections.Generic.List[object]'); Stopped=$false; Reset=$false; Image=('sha256:' + ('a' * 64)) }
}
function Invoke-FakeResetCommand {
    param($Request)
    $f = $script:Fixture
    $f.Calls.Add($Request)
    $out = ''
    $code = 0
    switch ($Request.Purpose) {
        'ReadOrigin' { $out = 'https://github.com/UpperDownGuy/pocket-family.git' }
        'ReadComposeConfig' { $out = ConvertTo-Json @{services=@{api=@{image=$(if ($f.Mode -eq 'retargeted-compose') {'other-image'} else {'pocket-api'});build=@{context=(Join-Path $f.Repo 'server')};
            volumes=@(@{type='volume';source='data';target='/app/data'})}};volumes=@{data=@{name=$(if ($f.Mode -eq 'wrong-volume') {'wrong-data'} else {'pocket-data'})}}} -Depth 10 }
        'FindApiContainer' { $out = 'e' * 64 }
        'InspectApi' { $out = ConvertTo-Json -InputObject @(@{Image=$f.Image;Config=@{Image='pocket-api';Labels=@{
            'com.docker.compose.project'='pocket';'com.docker.compose.service'='api';'com.docker.compose.project.working_dir'=$f.Repo}};
            State=@{Running=(-not $f.Stopped)};Mounts=@(@{Type='volume';Name='pocket-data';Source='/var/lib/docker/volumes/pocket-data/_data';Destination='/app/data';RW=$true})}) -Depth 10 }
        'InspectTlsVolume' { $out = ConvertTo-Json -InputObject @(@{Name='pocket-tls';Driver='local';Mountpoint='/var/lib/docker/volumes/pocket-tls/_data'}) }
        'FindTlsContainer' { $out = 'c' * 64 }
        'CheckApiHealth' { $out = ConvertTo-Json @{setupRequired=$f.Reset} }
        'CheckFamilyRegistration' { if ($f.Mode -eq 'old-api') { $code = 1 } }
        'InspectResetImage' { $out = if ($f.Mode -eq 'changed-image') { 'sha256:' + ('b' * 64) } else { $f.Image } }
        'ReadDatabasePath' { $out = if ($f.Mode -eq 'wrong-db') { '/other/secret.sqlite' } else { '/app/data/pocket.sqlite' } }
        'CheckResetScript' {
            Assert-True ($Request.Arguments -contains '--read-only') 'CLI preflight must not write the container'
            Assert-True ($Request.Arguments -contains 'none') 'CLI preflight must have no network'
            Assert-True (($Request.Arguments -join ' ').Contains('readonly')) 'CLI bind must be read-only'
            Assert-True (-not (($Request.Arguments -join ' ').Contains('pocket-data'))) 'CLI preflight must not mount data'
            $out = if ($f.Mode -eq 'old-script') { 'wrong-version' } else { 'pocket-family-reset-v1' }
        }
        'Backup' { if ($f.Mode -eq 'backup-failure') { $code = 1 } }
        'StopApi' { $f.Stopped=$true; if ($f.Mode -eq 'stop-failure') { $code = 1 } }
        'CheckDataOffline' { if ($f.Mode -eq 'consumer-running') { $out = 'd' * 64 } }
        'ResetFamilies' {
            Assert-True $f.Stopped 'API must be stopped before reset'
            $args = $Request.Arguments
            Assert-True ($args -contains '--no-deps') 'Reset must not start dependencies'
            Assert-True ($args -contains '--rm') 'Maintenance container must be disposable'
            Assert-Equal $args[[array]::IndexOf($args, '--confirm') + 1] 'WIPE-ALL-FAMILIES' 'Confirmation missing'
            Assert-Equal $args[[array]::IndexOf($args, '--db-path') + 1] '/app/data/pocket.sqlite' 'Wrong data target'
            Assert-Equal $args[[array]::IndexOf($args, '--volume') + 1] ($f.Cli + ':/maintenance/reset-families.mjs:ro') 'Wrong read-only maintenance mount'
            if ($f.Mode -eq 'reset-failure') { $code = 1 } else { $f.Reset=$true; $out=ConvertTo-Json @{status='reset';backupPath='/app/data/.pocket-family-reset-test';removedFiles=3} }
        }
        'StartApi' { $f.Stopped=$false; if ($f.Mode -eq 'startup-failure') { $code = 1 } }
        'RecoverApi' { $f.Stopped=$false }
        'ValidateNginx' { Assert-Equal $Request.Arguments[1] ('c' * 64) 'Must keep original HTTPS container' }
        'ReloadNginx' { Assert-Equal $Request.Arguments[1] ('c' * 64) 'Must reload original HTTPS container' }
        'CheckHTTPSHealth' { $out=ConvertTo-Json @{setupRequired=$f.Reset} }
        default { throw ('Unexpected process: ' + $Request.Purpose) }
    }
    return [pscustomobject]@{ExitCode=$code;StdOut=$out;StdErr=''}
}
function Invoke-TestReset {
    $f=$script:Fixture
    return Invoke-PocketFamilyReset -RepoPath $f.Repo -Confirmation 'WIPE-ALL-FAMILIES' -StateDirectory $f.State -ResetScript $f.Cli -Runner ${function:Invoke-FakeResetCommand}
}
function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    $script:Fixture=New-Fixture
    try { & $Body; $script:Passed++; Write-Output ('PASS ' + $Name) }
    finally {
        $root=[IO.Path]::GetFullPath($script:Fixture.Root)
        $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $root.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or -not [IO.Path]::GetFileName($root).StartsWith('Pocket reset test ')) { throw 'Unsafe fixture cleanup target.' }
        Remove-Item -LiteralPath $root -Recurse -Force
    }
}

Test-Case 'backs up, stops, verifies offline, resets, restarts and checks HTTPS in order' {
    $result=Invoke-TestReset
    Assert-Equal $result.ExitCode 0 'Reset failed'
    $names=@($script:Fixture.Calls | ForEach-Object {$_.Purpose})
    foreach ($pair in @(@('Backup','StopApi'),@('StopApi','CheckDataOffline'),@('CheckDataOffline','ResetFamilies'),@('ResetFamilies','StartApi'),@('StartApi','ReloadNginx'))) {
        Assert-True ([array]::IndexOf($names,$pair[0]) -lt [array]::IndexOf($names,$pair[1])) ('Wrong order: ' + ($pair -join ', '))
    }
    foreach ($call in $script:Fixture.Calls) {
        Assert-True (-not ($call.Arguments -contains 'down')) 'Never run compose down'
        Assert-True (-not ($call.Arguments -contains '-v')) 'Never remove volumes'
        Assert-True (-not ($call.Arguments -contains 'prune')) 'Never prune Docker data'
    }
}
Test-Case 'wrong confirmation performs no external action' {
    $f=$script:Fixture
    try { $null=Invoke-PocketFamilyReset -RepoPath $f.Repo -Confirmation 'wipe-all-families' -StateDirectory $f.State -ResetScript $f.Cli -Runner ${function:Invoke-FakeResetCommand}; throw 'Expected refusal' }
    catch { Assert-True $_.Exception.Message.Contains('WIPE-ALL-FAMILIES') 'Wrong refusal' }
    Assert-Equal $f.Calls.Count 0 'Must not invoke any process'
}
Test-Case 'existing updater lock blocks reset before Docker calls' {
    $lease=[IO.File]::Open((Join-Path $script:Fixture.State 'update.lock'),'OpenOrCreate','ReadWrite','None')
    try { Assert-Equal (Invoke-TestReset).ExitCode 2 'Must respect updater lock' }
    finally { $lease.Dispose() }
    Assert-Equal $script:Fixture.Calls.Count 0 'Must not invoke processes under another lease'
}
foreach ($mode in @('wrong-volume','wrong-db','old-script','old-api','changed-image','retargeted-compose','backup-failure')) {
    Test-Case ($mode + ' cannot stop or reset the API') {
        $script:Fixture.Mode=$mode
        $failed=$false
        try { $null=Invoke-TestReset } catch { $failed=$true }
        Assert-True $failed 'Expected failure'
        Assert-True (-not $script:Fixture.Stopped) 'API should still run'
        Assert-True (-not (@($script:Fixture.Calls | ForEach-Object {$_.Purpose}) -contains 'ResetFamilies')) 'Reset must not run'
    }
}
foreach ($mode in @('stop-failure','consumer-running')) {
    Test-Case ($mode + ' recovers API without resetting') {
        $script:Fixture.Mode=$mode
        $failed=$false
        try { $null=Invoke-TestReset } catch { $failed=$true }
        Assert-True $failed 'Expected failure'
        Assert-True (-not $script:Fixture.Reset) 'No reset allowed'
        Assert-True (-not $script:Fixture.Stopped) 'Original API should be restored'
    }
}
Test-Case 'uncertain reset failure keeps API stopped for manual backup inspection' {
    $script:Fixture.Mode='reset-failure'
    try { $null=Invoke-TestReset; throw 'Expected refusal' } catch { Assert-True $_.Exception.Message.Contains('remains stopped') 'Wrong recovery guidance' }
    Assert-True $script:Fixture.Stopped 'Never reopen possibly partial databases'
}
Test-Case 'post-reset startup failure distinguishes completed wipe from health failure' {
    $script:Fixture.Mode='startup-failure'
    try { $null=Invoke-TestReset; throw 'Expected refusal' } catch { Assert-True $_.Exception.Message.Contains('do not repeat') 'Wrong recovery guidance' }
    Assert-True $script:Fixture.Reset 'Fixture should have completed reset'
}
Write-Output ('Passed ' + $script:Passed + ' Pocket reset workflow tests.')
