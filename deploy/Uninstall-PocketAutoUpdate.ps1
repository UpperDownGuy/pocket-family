#requires -Version 5.1
<#
.SYNOPSIS
Removes Pocket's scheduled update task without deleting application or updater data.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()

function Assert-PocketUninstallAdministrator {
    param()
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open Windows PowerShell as administrator on the Pocket server and rerun this command.'
    }
}

function Uninstall-PocketAutoUpdate {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param()
    $ErrorActionPreference = 'Stop'
    Assert-PocketUninstallAdministrator
    $task = Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object { $_.TaskName -eq 'Pocket Server Auto Update' }
    if ($null -eq $task) { Write-Output 'Pocket automatic updates are already uninstalled. No files or containers were changed.'; return }
    if ($PSCmdlet.ShouldProcess('\Pocket Server Auto Update', 'Unregister only the scheduled update task')) {
        Unregister-ScheduledTask -TaskName 'Pocket Server Auto Update' -TaskPath '\' -Confirm:$false -ErrorAction Stop
        Write-Output 'Removed the Pocket update task. Server containers, source, volumes, backups, logs, and updater state are unchanged.'
        if ($task.State -eq 'Running') { Write-Output 'An update was already running and has not been stopped. Let it finish; check the updater log for its result.' }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    Uninstall-PocketAutoUpdate -WhatIf:$WhatIfPreference
}
