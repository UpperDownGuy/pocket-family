#!/bin/bash
# Generates the native Expo app on macOS, then packages an unsigned device IPA.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This build needs macOS with Xcode. Run Build Expo iPhone IPA in GitHub Actions from Windows." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pocket-expo-ios.XXXXXX")"
OUTPUT_DIR="${POCKET_OUTPUT_DIR:-$WORK_DIR/output}"
if [ -e "$OUTPUT_DIR" ]; then
  echo "Output path already exists; choose a fresh POCKET_OUTPUT_DIR: $OUTPUT_DIR" >&2
  exit 1
fi
mkdir -p "$OUTPUT_DIR/diagnostics"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
export OUTPUT_DIR
DIAGNOSTICS="$OUTPUT_DIR/diagnostics"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'output_dir=%s\n' "$OUTPUT_DIR" >> "$GITHUB_OUTPUT"
fi

# Select an installed stable Xcode instead of relying on a moving runner default.
DEVELOPER_DIR="$(python3 - <<'PY'
from pathlib import Path
import os, re, subprocess, sys
candidates = {}
for app in Path('/Applications').glob('Xcode*.app'):
    if re.search(r'beta|candidate|\brc\b', app.name + ' ' + app.resolve().name, re.I):
        continue
    developer = app.resolve() / 'Contents/Developer'
    if developer in candidates:
        continue
    try:
        result = subprocess.run(['/usr/bin/xcodebuild', '-version'], env={**os.environ, 'DEVELOPER_DIR': str(developer)}, text=True, capture_output=True, check=True)
        match = re.search(r'^Xcode (\d+(?:\.\d+)*)$', result.stdout, re.M)
        if match:
            version = tuple(map(int, match.group(1).split('.')))
            if version[0] >= 26:
                candidates[developer] = version
    except subprocess.CalledProcessError:
        pass
if not candidates:
    sys.exit('No stable Xcode 26 or newer was found in /Applications.')
print(max(candidates, key=candidates.get))
PY
)"
export DEVELOPER_DIR
export CI=1 EXPO_NO_TELEMETRY=1
export NODE_BINARY="$(command -v node)"
# Release must contain its JS bundle, even if the caller previously ran a development build.
unset SKIP_BUNDLING
xcodebuild -version | tee "$DIAGNOSTICS/xcode-version.txt"
xcrun --sdk iphoneos --show-sdk-version | tee "$DIAGNOSTICS/ios-sdk-version.txt"

cd "$ROOT/mobile"
test -d node_modules/expo
# This is CNG: the config plugin creates PocketSafari from the shared native sources.
npx --no-install expo prebuild --platform ios --no-install --skip-dependency-update react,react-native \
  2>&1 | tee "$DIAGNOSTICS/prebuild.log"
python3 - <<'PY' | tee "$DIAGNOSTICS/icon-appearances.txt"
from pathlib import Path
import json, struct
catalog = Path('ios/Pocket/Images.xcassets/AppIcon.appiconset')
entries = json.loads((catalog / 'Contents.json').read_text())['images']
appearances = set()
for entry in entries:
    appearance = entry.get('appearances', [{'value': 'light'}])[0]['value']
    if appearance not in {'light', 'dark', 'tinted'}:
        continue
    data = (catalog / entry['filename']).read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', data[16:24]) != (1024, 1024):
        raise SystemExit(f'Invalid {appearance} app icon')
    appearances.add(appearance)
if appearances != {'light', 'dark', 'tinted'}:
    raise SystemExit('Missing iOS Home Screen icon appearance')
print('Validated light, dark, and tinted Home Screen icons.')
PY
(
  cd ios
  pod install 2>&1 | tee "$DIAGNOSTICS/pod-install.log"
)

# Use the CocoaPods workspace and build arm64 device code, including the embedded extension.
xcodebuild \
  -workspace "$ROOT/mobile/ios/Pocket.xcworkspace" \
  -scheme Pocket \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$WORK_DIR/DerivedData" \
  -resultBundlePath "$DIAGNOSTICS/Pocket-Expo.xcresult" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  CODE_SIGN_ENTITLEMENTS= \
  DEVELOPMENT_TEAM= \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=NO \
  COMPILER_INDEX_STORE_ENABLE=NO \
  build 2>&1 | tee "$DIAGNOSTICS/xcodebuild.log"

APP="$WORK_DIR/DerivedData/Build/Products/Release-iphoneos/Pocket.app"
test -d "$APP/PlugIns/PocketSafari.appex"
test -s "$APP/main.jsbundle"
mkdir -p "$WORK_DIR/package/Payload"
/usr/bin/ditto "$APP" "$WORK_DIR/package/Payload/Pocket.app"
(
  cd "$WORK_DIR/package"
  /usr/bin/zip -q -r -y "$OUTPUT_DIR/Pocket-Expo-unsigned.ipa" Payload
)

# Publication only occurs after the shared device/extension/resource validator succeeds.
python3 "$ROOT/scripts/verify-ipa.py" "$OUTPUT_DIR/Pocket-Expo-unsigned.ipa" \
  | tee "$DIAGNOSTICS/ipa-validation.txt"

python3 - <<'PY'
from pathlib import Path
import datetime, hashlib, json, os, subprocess
output = Path(os.environ['OUTPUT_DIR'])
ipa = output / 'Pocket-Expo-unsigned.ipa'
with ipa.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
(output / 'Pocket-Expo-unsigned.ipa.sha256').write_text(f'{digest}  {ipa.name}\n')
commit = os.environ.get('GITHUB_SHA')
if not commit:
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True)
    commit = result.stdout.strip() if result.returncode == 0 else None
package = json.loads(Path('package.json').read_text())
metadata = {
    'app': 'Pocket', 'implementation': 'Expo', 'signed': False,
    'platform': 'iphoneos', 'architecture': 'arm64', 'configuration': 'Release',
    'includesSafariExtension': True, 'includesJavaScriptBundle': True,
    'iconAppearances': ['light', 'dark', 'tinted'],
    'minimumIOS': '26.0', 'commit': commit,
    'expo': package['dependencies']['expo'], 'reactNative': package['dependencies']['react-native'],
    'builtAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
    'sdk': subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-version'], text=True).strip(),
    'sha256': digest,
}
(output / 'build-info.json').write_text(json.dumps(metadata, indent=2) + '\n')
PY

cat > "$OUTPUT_DIR/INSTALL-WINDOWS.txt" <<'INSTALL'
POCKET EXPO — WINDOWS INSTALLATION

This is an unsigned standalone iPhone app with its JavaScript bundled inside.
It does not require Expo Go or a running Metro development server after installation.

1. Download Sideloadly from https://sideloadly.io/ and follow its Windows prerequisites.
2. Connect and trust your iPhone. Enable Developer Mode; iOS 26+ is required.
3. Select Pocket-Expo-unsigned.ipa and sign it with your own Apple account.
4. Keep the embedded PocketSafari extension when signing. Do not remove app extensions.
5. Install, trust the developer profile if requested, and open Pocket.
6. Enter the URL of your running family server. Localhost on a phone refers to the phone.
7. For browser capture, enable Pocket in Settings > Apps > Safari > Extensions.
   Sign in separately as the child in the extension and enable each store you want to watch.

The extension reads supported order confirmations; it does not access Apple Pay events,
collect card details, or capture every checkout. Family activity is visible in the app inbox.
This build does not add background push notifications or APNs entitlements.

Free Apple-account signatures normally require renewal every seven days. Signing and
extension support depend on your account and sideloading tool. No Apple credentials,
certificates, or provisioning profiles were needed for this cloud build.

Use the same Apple account and bundle identifiers on updates. The server database stays
on your server and is never packaged in this app. See EXPO.md in the repository for details.
INSTALL
printf 'Validated Expo IPA: %s\n' "$OUTPUT_DIR/Pocket-Expo-unsigned.ipa"
