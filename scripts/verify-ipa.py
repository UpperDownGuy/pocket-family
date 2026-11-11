"""Validate the packaged iPhone app, embedded Safari extension, and receipt resources."""
from __future__ import annotations

import argparse
import json
import plistlib
import re
import stat
import struct
from pathlib import Path, PurePosixPath
from zipfile import ZipFile


class IPAError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise IPAError(message)


def device_executable(data: bytes, label: str) -> None:
    require(len(data) >= 32, f"{label}: executable is missing or truncated")
    magic, cpu, _, filetype, ncmds, sizeofcmds, _, _ = struct.unpack_from('<8I', data)
    require(magic == 0xFEEDFACF and cpu == 0x0100000C and filetype == 2,
            f"{label}: expected a thin arm64 Mach-O executable")
    require(sizeofcmds <= len(data) - 32 and ncmds <= sizeofcmds // 8,
            f"{label}: invalid Mach-O load commands")
    offset = 32
    platforms = []
    for _ in range(ncmds):
        require(offset + 8 <= 32 + sizeofcmds, f"{label}: truncated load command")
        command, size = struct.unpack_from('<2I', data, offset)
        require(size >= 8 and offset + size <= 32 + sizeofcmds, f"{label}: invalid load command size")
        if command == 0x32:  # LC_BUILD_VERSION, including platform (2=iOS, 7=iOS Simulator).
            require(size >= 24, f"{label}: truncated platform command")
            platform, minimum = struct.unpack_from('<2I', data, offset + 8)
            platforms.append(platform)
            require(minimum >= (26 << 16), f"{label}: expected iOS 26+ deployment")
        offset += size
    require(platforms == [2], f"{label}: binary must target an iPhone, not a simulator")


def validate_ipa(path: Path) -> dict:
    with ZipFile(path) as archive:
        infos = archive.infolist()
        names = [info.filename for info in infos]
        require(len(set(names)) == len(names), 'IPA contains duplicate archive paths')
        for info in infos:
            name = PurePosixPath(info.filename)
            require(not name.is_absolute() and '..' not in name.parts and '\\' not in info.filename,
                    'IPA contains an unsafe archive path')
            require(name.parts and name.parts[0] == 'Payload', 'IPA contains files outside Payload')
            if stat.S_ISLNK(info.external_attr >> 16):
                target = PurePosixPath(archive.read(info).decode('utf-8'))
                require(not target.is_absolute() and '..' not in target.parts, 'IPA contains an escaping symlink')
        files = {info.filename for info in infos if not info.is_dir()}
        root = 'Payload/Pocket.app/'
        extension = root + 'PlugIns/PocketSafari.appex/'

        def read(name: str) -> bytes:
            require(name in files, f'Missing IPA file: {name}')
            return archive.read(name)

        def bundle(prefix: str, package_type: str) -> dict:
            info = plistlib.loads(read(prefix + 'Info.plist'))
            require(info.get('CFBundlePackageType') == package_type, f'{prefix}: wrong bundle type')
            require(info.get('DTPlatformName') == 'iphoneos', f'{prefix}: not built for iphoneos')
            require(info.get('CFBundleSupportedPlatforms') == ['iPhoneOS'], f'{prefix}: wrong supported platform')
            minimum = str(info.get('MinimumOSVersion', ''))
            require(re.fullmatch(r'26\.0(?:\.0)?', minimum) is not None, f'{prefix}: minimum iOS must remain 26.0')
            executable = info.get('CFBundleExecutable', '')
            require(re.fullmatch(r'[A-Za-z0-9_-]+', executable) is not None, f'{prefix}: invalid executable name')
            bundle_id = info.get('CFBundleIdentifier', '')
            require(re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', bundle_id) is not None,
                    f'{prefix}: unresolved or invalid bundle identifier')
            device_executable(read(prefix + executable), prefix + executable)
            return info

        app = bundle(root, 'APPL')
        safari = bundle(extension, 'XPC!')
        require(safari['CFBundleIdentifier'].startswith(app['CFBundleIdentifier'] + '.'),
                'Safari extension identifier must be prefixed by the app identifier')
        require(safari.get('CFBundleVersion') == app.get('CFBundleVersion'), 'App and extension build numbers differ')
        require(safari.get('CFBundleShortVersionString') == app.get('CFBundleShortVersionString'),
                'App and extension marketing versions differ')
        config = safari.get('NSExtension', {})
        require(config.get('NSExtensionPointIdentifier') == 'com.apple.Safari.web-extension', 'Wrong Safari extension point')
        require(config.get('NSExtensionPrincipalClass') == 'PocketSafari.SafariWebExtensionHandler',
                'Safari handler class is unresolved or incorrect')
        manifest = json.loads(read(extension + 'manifest.json'))
        require(manifest.get('manifest_version') == 3, 'Missing Manifest V3 extension')
        require('nativeMessaging' in manifest.get('permissions', []), 'Safari native bridge permission is missing')
        resources = set()

        def resource(value):
            if isinstance(value, dict):
                for item in value.values(): resource(item)
            elif isinstance(value, str):
                require(value and not PurePosixPath(value).is_absolute() and '..' not in PurePosixPath(value).parts and ':' not in value,
                        'Invalid extension resource path')
                resources.add(value)

        resource(manifest.get('background', {}).get('service_worker'))
        resource(manifest.get('icons', {}))
        action = manifest.get('action', {})
        resource(action.get('default_popup'))
        resource(action.get('default_icon'))
        for content in manifest.get('content_scripts', []):
            for filename in content.get('js', []) + content.get('css', []): resource(filename)
        require({'background.js', 'content.js', 'detector.js', 'popup.html'} <= resources,
                'Receipt capture scripts are missing from the extension manifest')
        for filename in list(resources):
            data = read(extension + filename)
            if filename.endswith('.html'):
                for linked in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', data.decode('utf-8')):
                    resource(linked)
        for filename in resources: read(extension + filename)
        require(not any(name.endswith(('.swift', '.p8', '.p12', '.sqlite', '.sqlite-wal')) for name in files),
                'IPA unexpectedly contains source code, private keys, or server data')
        return {'app': app['CFBundleIdentifier'], 'extension': safari['CFBundleIdentifier'],
                'platform': 'iphoneos', 'architecture': 'arm64', 'resourceCount': len(resources)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa', type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(validate_ipa(args.ipa), indent=2))
    except (IPAError, ValueError, KeyError, OSError) as error:
        parser.exit(1, f'IPA validation failed: {error}\n')
