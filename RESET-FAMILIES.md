# Reset every Pocket family

This is a one-time, offline maintenance operation for **WIN-SERVER-1**. It clears every family, account, balance, transaction, notification, session, connected computer, and credit code from the active server. The server's HTTPS certificates, Docker volumes, local deployment commits, and existing backups stay in place.

The reset makes a protected, hash-verified backup before removing database files. Old information remains in that backup for recovery; this is not a secure erasure of backups. There is no reset API, scheduled wipe, or reset on application startup.

## Run on WIN-SERVER-1

Use **PowerShell as Administrator**, under the Windows account running Docker Desktop. Docker Desktop's Linux engine and the existing Pocket API/HTTPS containers must be running. The live `deploy\backup.ps1` must already work.

Download the maintenance bundle without replacing unpublished deployment commits:

```powershell
$repo = 'C:\Users\Administrator.WIN-SERVER-1\Documents\Codex\2026-11-11\deploy-pocket-s-api-server-as\work\pocket-family'
Set-Location -LiteralPath $repo
git fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed.' }

$bundle = Join-Path $env:TEMP ('PocketFamilyReset-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $bundle | Out-Null
$archive = Join-Path $bundle 'maintenance.zip'
git archive --format=zip "--output=$archive" origin/main deploy/Install-PocketAutoUpdate.ps1 deploy/Update-PocketServer.ps1 deploy/Uninstall-PocketAutoUpdate.ps1 deploy/Reset-PocketFamilies.ps1 server/reset-families.mjs
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare maintenance tools.' }
Expand-Archive -LiteralPath $archive -DestinationPath $bundle

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$bundle\deploy\Install-PocketAutoUpdate.ps1" -RepoPath $repo
if ($LASTEXITCODE -ne 0) { throw 'Updater installation did not complete. Read its message before continuing.' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:ProgramData\Pocket\Updater\Update-PocketServer.ps1" -RepoPath $repo -ForceRebuild
if ($LASTEXITCODE -ne 0) { throw 'Pocket update did not complete. Resolve that result before resetting.' }
```

This updates the installed one-minute updater and deploys the current API. Its health response must report `capabilities.families.multiple: true` and `registration: true`. The reset wrapper checks both before stopping the API, so an older server cannot be wiped without the replacement family-creation flow ready.

Then run the explicit reset once:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$bundle\deploy\Reset-PocketFamilies.ps1" -RepoPath $repo -Confirmation WIPE-ALL-FAMILIES
if ($LASTEXITCODE -ne 0) { throw 'Reset did not complete normally. Read the maintenance result before retrying.' }
```

If installation, update, or reset reports another Pocket operation is running, wait for it to finish and rerun only that command. The reset shares the updater's exclusive lock; it does not terminate an active deployment.

After success, reload Pocket in Expo Go, sign out if an old account is still displayed, and choose **Create a family**. Each new family receives its own code for signing in. Previous sessions and File Tracker setup keys no longer work; connect each computer to its new family again.

## What the reset verifies

The wrapper validates the live checkout, Compose project `pocket`, original API image, `pocket-data` mounted at `/app/data`, and the unchanged HTTPS container/`pocket-tls` volume. It derives the actual database path from the running API and requires a `.sqlite` file directly under that data mount.

It runs the existing deployment backup first. Then it stops only `api` and verifies that no running container uses `pocket-data`. The standalone Node reset script is mounted read-only from the downloaded bundle; it does not need to be included in an older Dockerfile. A temporary Compose container performs the offline reset, after which the wrapper starts API, reloads nginx in its existing container, and checks health through HTTPS.

For a database named `/app/data/pocket.sqlite`, the only reset targets are:

- `pocket.sqlite`, its `-wal` and `-shm` files.
- `pocket.sqlite.families.sqlite`, its `-wal` and `-shm` files.
- UUID-named `.sqlite`, `-wal`, and `-shm` files directly inside `pocket.sqlite.families`.

Registry paths must match that layout. Symlinks, hard links, paths outside it, and unexpected entries in the family directory stop the operation. It does not recursively delete directories or remove volumes.

## Backups and recovery

The result prints an offline backup directory inside `pocket-data`, such as `/app/data/.pocket-family-reset-<timestamp>-<id>`. It contains every original database and SQLite sidecar, a `manifest.json` listing relative paths, sizes, and SHA-256 hashes, and `reset-complete.json` when removal finished. Linux directory/file permissions are `0700`/`0600`. Reset logs are in `%ProgramData%\Pocket\Updater\reset-YYYY-MM-DD.log`.

If the offline tool fails after it begins, the wrapper leaves API stopped because completion may be uncertain. Keep it stopped while inspecting the backup and manifest. A failed API/HTTPS recovery after a completed reset is reported separately; repeating the wipe does not repair startup.

Recovery requires stopping all API processes, verifying the manifest hashes, and restoring the complete database set to the original relative locations under the same configured data directory. Restore the registry, every family database, and any backed-up WAL/SHM together; do not mix reset-created databases with old sidecars. The reset tool never restores automatically.

For a manually managed, non-Docker installation, stop every process using the databases before running the CLI with an explicit canonical absolute path:

```text
node reset-families.mjs --db-path /absolute/data/pocket.sqlite --confirm WIPE-ALL-FAMILIES
```

The CLI checks that source files stay unchanged during backup, but it cannot prove that another application process will not open them afterward. The Windows wrapper enforces the offline condition for this Docker deployment.
