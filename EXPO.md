# Pocket with Expo

Pocket's Expo SDK 58 client lives in [`mobile/`](mobile). It uses the same API and SQLite database as the original SwiftUI app. The original [`PocketFamily/`](PocketFamily), [`PocketFamily.xcodeproj`](PocketFamily.xcodeproj), and [`PocketSafari/`](PocketSafari) sources remain available.

## Run from Windows without a paid Apple account

Use Expo Go for the family tracker now. Update the iPhone app to a release supporting SDK 58; the [App Store version history](https://apps.apple.com/us/app/expo-go/id982107779) lists SDK 58 support in version 58.0.5. Install Node.js 22.13 or newer, then run:

```powershell
Set-Location 'C:\Users\Alexander Bagwell\source\pocket-family\mobile'
npm ci
npx expo login
npm start
```

Sign in to Expo Go with the same free Expo account as the CLI and scan the QR code using the iPhone Camera. Keep the terminal running. A Mac and paid Apple Developer membership are not required for this route. [Expo's instructions](https://docs.expo.dev/get-started/start-developing/) cover device connection and account matching.

## Keep your existing family and server

Enter your existing Pocket API address in the app, then use your current Pocket username and password. This changes the client, not the accounts or database. Do not delete `data/`, create a replacement database, or run first-family setup to try the Expo app. If a previously configured family appears missing, check the API address and the server's `DB_PATH` before proceeding.

For a server on your PC, use its LAN IP address, for example `http://192.168.1.20:8787`. The phone and PC must share the network, the API must bind to a reachable address, and the firewall must allow that local connection. `127.0.0.1` on the phone does not reach the PC. Allow Expo Go local network access when prompted. An existing hosted API should keep its HTTPS address.

`npm start -- --tunnel` can help the phone load Metro's JavaScript bundle. It does not publish or tunnel Pocket's API. Keep your current server deployment and database volume: local Docker/Compose files from an earlier deployment are not included in this Git checkout. The [server reference](server/README.md) documents its settings; run commands from the actual `server/` directory in this checkout if starting it locally.

## Features and limits

| Feature | Expo Go | Custom native build |
| --- | --- | --- |
| Family accounts, balances, additions, purchases | Available | Available |
| Private inbox for parents and the affected child | Available while using the app | Available while using the app |
| Native Liquid Glass | Supported iOS 26+ devices | Supported iOS 26+ devices |
| Safari receipt capture | Unavailable | Requires the bundled and signed extension |
| Remote device push | Unavailable | Requires notification integration, signing, and a configured provider |

The server enforces the recipient rule: each parent and the affected child receive the activity; siblings do not. The Expo inbox refreshes on foreground and while signed in with the app active. It does not create a lock-screen notification while the app is closed. [Expo Go has a fixed native binary and does not support remote push](https://docs.expo.dev/develop/development-builds/faq/).

The UI uses [Expo's native Liquid Glass component](https://docs.expo.dev/versions/v58.0.0/sdk/glass-effect/) on supported iOS 26+ devices, with fallback rendering where it is unavailable.

## Safari and custom builds

The config plugin [`mobile/plugins/withPocketSafari.cjs`](mobile/plugins/withPocketSafari.cjs) adds the existing native Safari handler and web extension resources to a generated iOS project. The extension signs in separately as a child, requires enabling each website, and records only recognizable USD confirmation pages with an order reference and clear total. It cannot see every Apple Pay or Stripe Link purchase. Expo Go cannot load this additional native target; [Expo app extensions require a custom build](https://docs.expo.dev/build-reference/app-extensions/).

The GitHub workflow [Build Expo iPhone IPA](.github/workflows/build-expo-ios.yml) builds on a hosted Mac. Its `Pocket-Expo-unsigned-IPA` artifact contains `Pocket-Expo-unsigned.ipa`, including the Safari extension. This build requires no EAS or Apple signing credentials, but the output is **unsigned**. It must be signed and provisioned, including its extension, before installation. Developer Mode alone does not install an unsigned IPA. Follow the [Windows signing steps](WINDOWS-INSTALL.md#sign-and-install), selecting `Pocket-Expo-unsigned.ipa` from this workflow instead of the legacy SwiftUI IPA. Device installation still needs verification.

EAS can instead produce a signed custom development or preview build from Windows. Physical iPhone builds through EAS require paid Apple Developer membership and provisioning; internal ad hoc builds include only registered devices. A free Expo account does not supply Apple membership. See [Apple signing requirements](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/) and [internal distribution](https://docs.expo.dev/build/internal-distribution/). Expo Go remains the immediate route if you do not have that membership.

For an installed development client, run `npm run start:dev` from `mobile/`. Native configuration or extension changes require rebuilding that client.

## Adding device push later

Remote push is not implemented in the Expo client. A custom build would need notification permission, device registration, the notification config plugin and entitlement, and server credentials. The existing backend accepts native APNs device tokens, so that integration should use `getDevicePushTokenAsync()` rather than sending an Expo push token to `/devices`. [Expo documents direct APNs delivery](https://docs.expo.dev/push-notifications/sending-notifications-custom/).

The current backend sends to Apple's sandbox. Match the provider environment to the installed app's signed `aps-environment` entitlement; an EAS profile named `development` does not itself guarantee a sandbox token. Apple describes these environments in the [push entitlement reference](https://developer.apple.com/documentation/BundleResources/Entitlements/aps-environment). Keep provider keys on the server and preserve the existing parent/child recipient checks.
