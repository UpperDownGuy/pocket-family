# Pocket server automatic updates

This updater is for the existing Docker Desktop Linux deployment on **WIN-SERVER-1**:

- Compose project `pocket`, API service `api`, HTTPS service `https`.
- Existing `compose.yaml` and `compose.override.yaml` remain authoritative.
- `pocket-data` remains mounted at `/app/data`; `pocket-tls` stays with HTTPS.
- Source comes from `UpperDownGuy/pocket-family`, branch `main`.

The Windows task checks GitHub **every minute**. Checks do not overlap. It skips unchanged server code and does not restart the API for Expo-only changes.

## What happens on an update

The updater fetches GitHub and prepares an isolated candidate containing the upstream changes and your local deployment commits. It does not pull, reset, rebase, or merge into the live checkout. A conflict stops the update before deployment.

Before rebuilding, it runs your existing `deploy\backup.ps1`. A failed command stops the update. It builds the API locally and runs its server tests in an isolated container without access to family data or deployment secrets. It keeps the previous image available and recreates only `api` through the existing Compose configuration. The API must answer its health endpoint and retain the existing database setup state. The updater gracefully reloads nginx in its existing container so it resolves the new API address, then verifies `https://pocket.alexxweb.com/health` with normal certificate checks. If replacement fails, the updater attempts to restore the previous image, reloads nginx again, and checks health through HTTPS before reporting recovery.

It never runs `down -v`, replaces named volumes, renews certificates, or recreates HTTPS. Rollback changes the image; it does not overwrite the database with a backup. Backups remain available for manual recovery if a future incompatible database migration needs it.

## Install on WIN-SERVER-1

Run the following in **PowerShell as Administrator on WIN-SERVER-1**, using the account that runs Docker Desktop. Docker Desktop's Linux engine and the existing Pocket containers must be running. The backup script must already work in the live deployment, and `https://pocket.alexxweb.com/health` must be reachable with a trusted certificate from the server.

This downloads only the updater scripts from GitHub, so installing it does not require overwriting your unpublished deployment commits:

```powershell
$repo = 'C:\Users\Administrator.WIN-SERVER-1\Documents\Codex\2026-11-11\deploy-pocket-s-api-server-as\work\pocket-family'
Set-Location -LiteralPath $repo
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed.' }

$bundle = Join-Path $env:TEMP ('PocketAutoUpdate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $bundle | Out-Null
$archive = Join-Path $bundle 'updater.zip'
git archive --format=zip "--output=$archive" origin/main deploy/Install-PocketAutoUpdate.ps1 deploy/Update-PocketServer.ps1 deploy/Uninstall-PocketAutoUpdate.ps1
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the updater bundle.' }
Expand-Archive -LiteralPath $archive -DestinationPath $bundle

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$bundle\deploy\Install-PocketAutoUpdate.ps1" -RepoPath $repo -RunNow
if ($LASTEXITCODE -ne 0) { throw 'Updater installation failed.' }
```

The installer validates the existing deployment, copies the updater to `%ProgramData%\Pocket\Updater`, and registers **Pocket Server Auto Update**. `-RunNow` starts the first check immediately. Subsequent checks run every minute and after logon. No password is saved in the task.

The task runs under the current logged-in Windows account because Docker Desktop's engine belongs to that user. Keep that account logged in and Docker Desktop running; disconnecting an RDP session is different from signing out.

## Check or stop it

```powershell
Get-ScheduledTask -TaskName 'Pocket Server Auto Update'
Get-ScheduledTaskInfo -TaskName 'Pocket Server Auto Update'
```

State and daily logs (`update-YYYY-MM-DD.log`, dated in UTC) are in `%ProgramData%\Pocket\Updater`. The updater checks the running image against its last successful deployment. Unexpected manual image changes, dirty tracked files, conflicting commits, failed backups, and unhealthy containers stop the update and are recorded there. Resolve the reported issue before retrying. Do not delete the database or volumes to clear an update error.

Checks still run every minute after a failed update. The same failed revision waits 15 minutes before another build attempt; a new GitHub revision can be tried immediately. To retry immediately after fixing a failure, run the following from the same elevated PowerShell session (using the `$repo` value above):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\Pocket\Updater\Update-PocketServer.ps1" -RepoPath $repo -RetryFailed
```

To stop future checks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\Pocket\Updater\Uninstall-PocketAutoUpdate.ps1"
```

Removing the task leaves containers, volumes, backups, and logs in place. An update already in progress is allowed to finish. To upgrade the updater itself, run the installation steps again; the scheduled task uses a stable installed copy rather than executing a changing GitHub script.

Certificate renewal remains manual and separate from application updates.

Implementation references: [Windows Task Scheduler repetition](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-repetitiontype-complextype), [Docker Compose service replacement and health checks](https://docs.docker.com/reference/cli/docker/compose/up/), and [nginx graceful reload](https://nginx.org/en/docs/control.html).
