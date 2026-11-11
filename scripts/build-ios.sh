#!/bin/bash
# Build on a macOS host with Xcode 26+. Signing happens on the user's PC.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ "$(uname -s)" != "Darwin" ]; then
  echo "This build needs macOS with Xcode. Run the GitHub Actions workflow from Windows." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/pocket-ios.XXXXXX")"
OUTPUT_DIR="${POCKET_OUTPUT_DIR:-$WORK_DIR/output}"
# A fresh output directory prevents an older IPA from being mistaken for this build.
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

# Select an installed stable Xcode instead of assuming a moving runner default.
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
xcodebuild -version | tee "$DIAGNOSTICS/xcode-version.txt"
xcrun --sdk iphoneos --show-sdk-version | tee "$DIAGNOSTICS/ios-sdk-version.txt"

# Build the actual arm64 iPhone product. Never package a simulator build.
xcodebuild \
  -project "$ROOT/PocketFamily.xcodeproj" \
  -scheme Pocket \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$WORK_DIR/DerivedData" \
  -resultBundlePath "$DIAGNOSTICS/Pocket.xcresult" \
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
mkdir -p "$WORK_DIR/package/Payload"
/usr/bin/ditto "$APP" "$WORK_DIR/package/Payload/Pocket.app"
(
  cd "$WORK_DIR/package"
  /usr/bin/zip -q -r -y "$OUTPUT_DIR/Pocket-unsigned.ipa" Payload
)

# Fail the job before artifact publication if the IPA is incomplete or not iPhone code.
python3 "$ROOT/scripts/verify-ipa.py" "$OUTPUT_DIR/Pocket-unsigned.ipa" \
  | tee "$DIAGNOSTICS/ipa-validation.txt"

python3 - <<'PY'
from pathlib import Path
import datetime, hashlib, json, os, subprocess
output = Path(os.environ['OUTPUT_DIR'])
ipa = output / 'Pocket-unsigned.ipa'
with ipa.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
(output / 'Pocket-unsigned.ipa.sha256').write_text(f'{digest}  {ipa.name}\n')
commit = os.environ.get('GITHUB_SHA')
if not commit:
    result = subprocess.run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True)
    commit = result.stdout.strip() if result.returncode == 0 else None
metadata = {
    'app': 'Pocket', 'signed': False, 'platform': 'iphoneos', 'architecture': 'arm64',
    'includesSafariExtension': True, 'minimumIOS': '26.0', 'commit': commit,
    'builtAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'xcode': subprocess.check_output(['xcodebuild', '-version'], text=True).strip(),
    'sdk': subprocess.check_output(['xcrun', '--sdk', 'iphoneos', '--show-sdk-version'], text=True).strip(),
    'sha256': digest,
}
(output / 'build-info.json').write_text(json.dumps(metadata, indent=2) + '\n')
PY

cat > "$OUTPUT_DIR/INSTALL-WINDOWS.txt" <<'INSTALL'
POCKET — WINDOWS INSTALLATION

This is an unsigned iPhone IPA, not an App Store or TestFlight release.

1. Download Sideloadly from https://sideloadly.io/ and follow its current Windows prerequisites.
2. Connect and trust your iPhone. Developer Mode must be on; iOS 26+ is required.
3. Select Pocket-unsigned.ipa in Sideloadly and sign it using your Apple account.
4. Keep the embedded Safari extension when asked; do not remove app extensions.
5. Install, trust the developer profile if requested, and open Pocket.
6. Set the address of your running family server. On a phone, localhost is the phone itself.
7. Enable Pocket in iPhone Settings > Apps > Safari > Extensions. Sign in as the child inside
   the extension, then enable the individual stores you want it to watch.

Free Apple-account signatures normally need renewal every seven days. This build does not
include APNs signing entitlements; the in-app inbox works, but background push needs a
separate properly provisioned Apple Developer build and server configuration.

The IPA includes both Pocket.app and PlugIns/PocketSafari.appex. Keep both when signing.
For updates, use the same Apple account and bundle identifiers to preserve app data.
Your server database remains on your server and is never included in this IPA.
INSTALL
printf 'Validated IPA: %s\n' "$OUTPUT_DIR/Pocket-unsigned.ipa"
