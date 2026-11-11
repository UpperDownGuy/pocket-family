"""Exercise rejection of incomplete and wrong-platform IPA packages without Xcode."""
import importlib.util
import json
import plistlib
import struct
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

script = Path(__file__).resolve().parents[1] / 'scripts/verify-ipa.py'
spec = importlib.util.spec_from_file_location('verify_ipa', script)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def binary(platform=2):
    return struct.pack('<8I', 0xFEEDFACF, 0x0100000C, 0, 2, 1, 24, 0, 0) + struct.pack('<6I', 0x32, 24, platform, 26 << 16, 26 << 16, 0)


class PackageTests(unittest.TestCase):
    def fixture(self, **options):
        root = 'Payload/Pocket.app/'
        ext = root + 'PlugIns/PocketSafari.appex/'
        base = {'DTPlatformName': 'iphoneos', 'CFBundleSupportedPlatforms': ['iPhoneOS'],
                'MinimumOSVersion': '26.0', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0'}
        app = {**base, 'CFBundlePackageType': 'APPL', 'CFBundleExecutable': 'Pocket', 'CFBundleIdentifier': 'com.example.PocketFamily'}
        safari = {**base, 'CFBundlePackageType': 'XPC!', 'CFBundleExecutable': 'PocketSafari',
                  'CFBundleIdentifier': options.get('extension_id', 'com.example.PocketFamily.Safari'),
                  'NSExtension': {'NSExtensionPointIdentifier': 'com.apple.Safari.web-extension',
                                  'NSExtensionPrincipalClass': 'PocketSafari.SafariWebExtensionHandler'}}
        manifest = {'manifest_version': 3, 'permissions': ['nativeMessaging'],
                    'background': {'service_worker': 'background.js'}, 'icons': {'512': 'icon.svg'},
                    'action': {'default_popup': 'popup.html'}, 'content_scripts': [{'js': ['detector.js', 'content.js']}]}
        contents = {root+'Info.plist': plistlib.dumps(app), root+'Pocket': binary(options.get('platform', 2)),
                    ext+'Info.plist': plistlib.dumps(safari), ext+'PocketSafari': binary(),
                    ext+'manifest.json': json.dumps(manifest).encode(), ext+'popup.html': b'<script src="popup.js"></script><link href="popup.css">'}
        for name in ['background.js', 'content.js', 'detector.js', 'popup.js', 'popup.css', 'icon.svg']:
            contents[ext+name] = b'fixture'
        if options.get('missing'): contents.pop(ext+options['missing'])
        if options.get('unsafe'): contents['Payload/../../escaped'] = b'bad'
        return contents

    def validate(self, contents):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'test.ipa'
            with ZipFile(path, 'w') as archive:
                for name, data in contents.items(): archive.writestr(name, data)
            return validator.validate_ipa(path)

    def test_complete_device_package(self):
        self.assertEqual(self.validate(self.fixture())['architecture'], 'arm64')

    def test_arm64_simulator_is_not_a_device_build(self):
        with self.assertRaisesRegex(validator.IPAError, 'not a simulator'):
            self.validate(self.fixture(platform=7))

    def test_extension_and_popup_resources_must_be_embedded(self):
        for missing in ['PocketSafari', 'detector.js', 'popup.css']:
            with self.subTest(missing=missing), self.assertRaisesRegex(validator.IPAError, 'Missing IPA file'):
                self.validate(self.fixture(missing=missing))

    def test_extension_identifier_and_archive_paths_are_checked(self):
        with self.assertRaisesRegex(validator.IPAError, 'prefixed'):
            self.validate(self.fixture(extension_id='com.other.Safari'))
        with self.assertRaisesRegex(validator.IPAError, 'unsafe archive path'):
            self.validate(self.fixture(unsafe=True))

    def test_text_placeholder_cannot_pass_as_executable(self):
        files = self.fixture()
        files['Payload/Pocket.app/Pocket'] = b'not compiled'
        with self.assertRaisesRegex(validator.IPAError, 'truncated'):
            self.validate(files)


if __name__ == '__main__':
    unittest.main()
