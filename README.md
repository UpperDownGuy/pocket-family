# Pocket

A private family balance tracker for iPhone, built with SwiftUI, SF Symbols, and native iOS 26 Liquid Glass. A small Node server keeps the family ledger and each person's inbox together.

Parents can add money, record purchases, and manage family members. Children can record their own purchases and see their own balance. Every balance change creates an inbox entry for all parents and the affected child. Siblings cannot read one another's balances, purchases, or alerts through the API.

This is a development app. Amounts are ledger entries; Pocket does not hold or transfer money. There are no bank connections or AI services.

## Build in the cloud and install from Windows

Use the private repository's [Build iPhone IPA workflow](https://github.com/UpperDownGuy/pocket-family/actions/workflows/build-ios.yml) to compile Pocket and its Safari extension on GitHub's macOS runner. Download the successful run's IPA artifact, extract it, and sign `Pocket-unsigned.ipa` with Sideloadly on Windows. The workflow requires no Apple secrets and keeps the Safari extension inside the app.

Follow the [Windows installation guide](WINDOWS-INSTALL.md) for download, signing, server connection, and Safari setup. This build is unsigned and does not enable APNs; system push alerts require the separate signing configuration below.

## Stripe Link

Stripe Link saves payment details for checkout. Its documented merchant APIs do not provide a general consumer feed of purchases made at unrelated stores. Pocket does **not** connect to Link's transaction history. Its Safari extension can instead read clear order confirmations on enabled websites, including after Link, autofill, or Apple Pay checkout. It cannot see the Apple Pay sheet, verify a card charge, or detect purchases in other apps. See [Stripe's Link documentation](https://docs.stripe.com/payments/link).

## Start the server

Install Node.js 22.13 or later. In PowerShell:

```powershell
Set-Location 'D:\Code\Swift\PocketFamily\server'
npm start
```

The default address is `http://127.0.0.1:8787`. On first setup, the server prints a setup code. Keep that terminal open and enter the code when creating the first parent in the app. Each password needs at least ten characters. Balances start at zero; the parent adds an opening balance.

To connect an actual iPhone over your home network, restart the server with:

```powershell
$env:HOST = '0.0.0.0'
npm start
```

Use the computer's LAN address, such as `http://192.168.1.20:8787`, or a working `.local` hostname in the app's server field. On an iPhone, `localhost` means the phone itself. Both devices must be on the same network; allow Node through Windows Firewall on the private network if prompted. The simulator can use `localhost` when the server runs on the same Mac.

The local HTTP configuration is for a trusted development network. Keep it off the public internet. The computer must remain awake and the server must keep running for family devices to sync.

## Install on iPhone

1. Copy this project to a Mac with Xcode 26 or later. Open `PocketFamily.xcodeproj`.
2. Select the **Pocket** app target. In **Signing & Capabilities**, choose your team and change `com.example.PocketFamily` to a unique bundle identifier. Also configure the Safari extension target with the same team and an identifier prefixed by the app's identifier, for example `com.yourname.PocketFamily.Safari`.
3. Select an iPhone or simulator running iOS 26 or later. For a physical phone, pair it with Xcode and enable **Settings > Privacy & Security > Developer Mode**, then restart and confirm. [Apple's device setup](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
4. Build and run. Set the server address, create the first parent with the setup code, then add each child and any additional parent with a separate username and password.
5. Install on each family member's phone and sign in with that person's account. Use the same server address.

The default target omits the push entitlement so basic development can use a Personal Team. Free provisioning expires after seven days and requires reinstalling from Xcode; Apple also limits registered devices. [Apple's account limits](https://developer.apple.com/help/account/basics/about-your-developer-account)

## Safari purchase capture

1. After installing Pocket, open **Settings > Apps > Safari > Extensions** and enable Pocket. In Safari, open the extension from the page menu.
2. Sign in inside the extension with that child's Pocket username and password and the same server address. This sign-in is separate from the app; its token stays in the extension's Keychain, scoped to the Safari profile.
3. At a store, choose **Enable this site**, grant Safari access for that site, and reload once. Each origin is enabled separately; no site is opted in by default.
4. Complete checkout normally. Leave the confirmation page open briefly. The extension records a purchase only when it finds a clear success heading, one order reference, and one labeled total explicitly marked **USD** or **US$**. **Check this page** reports whether it saved or needs a manual entry.

The extension sends the store hostname, order reference, total, and a fixed purchase note to your server. It does not inspect form input values, autofill credentials, Apple Pay data, cookies, or network traffic. It omits receipt URL paths and query strings. Website access is controlled by Safari as well as Pocket's site toggle. [Apple's Safari extension documentation](https://developer.apple.com/documentation/safariservices/safari-web-extensions)

Receipt detection is conservative: bare `$` totals, ambiguous totals, pending checkouts, order-history lists, and unsupported layouts are skipped. It cannot reliably distinguish a new confirmation from an older individual receipt opened for the first time, so enable it before new purchases and review the ledger. Reloading an already recorded order does not subtract it twice. An unavailable server produces an error in the extension; use **Check this page** to retry. Recorded purchases can make the tracked balance negative; Pocket does not authorize or block spending. Manually entered purchases can include a note describing the items. Automatic captures include the store and total; the extension does not infer an itemized receipt.

No Safari payment API reports every purchase across all websites. This extension records recognizable page content; it does not prove payment or modify a payment. Keep manual entry available for unsupported purchases.

## Notifications

The server always saves recipient-specific inbox entries, regardless of push configuration. They appear when the app syncs. An app that is closed needs Apple Push Notification service (APNs) for system alerts; an inbox entry alone does not produce a remote notification.

Optional APNs setup requires an Apple Developer Program team:

1. Enable Push Notifications for your App ID and Xcode target. Set **Code Signing Entitlements** (`CODE_SIGN_ENTITLEMENTS`) to `PocketFamily/Push.entitlements` for development signing.
2. Create a sandbox-capable APNs signing key in your Apple developer account. Keep the `.p8` key on the server, outside this repository.
3. In the server's `.env`, set `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC` (the app's exact bundle identifier, not the Safari extension's), then restart it. See [server settings](server/README.md).
4. Rebuild on each device, sign in, and allow notifications in the app. Development-signed builds must use the APNs sandbox environment.

The server must be running and able to reach Apple to send pushes. iOS permission, Focus settings, and network availability can affect presentation. See [APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns) and [token-based APNs authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

## Verification

From the project root:

```powershell
node --test server/tests/*.test.mjs PocketSafari/tests/*.test.cjs tests/*.test.mjs
```

The checks cover server authorization and recipient routing, duplicate purchases, the receipt detector, browser-message boundaries, and DOM handling. Native compilation and Safari runtime behavior are **not verified on this Windows host**. Build the **Pocket** scheme in Xcode on a Mac, then check one parent and two separate child accounts to confirm that only the parent and the child involved receive each change.

The server stores the family in `server/data/pocket.sqlite`. Keep the data folder when restarting; back it up with the server stopped. Local data, `.env` files, Apple keys, and Xcode user state are excluded from Git.
