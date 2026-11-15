#requires -Version 5.1
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Update-PocketServer.ps1')

# Self-contained integration harness: Git, Docker and the backup subprocess are
# mocked at the process boundary. It never connects to a server or Docker daemon.
$script:Passed = 0
$script:Fixture = $null

function Assert-True { param([bool]$Condition, [string]$Message) if (-not $Condition) { throw $Message } }
function Assert-Equal { param($Actual, $Expected, [string]$Message) if ($Actual -cne $Expected) { throw ($Message + ": expected '$Expected', got '$Actual'.") } }

function New-Fixture {
    $root = Join-Path ([IO.Path]::GetTempPath()) ('Pocket updater test ' + [Guid]::NewGuid().ToString('N'))
    $repo = Join-Path $root 'live checkout'
    $state = Join-Path $root 'private updater'
    foreach ($path in @($repo, (Join-Path $repo '.git'), (Join-Path $repo 'server'), (Join-Path $repo 'deploy'), $state)) { $null = New-Item -ItemType Directory -Path $path -Force }
    Set-Content -LiteralPath (Join-Path $repo 'compose.yaml') -Value 'services: {}'
    Set-Content -LiteralPath (Join-Path $repo 'compose.override.yaml') -Value 'services: {}'
    Set-Content -LiteralPath (Join-Path $repo 'deploy\backup.ps1') -Value 'exit 0'
    Set-Content -LiteralPath (Join-Path $repo '.env') -Value 'PRIVATE_KEY=do-not-copy-or-log-this-secret'
    return [pscustomobject]@{
        Root = $root; Repo = $repo; State = $state; Mode = 'normal'; Calls = (New-Object 'System.Collections.Generic.List[object]');
        LiveHead = ('1' * 40); RemoteHead = ('2' * 40); MergedHead = ('3' * 40); LiveTree = ('4' * 40); Tree = ('5' * 40);
        OldImage = ('sha256:' + ('a' * 64)); NewImage = ('sha256:' + ('b' * 64)); CurrentImage = ('sha256:' + ('a' * 64));
        TaggedImage = ('sha256:' + ('a' * 64)); Activated = $false; SetupRequired = $false; HealthAttempts = 0; ProxyAttempts = 0; Candidate = ''; Origin = 'https://github.com/UpperDownGuy/pocket-family.git'
    }
}

function Invoke-FakeCommand {
    param($Request)
    $f = $script:Fixture
    $f.Calls.Add($Request)
    $out = ''
    $exitCode = 0
    switch ($Request.Purpose) {
        'CheckUpstreamRef' { }
        'ReadOrigin' { $out = $f.Origin }
        'ReadLiveHead' { $out = $f.LiveHead }
        'ReadTrackedStatus' { if ($f.Mode -eq 'dirty') { $out = ' M server/index.mjs' } }
        'ReadUntrackedServer' { if ($f.Mode -eq 'untracked') { $out = 'server/Dockerfile' } }
        'ReadComposeConfig' {
            $name = if ($f.Mode -eq 'wrong-volume') { 'other-data' } else { 'pocket-data' }
            $out = ConvertTo-Json @{ services = @{ api = @{ image = 'pocket-api'; build = @{ context = (Join-Path $f.Repo 'server'); dockerfile = 'Dockerfile' };
                environment = @{ PRIVATE_KEY = 'do-not-copy-or-log-this-secret' }; volumes = @(@{type='volume';source='data';target='/app/data'}) } };
                volumes = @{ data = @{ name = $name } } } -Depth 10
        }
        'FindApiContainer' { $out = 'e' * 64 }
        'InspectApi' {
            $mountName = if ($f.Mode -eq 'changed-mount' -and $f.Activated) { 'wrong-data' } else { 'pocket-data' }
            $out = ConvertTo-Json -InputObject @(@{ Image = $f.CurrentImage; Config = @{ Image = 'pocket-api'; Labels = @{
                'com.docker.compose.project' = 'pocket'; 'com.docker.compose.service' = 'api'; 'com.docker.compose.project.working_dir' = $f.Repo } };
                State = @{Running=$true}; Mounts = @(@{Type='volume';Name=$mountName;Source='/var/lib/docker/volumes/pocket-data/_data';Destination='/app/data';RW=$true;Propagation=''}) }) -Depth 10
        }
        'InspectTlsVolume' { $out = ConvertTo-Json -InputObject @(@{Name='pocket-tls';Driver='local';Mountpoint='/var/lib/docker/volumes/pocket-tls/_data'}) }
        'FindTlsContainer' { $out = 'c' * 64 }
        'CheckApiHealth' {
            if ($f.Activated) { $f.HealthAttempts++ }
            if ($f.Mode -eq 'health-failure' -and $f.Activated) { $exitCode = 1 }
            if ($f.Mode -eq 'health-starting' -and $f.Activated -and $f.HealthAttempts -lt 3) { $exitCode = 1 }
            $setup = $f.SetupRequired -or ($f.Mode -eq 'empty-database' -and $f.Activated)
            $out = ConvertTo-Json @{setupRequired=$setup}
        }
        'ValidateNginx' {
            Assert-Equal $Request.Arguments[1] ('c' * 64) 'nginx validation must use the original TLS container'
            if ($f.Mode -eq 'nginx-invalid') { $exitCode = 1 }
        }
        'ReloadNginx' {
            Assert-Equal $Request.Arguments[1] ('c' * 64) 'nginx reload must use the original TLS container'
            if ($f.Mode -eq 'reload-failure' -and $f.Activated) { $exitCode = 1 }
        }
        'CheckHTTPSHealth' {
            if ($f.Activated) { $f.ProxyAttempts++ }
            if ($f.Mode -eq 'proxy-failure' -and $f.Activated) { $exitCode = 1 }
            if ($f.Mode -eq 'proxy-starting' -and $f.Activated -and $f.ProxyAttempts -lt 3) { $exitCode = 1 }
            $command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Request.Arguments[-1]))
            Assert-True ($command.Contains('https://pocket.alexxweb.com/health')) 'Wrong HTTPS probe URL'
            Assert-True ($command.Contains('$request.AllowAutoRedirect = $false')) 'HTTPS probe must reject redirects'
            Assert-True ($command.Contains('$request.UseDefaultCredentials = $false')) 'HTTPS probe must not send Windows credentials'
            Assert-True (-not $command.Contains('ServerCertificateValidationCallback')) 'HTTPS probe must retain certificate validation'
            $setup = $f.SetupRequired -or ($f.Mode -eq 'proxy-empty-database' -and $f.Activated)
            $out = ConvertTo-Json @{setupRequired=$setup}
        }
        'CheckRemoteHead' { $out = $f.RemoteHead + "`trefs/heads/main" }
        'CloneCandidate' {
            $f.Candidate = $Request.Arguments[-1]
            $null = New-Item -ItemType Directory -Path (Join-Path $f.Candidate 'server\tests') -Force
            Set-Content -LiteralPath (Join-Path $f.Candidate 'server\Dockerfile') -Value 'FROM node:22'
            Set-Content -LiteralPath (Join-Path $f.Candidate 'server\tests\server.test.mjs') -Value '// Test fixture only.'
            Assert-True (-not (Test-Path (Join-Path $f.Candidate '.env'))) 'Live secret copied into candidate.'
        }
        'CheckoutCandidate' { }
        'ConfigureCandidateOrigin' { }
        'FetchUpstream' { if ($f.Mode -eq 'fetch-failure') { $exitCode = 1 } }
        'ReadUpstreamCommit' { $out = $f.RemoteHead }
        'MergeCandidate' { if ($f.Mode -eq 'conflict') { $exitCode = 1 } }
        'ReadMergedCommit' { $out = $f.MergedHead }
        'ReadCandidateTree' { $out = $f.Tree }
        'ReadLiveTree' { $out = $f.LiveTree }
        'Backup' { if ($f.Mode -eq 'backup-failure') { $exitCode = 1 } }
        'BuildCandidate' {
            $override = @($Request.Arguments | Where-Object { $_ -like '*candidate-build.json' })[0]
            $config = Get-Content -Raw -LiteralPath $override | ConvertFrom-Json
            Assert-Equal $config.services.api.build.context (Join-Path $f.Candidate 'server') 'Build must use isolated merged source'
            Assert-True (-not ((Get-Content -Raw -LiteralPath $override).Contains('do-not-copy'))) 'Compose secrets were persisted'
            if ($f.Mode -eq 'build-failure') { $exitCode = 1 }
        }
        'InspectCandidateImage' { $out = $f.NewImage }
        'TestCandidate' {
            $args = $Request.Arguments
            Assert-Equal $args[[array]::IndexOf($args, '--network') + 1] 'none' 'Candidate tests need no network'
            Assert-True ($args -contains '--read-only') 'Test container filesystem must be read-only'
            Assert-True (-not (($args -join ' ').Contains('pocket-data'))) 'Tests must not mount live data'
            Assert-True (-not (($args -join ' ').Contains('pocket-tls'))) 'Tests must not mount TLS data'
            Assert-True (-not ($args -contains '--env-file')) 'Tests must not read live environment files'
            if ($f.Mode -eq 'tests-failure') { $exitCode = 1 }
        }
        'TagCandidateActive' { $f.TaggedImage = $f.NewImage }
        'ActivateCandidate' {
            $f.CurrentImage = $f.TaggedImage
            $f.Activated = $true
            Assert-True (-not (($Request.Arguments -join ' ').Contains('candidate-build.json'))) 'Activation must use original Compose files'
            Assert-Equal $Request.Arguments[-1] 'api' 'Only API service may be recreated'
            Assert-True ($Request.Arguments -contains '--no-deps') 'HTTPS must not be recreated'
            Assert-True ($Request.Arguments -contains '--no-build') 'Activation must not build again'
            if ($f.Mode -eq 'activate-failure') { $exitCode = 1 }
        }
        'TagPreviousActive' { $f.TaggedImage = $Request.Arguments[2] }
        'RollbackApi' { $f.CurrentImage = $f.TaggedImage; $f.Activated = $false; if ($f.Mode -eq 'rollback-failure') { $exitCode = 1 } }
        default { throw ('Unexpected mocked command: ' + $Request.Purpose) }
    }
    return [pscustomobject]@{ ExitCode=$exitCode; StdOut=$out; StdErr='private command output must not appear in logs' }
}

function Run-Update {
    param([switch]$CheckOnly, [switch]$RetryFailed, [switch]$ForceRebuild)
    return Invoke-PocketUpdate -RepoPath $script:Fixture.Repo -StateDirectory $script:Fixture.State -HealthTimeoutSeconds 1 -CheckOnly:$CheckOnly -RetryFailed:$RetryFailed -ForceRebuild:$ForceRebuild -Runner { param($request) Invoke-FakeCommand $request }
}
function Command-Count { param([string]$Purpose) return @($script:Fixture.Calls | Where-Object Purpose -eq $Purpose).Count }
function Expect-Failure {
    param([scriptblock]$Action, [string]$Pattern)
    $failed = $false
    try { & $Action | Out-Null } catch { $failed = $true; Assert-True ($_.Exception.Message -match $Pattern) ('Unexpected failure: ' + $_.Exception.Message) }
    Assert-True $failed 'Expected the update to stop.'
}
function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    $script:Fixture = New-Fixture
    try {
        & $Body
        Assert-True ((Get-Content -Raw -LiteralPath (Join-Path $script:Fixture.Repo '.env')).Contains('do-not-copy')) 'Live configuration was modified'
        foreach ($file in @(Get-ChildItem -LiteralPath $script:Fixture.State -Recurse -File)) {
            if ($file.Extension -in @('.log', '.json')) {
                $contents = Get-Content -Raw -LiteralPath $file.FullName
                Assert-True (-not $contents.Contains('do-not-copy-or-log-this-secret')) 'Secret leaked to updater storage'
                Assert-True (-not $contents.Contains('private command output')) 'CLI output leaked to updater storage'
            }
        }
        foreach ($command in $script:Fixture.Calls) {
            Assert-True (-not ($command.Arguments -contains 'reset')) 'Live reset is forbidden'
            Assert-True (-not ($command.Arguments -contains 'rebase')) 'Live rebase is forbidden'
            Assert-True (-not ($command.Arguments -contains 'down')) 'Compose down is forbidden'
            if ($command.Purpose -eq 'MergeCandidate') { Assert-True ($command.Arguments[1] -ne $script:Fixture.Repo) 'Merge must not touch live checkout' }
        }
        $script:Passed++
        Write-Output ('PASS ' + $Name)
    } finally {
        $path = [IO.Path]::GetFullPath($script:Fixture.Root)
        $expectedRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\Pocket updater test '
        if (-not $path.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
        Remove-Item -LiteralPath $path -Recurse -Force
    }
}

Test-Case 'successful update backs up, builds and tests before touching active tag; records success only after health' {
    $result = Run-Update
    Assert-Equal $result.ExitCode 0 'Update failed'
    $purposes = @($script:Fixture.Calls | ForEach-Object Purpose)
    foreach ($pair in @(@('Backup','BuildCandidate'), @('BuildCandidate','TestCandidate'), @('TestCandidate','TagCandidateActive'), @('TagCandidateActive','ActivateCandidate'))) {
        Assert-True ([array]::IndexOf($purposes,$pair[0]) -lt [array]::IndexOf($purposes,$pair[1])) 'Update operation order is unsafe'
    }
    Assert-True ([array]::IndexOf($purposes,'ValidateNginx') -lt [array]::IndexOf($purposes,'Backup')) 'Proxy preflight must precede deployment changes'
    Assert-True ([array]::IndexOf($purposes,'CheckHTTPSHealth') -lt [array]::IndexOf($purposes,'Backup')) 'HTTPS preflight must precede deployment changes'
    Assert-True ([array]::IndexOf($purposes,'ActivateCandidate') -lt [array]::IndexOf($purposes,'ReloadNginx')) 'Proxy must reload after API activation'
    Assert-Equal (Command-Count 'ReloadNginx') 1 'Successful update must refresh existing proxy routing'
    Assert-True (('CheckHTTPSHealth') -eq $purposes[-1]) 'Success must follow external HTTPS verification'
    Assert-Equal (Command-Count 'RollbackApi') 0 'Successful update unexpectedly rolled back'
    $saved = Get-Content -Raw -LiteralPath (Join-Path $script:Fixture.State 'last-success.json') | ConvertFrom-Json
    Assert-Equal $saved.ImageId $script:Fixture.NewImage 'Wrong image recorded'
    Assert-Equal $saved.UpstreamCommit $script:Fixture.RemoteHead 'Wrong upstream recorded'
    Assert-Equal $saved.MergedCommit $script:Fixture.MergedHead 'Local commits were not merged'
    Assert-True (-not (Test-Path $script:Fixture.Candidate)) 'Isolated candidate cleanup failed'
}

Test-Case 'one-minute repeated checks skip clone and build when source and active image are unchanged' {
    $null = Run-Update
    $script:Fixture.Calls.Clear()
    $result = Run-Update
    Assert-Equal $result.Status 'Already up to date.' 'Expected fast no-op'
    Assert-Equal (Command-Count 'CloneCandidate') 0 'Unchanged source was cloned'
    Assert-Equal (Command-Count 'Backup') 0 'No-op ran backup'
    Assert-Equal (Command-Count 'BuildCandidate') 0 'No-op rebuilt image'
}

Test-Case 'a second successful release atomically replaces its saved deployment marker without rollback' {
    $null = Run-Update
    $previousImage = $script:Fixture.CurrentImage
    $script:Fixture.RemoteHead = '6' * 40
    $script:Fixture.Tree = '7' * 40
    $script:Fixture.NewImage = 'sha256:' + ('d' * 64)
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update).Status 'Pocket API updated and healthy.' 'Replacing an existing success marker failed'
    Assert-Equal (Command-Count 'RollbackApi') 0 'Successful second release rolled back during state replacement'
    $saved = Get-Content -Raw -LiteralPath (Join-Path $script:Fixture.State 'last-success.json') | ConvertFrom-Json
    Assert-Equal $saved.ImageId $script:Fixture.NewImage 'Second release image was not saved'
    Assert-Equal $saved.UpstreamCommit $script:Fixture.RemoteHead 'Second release revision was not saved'
    Assert-Equal $saved.ServerTree $script:Fixture.Tree 'Second release source tree was not saved'
    Assert-Equal $saved.PreviousImageId $previousImage 'Second release lost its rollback image identity'
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update).Status 'Already up to date.' 'Second release was not recognized on the next check'
    Assert-Equal (Command-Count 'BuildCandidate') 0 'Verified second release rebuilt unnecessarily'
}

Test-Case 'mobile-only upstream changes do not back up, build, deploy or advance success' {
    $null = Run-Update
    $successPath = Join-Path $script:Fixture.State 'last-success.json'
    $previousState = Get-Content -Raw -LiteralPath $successPath
    $script:Fixture.RemoteHead = '6' * 40
    $script:Fixture.Calls.Clear()
    $result = Run-Update
    Assert-Equal $result.Status 'No server changes.' 'Mobile-only changes triggered a deployment'
    Assert-Equal (Command-Count 'Backup') 0 'Mobile-only changes ran backup'
    Assert-Equal (Command-Count 'BuildCandidate') 0 'Mobile-only changes rebuilt image'
    Assert-Equal (Get-Content -Raw -LiteralPath $successPath) $previousState 'No-op advanced successful deployment state'
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update).Status 'Already checked; no server changes.' 'No-change check cache not reused'
    Assert-Equal (Command-Count 'CloneCandidate') 0 'Mobile-only revision was cloned again'
}

Test-Case 'first run rebuilds an unmanaged image even when the live checkout already contains latest server source' {
    $script:Fixture.Tree = $script:Fixture.LiveTree
    $script:Fixture.RemoteHead = $script:Fixture.LiveHead
    $result = Run-Update
    Assert-Equal $result.Status 'Pocket API updated and healthy.' 'Latest checkout was incorrectly treated as a current image'
    foreach ($purpose in @('Backup','BuildCandidate','TestCandidate','ActivateCandidate')) {
        Assert-Equal (Command-Count $purpose) 1 'First run skipped a required verified deployment stage'
    }
    $saved = Get-Content -Raw -LiteralPath (Join-Path $script:Fixture.State 'last-success.json') | ConvertFrom-Json
    Assert-Equal $saved.ImageId $script:Fixture.NewImage 'Unmanaged image was recorded as deployed'
    Assert-Equal $saved.ServerTree $script:Fixture.Tree 'Successful state did not record the actual candidate tree'
    Assert-Equal $saved.PreviousImageId $script:Fixture.OldImage 'Rollback image identity was lost'
}

Test-Case 'legacy no-change cache without successful image provenance cannot suppress the initial build' {
    $script:Fixture.Tree = $script:Fixture.LiveTree
    $script:Fixture.RemoteHead = $script:Fixture.LiveHead
    $config = Invoke-FakeCommand ([pscustomobject]@{Purpose='ReadComposeConfig';Arguments=@()})
    Write-PocketJSONFile (Join-Path $script:Fixture.State 'last-check.json') ([ordered]@{
        RemoteHead=$script:Fixture.RemoteHead; LiveHead=$script:Fixture.LiveHead;
        ImageId=$script:Fixture.CurrentImage; ConfigHash=(Get-PocketHash $config.StdOut); ServerTree=$script:Fixture.Tree
    })
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update).Status 'Pocket API updated and healthy.' 'Old no-change cache hid the stale image'
    Assert-Equal (Command-Count 'CloneCandidate') 1 'First run trusted a source-only cache'
    Assert-Equal (Command-Count 'BuildCandidate') 1 'First run skipped image build'
}

Test-Case 'ForceRebuild rebuilds the same successful revision and records the new candidate identity' {
    $null = Run-Update
    $previousImage = $script:Fixture.NewImage
    $script:Fixture.NewImage = 'sha256:' + ('d' * 64)
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update -ForceRebuild).Status 'Pocket API updated and healthy.' 'ForceRebuild was skipped by the successful revision cache'
    foreach ($purpose in @('Backup','BuildCandidate','TestCandidate','ActivateCandidate')) {
        Assert-Equal (Command-Count $purpose) 1 'ForceRebuild skipped a required deployment check'
    }
    $saved = Get-Content -Raw -LiteralPath (Join-Path $script:Fixture.State 'last-success.json') | ConvertFrom-Json
    Assert-Equal $saved.ImageId $script:Fixture.NewImage 'Rebuilt image identity was not persisted'
    Assert-Equal $saved.PreviousImageId $previousImage 'Rebuild did not preserve the previous image for rollback'
}

Test-Case 'ForceRebuild bypasses a managed no-change cache and equal server tree' {
    $null = Run-Update
    $script:Fixture.RemoteHead = '6' * 40
    Assert-Equal (Run-Update).Status 'No server changes.' 'Expected source-only no-op before manual rebuild'
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update -ForceRebuild).Status 'Pocket API updated and healthy.' 'No-change cache suppressed manual rebuild'
    Assert-Equal (Command-Count 'BuildCandidate') 1 'Equal tree suppressed manual rebuild'
}

Test-Case 'ForceRebuild bypasses failed-revision backoff while preserving backup and tests' {
    $script:Fixture.Mode = 'build-failure'
    Expect-Failure { Run-Update } 'BuildCandidate failed'
    $script:Fixture.Mode = 'normal'
    $script:Fixture.Calls.Clear()
    Assert-Equal (Run-Update -ForceRebuild).Status 'Pocket API updated and healthy.' 'Failure backoff suppressed manual rebuild'
    Assert-Equal (Command-Count 'Backup') 1 'Manual rebuild skipped backup'
    Assert-Equal (Command-Count 'TestCandidate') 1 'Manual rebuild skipped candidate tests'
}

foreach ($mode in @('dirty','wrong-volume','backup-failure')) {
    Test-Case ('ForceRebuild retains protection against ' + $mode) {
        $script:Fixture.Mode = $mode
        Expect-Failure { Run-Update -ForceRebuild } '.'
        Assert-Equal (Command-Count 'BuildCandidate') 0 'Manual rebuild bypassed a required safety check'
        Assert-Equal (Command-Count 'TagCandidateActive') 0 'Manual rebuild changed active image after failed check'
    }
}

Test-Case 'CheckOnly with ForceRebuild still performs no deployment' {
    $script:Fixture.Tree = $script:Fixture.LiveTree
    $result = Run-Update -CheckOnly -ForceRebuild
    Assert-Equal $result.ExitCode 0 'Manual rebuild preview failed'
    foreach ($purpose in @('Backup','BuildCandidate','TagCandidateActive','ActivateCandidate')) {
        Assert-Equal (Command-Count $purpose) 0 'CheckOnly plus ForceRebuild changed deployment'
    }
}

Test-Case 'CheckOnly validates an isolated merge without backup, build, tagging or activation' {
    $result = Run-Update -CheckOnly
    Assert-Equal $result.ExitCode 0 'CheckOnly failed'
    Assert-Equal (Command-Count 'MergeCandidate') 1 'CheckOnly did not check merge'
    foreach ($purpose in @('Backup','BuildCandidate','TagCandidateActive','ActivateCandidate')) { Assert-Equal (Command-Count $purpose) 0 'CheckOnly mutated deployment' }
    Assert-True (-not (Test-Path (Join-Path $script:Fixture.State 'last-success.json'))) 'CheckOnly wrote deployment state'
}

foreach ($mode in @('dirty','untracked','conflict','fetch-failure','wrong-volume','nginx-invalid')) {
    Test-Case ($mode + ' stops before backup or live mutations') {
        $script:Fixture.Mode = $mode
        Expect-Failure { Run-Update } '.'
        Assert-Equal (Command-Count 'Backup') 0 'Unsafe preflight reached backup'
        Assert-Equal (Command-Count 'BuildCandidate') 0 'Unsafe preflight reached build'
        Assert-Equal (Command-Count 'TagCandidateActive') 0 'Unsafe preflight changed active image'
    }
}

foreach ($mode in @('backup-failure','build-failure','tests-failure')) {
    Test-Case ($mode + ' never activates or advances success') {
        $script:Fixture.Mode = $mode
        Expect-Failure { Run-Update } 'failed'
        if ($mode -eq 'backup-failure') { Assert-Equal (Command-Count 'BuildCandidate') 0 'Backup failure did not stop build' }
        Assert-Equal (Command-Count 'TagCandidateActive') 0 'Failed validation changed active image'
        Assert-Equal $script:Fixture.CurrentImage $script:Fixture.OldImage 'Failed validation changed running image'
        Assert-True (-not (Test-Path (Join-Path $script:Fixture.State 'last-success.json'))) 'Failure recorded as success'
    }
}

foreach ($mode in @('activate-failure','health-failure','empty-database','changed-mount','proxy-failure','proxy-empty-database','reload-failure')) {
    Test-Case ($mode + ' restores old image and retains volumes and success state') {
        $script:Fixture.Mode = $mode
        Expect-Failure { Run-Update } 'previous API image was restored'
        Assert-Equal (Command-Count 'TagPreviousActive') 1 'Old image tag not restored'
        Assert-Equal (Command-Count 'RollbackApi') 1 'API rollback not run'
        $purposes = @($script:Fixture.Calls | ForEach-Object Purpose)
        Assert-True ([array]::IndexOf($purposes,'RollbackApi') -lt [array]::LastIndexOf($purposes,'ReloadNginx')) 'Rollback must refresh proxy routing to the old API'
        Assert-Equal $purposes[-1] 'CheckHTTPSHealth' 'Rollback must verify external HTTPS'
        Assert-Equal $script:Fixture.CurrentImage $script:Fixture.OldImage 'Old image not running'
        Assert-True (-not (Test-Path (Join-Path $script:Fixture.State 'last-success.json'))) 'Failure advanced success state'
    }
}

Test-Case 'a deployment outside the updater stops automatic replacement' {
    $null = Run-Update
    $script:Fixture.CurrentImage = 'sha256:' + ('d' * 64)
    $script:Fixture.Calls.Clear()
    Expect-Failure { Run-Update } 'changed outside the updater'
    Assert-Equal (Command-Count 'Backup') 0 'Manual drift reached backup'
    Assert-Equal (Command-Count 'CloneCandidate') 0 'Manual drift reached candidate build'
}

Test-Case 'a later failed update preserves the earlier successful deployment marker exactly' {
    $null = Run-Update
    $successPath = Join-Path $script:Fixture.State 'last-success.json'
    $previousState = Get-Content -Raw -LiteralPath $successPath
    $previousImage = $script:Fixture.CurrentImage
    $script:Fixture.RemoteHead = '7' * 40
    $script:Fixture.Tree = '8' * 40
    $script:Fixture.NewImage = 'sha256:' + ('d' * 64)
    $script:Fixture.Activated = $false
    $script:Fixture.Mode = 'health-failure'
    Expect-Failure { Run-Update } 'previous API image was restored'
    Assert-Equal (Get-Content -Raw -LiteralPath $successPath) $previousState 'Failure modified earlier successful state'
    Assert-Equal $script:Fixture.CurrentImage $previousImage 'Rollback did not return to most recent successful image'
}

Test-Case 'failed builds back off without repeating backups; new upstream bypasses backoff' {
    $script:Fixture.Mode = 'build-failure'
    Expect-Failure { Run-Update } 'BuildCandidate failed'
    $script:Fixture.Calls.Clear()
    Assert-True ((Run-Update).Status.Contains('waiting for retry')) 'Failed revision was not deferred'
    Assert-Equal (Command-Count 'Backup') 0 'Backoff repeated backup'
    Assert-Equal (Command-Count 'BuildCandidate') 0 'Backoff repeated build'
    Assert-True (-not (Test-Path (Join-Path $script:Fixture.State 'last-success.json'))) 'Failure advanced successful commit'
    $script:Fixture.RemoteHead = '6' * 40
    $script:Fixture.Mode = 'normal'
    Assert-Equal (Run-Update).Status 'Pocket API updated and healthy.' 'New upstream did not bypass backoff'
}

Test-Case 'RetryFailed retries the same failed revision explicitly' {
    $script:Fixture.Mode = 'tests-failure'
    Expect-Failure { Run-Update } 'TestCandidate failed'
    $script:Fixture.Mode = 'normal'
    Assert-Equal (Run-Update -RetryFailed).ExitCode 0 'Explicit retry failed'
    Assert-Equal (Command-Count 'BuildCandidate') 2 'Explicit retry did not rebuild'
}

Test-Case 'startup health race retries before declaring activation failure' {
    $script:Fixture.Mode = 'health-starting'
    Assert-Equal (Run-Update).ExitCode 0 'Startup health retry failed'
    Assert-Equal $script:Fixture.HealthAttempts 3 'Startup health was not retried'
    Assert-Equal (Command-Count 'RollbackApi') 0 'Startup race incorrectly rolled back'
}

Test-Case 'nginx old workers drain through HTTPS retries without rolling back a healthy API' {
    $script:Fixture.Mode = 'proxy-starting'
    Assert-Equal (Run-Update).ExitCode 0 'Proxy health retry failed'
    Assert-Equal $script:Fixture.ProxyAttempts 3 'Proxy health was not retried'
    Assert-Equal (Command-Count 'RollbackApi') 0 'Proxy startup race incorrectly rolled back'
}

Test-Case 'exclusive lease prevents overlapping runs' {
    $lease = [IO.File]::Open((Join-Path $script:Fixture.State 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    try { $result = Run-Update; Assert-Equal $result.ExitCode 2 'Concurrent run was not skipped'; Assert-Equal $script:Fixture.Calls.Count 0 'Concurrent run executed commands' }
    finally { $lease.Dispose() }
}

Test-Case 'credential-bearing or unrelated remotes are rejected without fetching' {
    $script:Fixture.Origin = 'https://secret@github.com/UpperDownGuy/pocket-family.git'
    Expect-Failure { Run-Update } 'approved GitHub'
    Assert-Equal (Command-Count 'FetchUpstream') 0 'Credential-bearing origin was fetched'
}

# Exercise Windows native quoting against a real harmless Node process. This is
# the only non-mocked subprocess and makes no network or filesystem changes.
$values = @('', 'C:\a folder\', 'a"quoted value', '$(not-a-command)', '`literal`', 'plain')
$native = Invoke-PocketNativeProcess ([pscustomobject]@{ FilePath='node.exe'; Arguments=(@('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','--') + $values); WorkingDirectory=$PSScriptRoot; TimeoutSeconds=15; Purpose='Argument quoting test' })
Assert-Equal $native.ExitCode 0 'Native argument test failed'
$roundTrip = ConvertFrom-Json $native.StdOut
Assert-Equal $roundTrip.Count $values.Count 'Empty argument was lost'
for ($i=0; $i -lt $values.Count; $i++) { Assert-Equal $roundTrip[$i] $values[$i] 'Native argument changed' }
$script:Passed++
Write-Output ('PASS native Windows argument quoting')
Write-Output ("{0} updater tests passed under PowerShell {1}." -f $script:Passed, $PSVersionTable.PSVersion)
