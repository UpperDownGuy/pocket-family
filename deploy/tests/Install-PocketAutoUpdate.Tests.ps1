#requires -Version 5.1
# No task, Docker, Git, ACL or filesystem mutations: all installer side effects are mocked.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\Install-PocketAutoUpdate.ps1')
. (Join-Path $PSScriptRoot '..\Uninstall-PocketAutoUpdate.ps1')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

$repo = 'C:\Family server & code\pocket-family'
$state = 'C:\ProgramData\Pocket\Updater'
$sid = 'S-1-5-21-1-2-3-500'
[xml]$xml = New-PocketAutoUpdateTaskXml -UserSid $sid -RepoPath $repo -StateDirectory $state -PowerShellPath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -StartAt ([datetime]'2026-11-15T12:34:56')
Assert-True ($xml.Task.Principals.Principal.UserId -eq $sid) 'The task must use the installing user SID.'
Assert-True ($xml.Task.Principals.Principal.LogonType -eq 'InteractiveToken') 'No password or service account logon is allowed.'
Assert-True ($xml.Task.Principals.Principal.RunLevel -eq 'HighestAvailable') 'The task must run elevated.'
Assert-True ($xml.Task.Triggers.TimeTrigger.Repetition.Interval -eq 'PT1M') 'The task must repeat every minute.'
Assert-True ($null -eq $xml.Task.Triggers.TimeTrigger.Repetition.Duration) 'The repetition must have no expiry.'
Assert-True ($xml.Task.Triggers.TimeTrigger.StartBoundary -eq '2026-11-15T12:34:56') 'The first trigger time must round-trip.'
Assert-True ($xml.Task.Triggers.LogonTrigger.UserId -eq $sid) 'The logon trigger must match the installing user.'
Assert-True ($xml.Task.Settings.MultipleInstancesPolicy -eq 'IgnoreNew') 'Overlapping scheduled checks must be skipped.'
Assert-True ($xml.Task.Settings.ExecutionTimeLimit -eq 'PT1H') 'The task must allow time for backup, build, tests, and rollback.'
Assert-True ($xml.Task.Actions.Exec.WorkingDirectory -eq $repo) 'The task working directory must be the live checkout.'
Assert-True ($xml.Task.Actions.Exec.Arguments.Contains('-File "C:\ProgramData\Pocket\Updater\Update-PocketServer.ps1"')) 'The task must run the stable updater.'
Assert-True ($xml.Task.Actions.Exec.Arguments.Contains('-RepoPath "C:\Family server & code\pocket-family"')) 'Paths containing spaces and ampersands must be quoted and XML-escaped correctly.'
Assert-True ($xml.Task.Actions.Exec.Arguments.Contains('-WindowStyle Hidden')) 'The background PowerShell window must be hidden.'
Assert-True (-not $xml.Task.Actions.Exec.Arguments.Contains('-Command')) 'Paths must be arguments, not interpolated PowerShell code.'
$rejected = $false
try { $null = ConvertTo-PocketTaskArgument 'C:\bad"path' } catch { $rejected = $true }
Assert-True $rejected 'An embedded quote must be rejected.'
Write-Output 'PASS: one-minute schedule, stable action, interactive identity, and path quoting'

function Set-Acl {
    [CmdletBinding()] param($LiteralPath, $AclObject)
    $script:capturedAcl = $AclObject
}
Set-PocketUpdaterDirectoryAcl -Path $state -UserSid $sid
$rules = @($script:capturedAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
Assert-True $script:capturedAcl.AreAccessRulesProtected 'Updater directory ACL inheritance must be disabled.'
Assert-True ($rules.Count -eq 3) 'Only the installing user, Administrators, and SYSTEM may access updater state.'
foreach ($requiredSid in @($sid, 'S-1-5-32-544', 'S-1-5-18')) {
    Assert-True (@($rules | Where-Object { $_.IdentityReference.Value -eq $requiredSid -and $_.AccessControlType -eq 'Allow' }).Count -eq 1) "Missing protected access for $requiredSid."
}
Write-Output 'PASS: restricted updater directory ACL'

$script:mutations = New-Object 'System.Collections.Generic.List[string]'
function Get-PocketAutoUpdateInstallContext {
    param($RepoPath)
    return [pscustomobject]@{
        RepoPath = $RepoPath; StateDirectory = $state; Source = 'C:\download bundle\Update-PocketServer.ps1'
        SourceHash = 'TESTHASH'; Uninstaller = 'C:\download bundle\Uninstall-PocketAutoUpdate.ps1'; UninstallerHash = 'TESTHASH'
        UserSid = $sid; UserName = 'SERVER\Administrator'; PowerShellPath = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    }
}
function Test-Path { [CmdletBinding()] param($LiteralPath, $PathType); return $true }
function Set-PocketUpdaterDirectoryAcl { param($Path, $UserSid); $script:mutations.Add('acl') }
function Copy-Item { [CmdletBinding()] param($LiteralPath, $Destination); $script:mutations.Add("copy:$LiteralPath") }
function Move-Item { [CmdletBinding()] param($LiteralPath, $Destination, [switch]$Force); $script:mutations.Add("move:$Destination") }
function Get-FileHash { [CmdletBinding()] param($LiteralPath, $Algorithm); return [pscustomobject]@{ Hash = 'TESTHASH' } }
function Remove-Item { [CmdletBinding()] param($LiteralPath); $script:mutations.Add('temporary cleanup') }
function Register-ScheduledTask { [CmdletBinding()] param($TaskName, $TaskPath, $Xml, [switch]$Force); $script:mutations.Add("register:$TaskPath$TaskName") }
function Start-ScheduledTask { [CmdletBinding()] param($TaskName, $TaskPath); $script:mutations.Add('start') }
Install-PocketAutoUpdate -RepoPath $repo -RunNow -WhatIf
Assert-True ($script:mutations.Count -eq 0) 'WhatIf must not copy files, change ACLs, register a task, or start it.'
Install-PocketAutoUpdate -RepoPath $repo -Confirm:$false | Out-Null
Assert-True (-not $script:mutations.Contains('start')) 'Installation must not immediately run an update without RunNow.'
Assert-True ($script:mutations.Contains('move:C:\ProgramData\Pocket\Updater\Update-PocketServer.ps1')) 'The updater must be copied to its stable path.'
Assert-True ($script:mutations.Contains('move:C:\ProgramData\Pocket\Updater\Uninstall-PocketAutoUpdate.ps1')) 'The uninstaller must be available after deleting the downloaded bundle.'
Assert-True ($script:mutations.Contains('register:\Pocket Server Auto Update')) 'The expected task must be registered.'
$script:mutations.Clear()
Install-PocketAutoUpdate -RepoPath $repo -RunNow -Confirm:$false | Out-Null
Assert-True ($script:mutations.Contains('start')) 'RunNow must start the registered task.'
Assert-True ($script:mutations.IndexOf('start') -gt $script:mutations.IndexOf('register:\Pocket Server Auto Update')) 'The task must be registered before starting it.'
Write-Output 'PASS: WhatIf has no mutations; stable copies and explicit RunNow work'

function Assert-PocketUninstallAdministrator {}
function Get-ScheduledTask { [CmdletBinding()] param($TaskPath); return [pscustomobject]@{ TaskName = 'Pocket Server Auto Update'; State = 'Running' } }
function Unregister-ScheduledTask { [CmdletBinding(SupportsShouldProcess = $true)] param($TaskName, $TaskPath); $script:mutations.Add("unregister:$TaskPath$TaskName") }
function Stop-ScheduledTask { throw 'Uninstall must never interrupt an active deployment.' }
$script:mutations.Clear()
Uninstall-PocketAutoUpdate -WhatIf
Assert-True ($script:mutations.Count -eq 0) 'Uninstall WhatIf must not unregister or delete anything.'
$output = @(Uninstall-PocketAutoUpdate -Confirm:$false)
Assert-True ($script:mutations.Count -eq 1 -and $script:mutations[0] -eq 'unregister:\Pocket Server Auto Update') 'Uninstall must only remove the schedule, leaving files, state and running work alone.'
Assert-True (($output -join ' ').Contains('already running')) 'Uninstall must report that an active update can finish.'
Write-Output 'PASS: uninstall preserves active work and all data'
Write-Output "All installer tests passed under PowerShell $($PSVersionTable.PSVersion). No scheduled tasks were created."
