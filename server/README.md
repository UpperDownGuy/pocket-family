# Pocket server

Private development API for the Pocket iPhone app. Node.js **22.13 or newer**; no npm dependencies.

## Run

```powershell
cd D:\Code\Swift\PocketFamily\server
npm start
```

The default address is `http://127.0.0.1:8787`. On a Mac, start the server from this directory with the same command. Node 22 may print an experimental SQLite warning.

On first launch the terminal prints a random **one-time family setup code**. Enter it in the iPhone's Create family screen, along with the first parent's credentials. It is not stored in the database and changes after an unconfigured server restarts. After setup, that endpoint cannot create another family. Keep the code private. An optional `SETUP_CODE` environment variable supplies a fixed code for setup.

Parents create additional parents and children in the app. Each person signs in with their own username and password. Passwords require at least ten characters. All balances start at zero. Add an opening balance as a parent.

For a physical iPhone, copy `.env.example` to `.env`, set `HOST` to this computer's local network IP, and enter `http://<that-ip>:8787` in the app. Both devices must be on the same private network, and the computer must allow the port through its firewall. The HTTP setting is for local development. Use HTTPS before placing the server outside a trusted development network. Do not expose this development server directly to the internet.

Settings:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address; loopback unless deliberately changed |
| `PORT` | `8787` | HTTP port |
| `DB_PATH` | `./data/pocket.sqlite` | Persistent SQLite file, relative to working directory |
| `SETUP_CODE` | Random per unconfigured startup | First-family creation code |

The SQLite database contains family identities, hashed passwords, hashed sessions, the ledger, notifications and push delivery state. It is ignored by Git. Back up `data/` with the server stopped. Do not delete it to restart the server; deletion resets the family.

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

With no APNs configuration, the inbox still works; background device pushes are unavailable. With credentials set, only registered recipient devices get a generic lock-screen message: “Your balance activity has changed.” Details remain inside the authenticated app. A durable outbox retries transient delivery failures up to six times with increasing delay. APNs acceptance does not guarantee presentation on a phone. Failed deliveries stay recorded in the local `outbox` table; they do not undo the balance or inbox entry. Re-registering a device under a different user cancels stale pending deliveries. Logging out revokes that session and unregisters its devices.

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
| `GET /health` | Public | `setupRequired`, `pushConfigured` |
| `POST /setup` | One-time setup code | `token`, `user`, `familyName` |
| `POST /login` | Username/password | `token`, `user`, `familyName` |
| `POST /logout` | Signed in | Revokes current session and its device registrations |
| `GET /state` | Signed in | Scoped `user`, `familyName`, `members`, `transactions`, `notifications`, `pushConfigured` |
| `POST /members` | Parent | Adds `{name,username,password,role}`; returns `member` |
| `POST /transactions` | Parent; child limited to self/purchase | Adds entry; returns `transaction`, `replayed` |
| `POST /browser/purchase` | Child | Adds recognized receipt purchase; returns `transaction`, `replayed` |
| `POST /notifications/read` | Recipient | Marks owned IDs in `{ids:[...]}` read |
| `POST /devices` | Signed in | Registers `{token}` to current user/session |
| `DELETE /devices` | Token owner | Removes `{token}` |

Manual transaction fields: `{childId,kind,amountCents,merchant,note,idempotencyKey}`. `kind` is `addition` or `purchase`; amount is 1–1,000,000 cents. `merchant` is the store or addition reason. Reusing an idempotency key with the same normalized payload returns the same transaction; a different payload returns HTTP 409. Purchases can take the tracked balance below zero, including when no opening balance was entered. A purchase already happened and must still be recorded and sent to its recipients. The app is a family ledger, not spending authorization; it does not change the funds in an external card account. Calculated balances must remain within JavaScript's safe integer range.

## Verify

```powershell
npm test
```

The tests create and delete temporary databases. They cover recipient routing, sibling privacy, privilege checks, whole-cent money, idempotency, simultaneous purchases, negative balances, purchases before an opening balance, atomic inbox creation, persistence, read state, authentication, browser receipt validation, and mock push delivery. They never contact Apple or send real notifications.
