# Pocket for Expo

The Expo SDK 58 app shares Pocket's existing server, family accounts, balances, and inbox. The original SwiftUI app remains in [`../PocketFamily`](../PocketFamily).

## Open on your iPhone from Windows

Install Node.js 22.13 or newer and update [Expo Go](https://expo.dev/go) on your iPhone to a version supporting SDK 58. In PowerShell:

```powershell
Set-Location 'C:\Users\Alexander Bagwell\source\pocket-family\mobile'
npm ci
npx expo login
npm start
```

Sign in to Expo Go using the same free Expo account as the CLI, then scan the terminal's QR code using the iPhone Camera. Keep the terminal running and connect the computer and phone to the same Wi-Fi. `npm start` targets Expo Go. This route needs neither a Mac nor paid Apple Developer membership. See [Expo's device setup](https://docs.expo.dev/get-started/start-developing/).

In Pocket, enter the address of your **existing Pocket API server**, then sign in with your existing family username and password. Your Expo account only opens the development app; your Pocket account controls access to family data. No family reset or database migration is required.

On a physical iPhone, `localhost` and `127.0.0.1` mean the phone. For a server running on your PC, use its reachable LAN address, such as `http://192.168.1.20:8787`, and allow local network access when asked. The API must listen on that LAN address, and both devices must share the network. Keep using an existing HTTPS server address if you already have one.

If the QR code cannot connect, try:

```powershell
npm start -- --tunnel
```

This tunnels the Metro development bundle only. It does **not** tunnel Pocket's API or make an unreachable server accessible.

## What works in Expo Go

- Separate parent and child accounts, balances, recorded purchases, additions, and family management.
- Inbox entries delivered to all parents and only the child involved. The inbox refreshes when the app becomes active, while it stays open, and after changes.
- Native Liquid Glass on supported iOS 26 or later devices through [Expo GlassEffect](https://docs.expo.dev/versions/v58.0.0/sdk/glass-effect/), with a fallback where unavailable.

**Expo Go cannot contain Pocket's Safari extension or receive Pocket's remote push notifications.** Inbox entries appear inside the app; they are not lock-screen alerts while the app is closed. The Safari extension needs a custom signed native build. See [Expo's limitations](https://docs.expo.dev/develop/development-builds/faq/) and the [build options](../EXPO.md).

## Development

Routes live in `src/app/`. Native configuration belongs in Expo config and config plugins; generated `ios/` files are not maintained by hand.

```powershell
npm run lint
npx tsc --noEmit
npx expo-doctor
```

After installing a custom development client, use `npm run start:dev`. The standalone preview build and Safari packaging are described in [`../EXPO.md`](../EXPO.md).
