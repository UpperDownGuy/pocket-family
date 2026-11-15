# File Tracker earnings

The Python File Tracking System can issue a QR code for earned report credits. A child scans it in Pocket to receive the credit in their own account. A parent scans it, chooses a child, and confirms. Parents and the chosen child receive the normal ledger and inbox entries; other children do not.

## Connect once

1. Update the Pocket API server and reload the Expo app. The original SwiftUI app does not contain this scanner. Expo Go supports it; standalone installations need the new IPA.
2. In Pocket, open **Family → File Tracker**, choose a name and the price per edit, then create a connection. Both parents and kids can create keys. The displayed setup key is **eight digits**, works once, and expires after ten minutes. Keep any leading zero.
3. In the updated Python FTS folder, run `python -m pip install -r requirements.txt`.
4. Open FTS **Settings → Connect Pocket**. Enter the family's HTTPS server address and all eight digits. FTS saves the connection automatically; you do not need the setup key again. Use the same per-edit price in FTS Budgeting. Existing connected computers continue working.
5. Export reports to Excel with budgeting enabled. The **Pocket credits** window opens with a QR. Scan it using **Scan earnings** in Pocket.

The connection authorizes that computer to issue earnings without approving every export. It can issue and check credits, but cannot read family accounts or spend money. Report counts come from that authorized computer. Kids can view and remove their own connections; parents can manage every family connection. Removing a connection in Pocket cancels its unused codes; previously redeemed money stays in the ledger.

## After scanning

FTS checks the server every three seconds while the desktop app is open. When redemption is confirmed, it removes the displayed QR and saved code and shows **Redeemed**. The image is rendered in memory; no QR PNG is written. Reopening FTS resumes an unclaimed code. An offline computer keeps the code until it can verify the server's status.

Each report ID is credited at most once per family server, including across different parent accounts and tracker connections. The amount is fixed when the server issues the code. Redemption and the ledger/inbox changes commit together. Copies of a used code cannot add money again. FTS's own local budgeting balance remains its existing earnings record.

The tracker groups up to 50 reports and $10,000 into a code. Redeem the current code before creating another batch. Re-export the folder if needed after restarting FTS; report deduplication prevents another payment for the same work. Keep FTS's saved state so an unclaimed code can be resumed.

## Server update

If the [one-minute updater](AUTO-UPDATE.md) is installed on WIN-SERVER-1, it will deploy the changed server code after backing up and passing checks. This release adds SQLite tables without removing existing account or ledger data. If the updater has not been installed, follow its installation block on the server first. Do not replace the live checkout with a new clone or discard its local deployment commits.

## Protocol and verification

QR contents are `pocket://redeem?code=<opaque code>`. They contain no account password, connection key, recipient, amount, or server address. Pocket uses its configured family server, validates the code there, and applies account permissions there.

Family sessions manage `/fts/issuers`, with owner-only access for kids and family-wide access for parents. Creating an issuer returns its eight-digit `setupCode` and `expiresAt`. FTS exchanges the number through the rate-limited `/fts/pair` endpoint for a persistent connection, using a securely generated credential saved before the request so interrupted setup can be retried. The eight-digit number cannot authorize earnings requests. Existing credentials remain valid.

Scoped tracker credentials access `/fts/connection`, `/fts/vouchers`, and `/fts/vouchers/status`. Family sessions preview and redeem through `/credits/preview` and `/credits/redeem`. Requests use JSON and bearer authentication after pairing. Setup keys, tracker credentials, and QR codes are hashed in the server database; Windows FTS protects its pending setup details, saved credential, and unclaimed code with DPAPI.

The FTS test suite includes an optional real Python-to-Node integration test. Set `POCKET_TEST_SERVER_DIR` to this repository, then run `python -m unittest discover -s tests` from the FTS folder. It uses a temporary database and local test accounts, never the live family server.
