# Install Pocket from Windows

Pocket's cloud build compiles the iPhone app and its Safari extension into **Pocket-unsigned.ipa**. You sign that file on your Windows PC before installing it. No Apple password, certificate, or private key is needed in GitHub.

## Download the IPA

1. Open the [public Pocket repository](https://github.com/UpperDownGuy/pocket-family). Sign in to GitHub to download workflow artifacts.
2. Open [Actions → Build iPhone IPA](https://github.com/UpperDownGuy/pocket-family/actions/workflows/build-ios.yml).
3. Open the latest successful run. Under **Artifacts**, download the Pocket IPA artifact and extract its ZIP.
4. Use **Pocket-unsigned.ipa** from the extracted folder. Do not give Sideloadly GitHub's outer ZIP or the source-code ZIP.

With repository write access, select **Run workflow**, keep the `main` branch, and start the run to build again. A push to `main` also builds automatically. Build artifacts are retained for 14 days. The repository is public; family records and credentials are stored on your own server and are not included in the source or IPA.

The download includes a SHA-256 checksum and build metadata identifying the source revision and Xcode version. To check the file in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\Pocket-unsigned.ipa'
```

Compare the hash with `Pocket-unsigned.ipa.sha256` in the same download.

## Sign and install

1. Install [Sideloadly for Windows](https://sideloadly.io/) and follow its current Apple device-driver requirements.
2. Connect the iPhone by USB, unlock it, and choose **Trust** if asked. Pocket requires **iOS 26 or later**. Leave Developer Mode enabled.
3. Open Sideloadly, select the phone, and drag **Pocket-unsigned.ipa** into it.
4. Use Apple ID sideloading and enter your Apple account in Sideloadly. **Keep the Safari extension included**: do not enable options that remove extensions or PlugIns. The IPA includes `PocketSafari.appex`.
5. Start the installation. If iOS asks you to trust the developer, use **Settings → General → VPN & Device Management**.
6. Open Pocket. Free-account signing normally expires after seven days; use Sideloadly's refresh feature or re-sign the same app with the same Apple account. Keep the bundle identifier consistent when updating.

The IPA is intentionally unsigned. Tapping it in Files cannot install it, and renaming the source ZIP to `.ipa` will not work. A successful cloud build verifies compilation and packaging; device installation and Safari behavior still need testing on your iPhone.

## Connect your family server

On your Windows PC, start the server from the project's `server` directory:

```powershell
$env:HOST = '0.0.0.0'
npm start
```

In Pocket's **Server settings**, enter that PC's local network address, for example `http://192.168.1.20:8787`. Use your actual address. Both devices must be on the same trusted network, Windows Firewall must allow the connection on the private network, and the PC must remain awake with the server running. `127.0.0.1` on the phone points at the phone, not your PC.

Enter the setup code printed by the server to create the first parent, then add each family member. Existing server data is preserved when you install a new app build.

For Safari capture, enable **Pocket** in **Settings → Apps → Safari → Extensions**. Open the extension in Safari, sign in with the child's account and the same server address, then enable each desired store. The Safari sign-in is separate from the app sign-in.

## Notifications and limits

**With your free Apple account, use Pocket → Inbox.** Parents receive entries for every child's balance change; children receive their own. The Inbox updates when Pocket is open and connected to your family server. It needs no Apple push credentials or notification permission.

**This build does not send lock-screen or background phone alerts.** Developer Mode and the iPhone's notification switch cannot enable native push for a free Personal Team. Apple's native push capability requires a paid Developer Program membership. [Apple's supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios)

If you later get a paid membership, Pocket needs a separate cloud signing/provisioning setup with the correct push entitlement, plus the server's APNs key configuration. The current unsigned workflow explicitly clears the entitlement; changing `.env` or app settings alone is not sufficient. See the [complete notification setup](README.md#notifications). Even with APNs configured, the current app refreshes its Inbox silently while in the foreground.

The extension logs clear USD confirmation pages on enabled sites. It does not read card details, Apple's payment sheet, or all Link purchases. Check the app's Activity after checkout. App and Safari tests on the physical phone remain necessary.

If a cloud build fails, open its **Build device IPA** step or download its diagnostics artifact. No IPA artifact is published when compilation or package validation fails.
