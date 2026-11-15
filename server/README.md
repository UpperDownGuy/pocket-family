# Pocket server

Development API for separate families using the Pocket iPhone app. Node.js **22.13 or newer**; no npm dependencies.

## Run

```powershell
cd D:\Code\Swift\PocketFamily\server
npm start
```

The default address is `http://127.0.0.1:8787`. On a Mac, start the server from this directory with the same command. Node 22 may print an experimental SQLite warning.

Use **Create a family** in the Expo app to register a separate family and its first parent. Registration returns a permanent eight-digit **family code**. Family members use that code with their own username and password to sign in; usernames can be reused in other families. The family code selects a family and does not replace a password. Public registration is limited to five attempts per connection IP and thirty server-wide in ten minutes.

The original `POST /setup` route remains available only while no families are registered. It still requires the one-time server setup code printed on first launch, or `SETUP_CODE` when configured. It is retained for older clients; the Expo app's public registration does not need this server code. Existing configured databases receive a stable family code automatically, and their current sessions and File Tracker credentials remain valid. Login without a family code chooses the existing legacy family, or the sole registered family when no legacy family exists; otherwise the code is required. Older native/Safari clients that cannot enter a family code remain limited to that default-family login behavior.

Parents create additional parents and children in the app. Each person signs in with their own username and password. Passwords require at least ten characters. All balances start at zero. Add an opening balance as a parent.

For a physical iPhone, copy `.env.example` to `.env`, set `HOST` to this computer's local network IP, and enter `http://<that-ip>:8787` in the app. Both devices must be on the same private network, and the computer must allow the port through its firewall. The HTTP setting is for local development. Use HTTPS before placing the server outside a trusted development network. Do not expose this development server directly to the internet.

Settings:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address; loopback unless deliberately changed |
| `PORT` | `8787` | HTTP port |
| `DB_PATH` | `./data/pocket.sqlite` | Legacy database and base path for the family registry/databases |
| `SETUP_CODE` | Random per unconfigured startup | Legacy `/setup` code; not required by `/families` |

Each family has a separate SQLite database containing its accounts, hashed passwords and sessions, ledger, notifications, File Tracker records, and push delivery state. The server routes opaque session or computer credentials to exactly one family before running its existing authorization checks; parents only manage their own family. File Tracker setup codes are unique across families, and a computer credential cannot be paired to another family.

For `DB_PATH=/app/data/pocket.sqlite`, storage is:

- `/app/data/pocket.sqlite`: original family database, retained for compatibility.
- `/app/data/pocket.sqlite.families.sqlite`: registry containing family codes and database paths.
- `/app/data/pocket.sqlite.families/<family UUID>.sqlite`: each newly registered family's database.

All SQLite WAL/SHM sidecars belong to the same backup set. Back up the entire set with the supplied multi-family backup helper, or copy the complete data directory with the API stopped. Restoring only the legacy file will not restore additional families. Missing or unexpected registered database paths stop startup instead of silently creating an empty family. The API does not wipe data at startup and exposes no public family-deletion endpoint; the separate offline maintenance command handles an explicit administrator reset.

To make an online backup, run `node backup-families.mjs --db-path /absolute/path/pocket.sqlite`. Verified database copies and a manifest are written beneath `family-backups` beside the configured database. Docker installations with an explicit file list in `COPY` must bind-mount the helper script into the API container; the updated updater does this automatically. See [automatic updates and backups](../AUTO-UPDATE.md) and [the offline family reset procedure](../RESET-FAMILIES.md).

## Alerts

Every accepted addition or purchase creates an inbox item for **each parent plus the affected child**, in the same database transaction as the ledger entry. The other children receive neither that inbox item nor permission to read the transaction. Children can only record their own purchases; parents control additions. The native app refreshes its own scoped state.

Optional Apple sandbox push requires an Apple Developer account, a Push Notifications entitlement on the app, permission on each phone, and all four variables below:

```dotenv
APNS_TEAM_ID=YOUR_TEAM_ID
APNS_KEY_ID=YOUR_KEY_ID
APNS_TOPIC=com.yourname.PocketFamily
APNS_KEY_PATH=/absolute/private/path/AuthKey_YOUR_KEY_ID.p8
```

`APNS_TOPIC` must exactly match the installed app's bundle ID. Keep the `.p8` key outside the repository. This server uses **`api.sandbox.push.apple.com`**, for development builds; TestFlight and App Store push use a different environment and are not supported by this development configuration.

With no APNs configuration, the inbox still works; background device pushes are unavailable. With credentials set, only registered recipient devices get a generic lock-screen message: “Your balance activity has changed.” Details remain inside the authenticated app. A durable outbox retries transient delivery failures up to six times with increasing delay. APNs acceptance does not guarantee presentation on a phone. Failed deliveries stay recorded in the local `outbox` table; they do not undo the balance or inbox entry. Re-registering a device under a different user or family cancels stale pending deliveries and removes its old family binding before registering the new one. Logging out revokes that session and unregisters its devices.

## Browser receipt capture

`POST /browser/purchase` accepts a recognized receipt from the authenticated **child's** Safari extension:

```json
{
  "merchant": "Example Store",
  "note": "Order EX-123",
  "amountCents": 1299,
  "orderReference": "EX-123",
  "url": "https://shop.example/order-confirmation",
  "currency": "USD"
}
```

The server requires a valid HTTPS URL, a clear order reference, a positive amount in whole cents, and USD. It generates the idempotency key from the child, merchant hostname, and order reference. Repeated scans or navigation return the original entry. A changed amount or description under the same identity returns a conflict, rather than silently changing the ledger. URL query strings and page contents are not persisted. No card number, security code, Apple Pay token or Stripe credential is accepted or stored.

Receipt capture is automatic bookkeeping, **not proof that a merchant charged a card**, payment processing, a direct Apple Pay feed, or a connection to Stripe Link's purchase history. Only recognizable receipt pages can be captured. The browser extension must use its native URLSession bridge: this server rejects browser `Origin` headers and does not expose CORS endpoints.

## API

All routes below use JSON. There is no `/api` prefix. Errors return `{ "error": "..." }`. Protected routes require `Authorization: Bearer <token>`. Sessions expire after 14 days.

| Method / path | Access | Result |
|---|---|---|
| `GET /health` | Public | `setupRequired`, `pushConfigured`, `capabilities.fts`, `capabilities.families:{multiple:true,registration:true}`; no family directory |
| `POST /families` | Public, rate limited | Creates a family from `{familyName,name,username,password}`; returns `token`, `user`, `familyName`, `familyCode` |
| `POST /setup` | One-time setup code; registry empty | Legacy family setup; returns `token`, `user`, `familyName`, `familyCode` |
| `POST /login` | Username/password and optional `familyCode` | Returns `token`, `user`, `familyName`, `familyCode` |
| `POST /logout` | Signed in | Revokes current session and its device registrations |
| `GET /state` | Signed in | Scoped `user`, `familyName`, `familyCode`, `members`, `transactions`, `notifications`, `computerNotifications`, `pushConfigured` |
| `POST /members` | Parent | Adds `{name,username,password,role}`; returns `member` |
| `POST /transactions` | Parent; child limited to self/purchase | Adds entry; returns `transaction`, `replayed` |
| `GET /transactions/:id/items` | Parent or transaction's child | `{items,totalCount,omittedCount}` for an FTS receipt; unknown or unauthorized IDs return 404 |
| `POST /browser/purchase` | Child | Adds recognized receipt purchase; returns `transaction`, `replayed` |
| `POST /notifications/read` | Recipient | Marks owned IDs in `{ids:[...]}` read |
| `POST /devices` | Signed in | Registers `{token}` to current user/session |
| `DELETE /devices` | Token owner | Removes `{token}` |

Manual transaction fields: `{childId,kind,amountCents,merchant,note,idempotencyKey}`. `kind` is `addition` or `purchase`; amount is 1–1,000,000 cents. `merchant` is the store or addition reason. Reusing an idempotency key with the same normalized payload returns the same transaction; a different payload returns HTTP 409. Purchases can take the tracked balance below zero, including when no opening balance was entered. A purchase already happened and must still be recorded and sent to its recipients. The app is a family ledger, not spending authorization; it does not change the funds in an external card account. Calculated balances must remain within JavaScript's safe integer range.

FTS voucher issuance (`POST /fts/vouchers`, authenticated with the computer credential) accepts optional `items` on each report: `{reportId,movieCount,priceCents,items:[{path,status,oldPath?}]}`. Status is `added`, `removed`, `modified`, or `renamed`; only renamed items may have `oldPath`. Each report can supply up to 500 items and never more than its edit count. Paths are relative, use at most 500 UTF-16 code units, and may not contain drive names, parent traversal, empty/dot segments, control characters, or leading/trailing whitespace. Backslashes normalize to slashes. Duplicate paths within a report are rejected. This route accepts up to 512 KiB of JSON; other routes retain the 16 KiB limit.

Receipt items are stored atomically with their voucher, and normalized details participate in its immutable retry fingerprint. The receipt endpoint returns items as `{reportId,path,status,oldPath?}`; `totalCount` is the paid edit count and `omittedCount` is the number without saved item details. Existing count-only receipts return an empty list with all edits omitted. A retry sent to an older server that ignored item fields remains redeemable after upgrade, without retroactively adding those details. Transactions unrelated to FTS return an empty list and zero counts. Item lists are fetched separately and never included in `/state` or exposed to computer credentials or siblings.

## Verify

```powershell
npm test
```

The tests create and delete temporary databases. They cover separate families with reused usernames, family codes, legacy upgrades, credential routing, global computer pairing, cross-family device transfers, receipt privacy, recipient routing, sibling privacy, privilege checks, whole-cent money, idempotency, simultaneous purchases, negative balances, purchases before an opening balance, atomic inbox creation, persistence, read state, authentication, browser receipt validation, and mock push delivery. They never contact Apple or send real notifications.
