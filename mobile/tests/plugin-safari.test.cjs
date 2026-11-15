const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const xcode = require('xcode');
const plugin = require('../plugins/withPocketSafari.cjs');

const uuid = (character) => character.repeat(24);
function projectFixture() {
  return { hash: { project: { archiveVersion: 1, classes: {}, objectVersion: 56, rootObject: uuid('A'), objects: {
    PBXProject: { [uuid('A')]: { isa: 'PBXProject', mainGroup: uuid('B'), productRefGroup: uuid('C'), targets: [{ value: uuid('D'), comment: 'Pocket' }], attributes: {} } },
    PBXGroup: {
      [uuid('B')]: { isa: 'PBXGroup', children: [{ value: uuid('C'), comment: 'Products' }], sourceTree: '"<group>"' },
      [uuid('C')]: { isa: 'PBXGroup', children: [], name: 'Products', sourceTree: '"<group>"' },
    },
    PBXNativeTarget: { [uuid('D')]: { isa: 'PBXNativeTarget', name: 'Pocket', productType: '"com.apple.product-type.application"', buildConfigurationList: uuid('E'), buildPhases: [], dependencies: [] } },
    XCConfigurationList: { [uuid('E')]: { isa: 'XCConfigurationList', buildConfigurations: [{ value: uuid('F'), comment: 'Debug' }, { value: uuid('1'), comment: 'Release' }], defaultConfigurationName: 'Release' } },
    XCBuildConfiguration: {
      [uuid('F')]: { isa: 'XCBuildConfiguration', name: 'Debug', buildSettings: { DEVELOPMENT_TEAM: 'TEAM123456' } },
      [uuid('1')]: { isa: 'XCBuildConfiguration', name: 'Release', buildSettings: { DEVELOPMENT_TEAM: 'TEAM123456' } },
    },
  } } } };
}
const options = plugin.optionsFor({ ios: { bundleIdentifier: 'com.example.PocketFamily', buildNumber: '7' }, version: '1.2.3' });
const entries = (section) => Object.entries(section).filter(([, value]) => value && typeof value === 'object');

test('prebuild creates one embedded Safari target, with resource files at bundle root', () => {
  const project = plugin.configureProject(projectFixture(), options);
  const objects = project.hash.project.objects;
  const targets = entries(objects.PBXNativeTarget);
  assert.equal(targets.length, 2);
  const [safariId, safari] = targets.find(([, value]) => value.name === 'PocketSafari');
  assert.equal(safari.productType, '"com.apple.product-type.app-extension"');
  const settings = entries(objects.XCBuildConfiguration).filter(([, value]) => value.buildSettings.PRODUCT_NAME === 'PocketSafari');
  assert.equal(settings.length, 2);
  for (const [, configuration] of settings) {
    assert.equal(configuration.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, 'com.example.PocketFamily.Safari');
    assert.equal(configuration.buildSettings.DEVELOPMENT_TEAM, 'TEAM123456');
    assert.equal(configuration.buildSettings.CURRENT_PROJECT_VERSION, '"7"');
    assert.equal(configuration.buildSettings.MARKETING_VERSION, '"1.2.3"');
    assert.equal(configuration.buildSettings.SKIP_INSTALL, 'YES');
  }
  const phase = entries(objects.PBXResourcesBuildPhase)[0][1];
  assert.equal(phase.files.length, 8);
  for (const resource of phase.files) {
    const file = objects.PBXFileReference[objects.PBXBuildFile[resource.value].fileRef];
    assert.notEqual(file.lastKnownFileType, 'folder');
    assert.ok(!file.path.includes('/'));
  }
  const embed = entries(objects.PBXCopyFilesBuildPhase)[0];
  assert.equal(embed[1].dstSubfolderSpec, 13);
  assert.ok(objects.PBXNativeTarget[uuid('D')].buildPhases.some((item) => item.value === embed[0]));
  assert.ok(entries(objects.PBXTargetDependency).some(([, value]) => value.target === safariId));
});

test('repeated prebuild is idempotent, serializes, and preserves unrelated app settings', () => {
  const project = plugin.configureProject(projectFixture(), options);
  const before = JSON.stringify(project.hash);
  plugin.configureProject(project, options);
  assert.equal(JSON.stringify(project.hash), before);
  const writable = xcode.project('unused.pbxproj');
  writable.hash = project.hash;
  const serialized = writable.writeSync();
  assert.match(serialized, /com\.example\.PocketFamily\.Safari/);
  assert.match(serialized, /Embed App Extensions/);
  assert.equal(project.hash.project.objects.XCBuildConfiguration[uuid('F')].buildSettings.DEVELOPMENT_TEAM, 'TEAM123456');
});

test('EAS extension declaration is available before native generation without losing project metadata', () => {
  const config = { extra: { feature: true, eas: { projectId: 'kept', build: { experimental: { ios: { appExtensions: [
    { targetName: 'OtherExtension', bundleIdentifier: 'com.example.PocketFamily.Other' },
  ] } } } } } };
  plugin.declareExtension(config, options);
  plugin.declareExtension(config, options);
  assert.equal(config.extra.feature, true);
  assert.equal(config.extra.eas.projectId, 'kept');
  assert.equal(config.extra.eas.build.experimental.ios.appExtensions.length, 2);
  assert.deepEqual(config.extra.eas.build.experimental.ios.appExtensions[1], {
    targetName: 'PocketSafari', bundleIdentifier: 'com.example.PocketFamily.Safari', entitlements: {},
  });
});

test('extension source copy includes the existing native handler and all browser resources, not tests', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-safari-plugin-'));
  const source = path.resolve(__dirname, '../../PocketSafari');
  try {
    plugin.installFiles(path.resolve(__dirname, '..'), temporary, { ...options, sourceDirectory: source });
    assert.equal(fs.readFileSync(path.join(temporary, 'PocketSafari/SafariWebExtensionHandler.swift'), 'utf8'),
      fs.readFileSync(path.join(source, 'SafariWebExtensionHandler.swift'), 'utf8'));
    assert.deepEqual(fs.readdirSync(path.join(temporary, 'PocketSafari/Resources')).sort(),
      fs.readdirSync(path.join(source, 'Resources')).sort());
    assert.equal(fs.existsSync(path.join(temporary, 'PocketSafari/tests')), false);
    assert.match(fs.readFileSync(path.join(temporary, 'PocketSafari/Info.plist'), 'utf8'), /\$\(MARKETING_VERSION\)/);
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pocket-safari-plugin-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('invalid bundle and unsupported deployment targets fail before writing a native project', () => {
  assert.throws(() => plugin.optionsFor({ ios: { bundleIdentifier: 'com.example.Pocket' } }, { bundleIdentifier: 'com.other.Extension' }), /prefixed/);
  assert.throws(() => plugin.optionsFor({ ios: { bundleIdentifier: 'com.example.Pocket' } }, { deploymentTarget: '18.0' }), /26.0/);
  const config = { name: 'Pocket' };
  assert.equal(plugin(config, { enabled: false }), config);
});

test('the installed Expo template accepts the extension and survives an Xcode parse/write round trip', () => {
  // Use the real template shipped with the installed SDK, without bypassing Expo's Windows prebuild guard.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-safari-template-'));
  try {
    const template = path.join(path.dirname(require.resolve('expo/package.json')), 'template.tgz');
    const original = execFileSync('tar', ['-xOf', template, 'package/ios/HelloWorld.xcodeproj/project.pbxproj']);
    const projectPath = path.join(temporary, 'project.pbxproj');
    fs.writeFileSync(projectPath, original);
    const project = xcode.project(projectPath);
    project.parseSync();
    plugin.configureProject(project, options);
    fs.writeFileSync(projectPath, project.writeSync());
    const reparsed = xcode.project(projectPath);
    reparsed.parseSync();
    const objects = reparsed.hash.project.objects;
    assert.equal(entries(objects.PBXNativeTarget).length, 2);
    const [appId, app] = entries(objects.PBXNativeTarget).find(([, value]) => value.productType === '"com.apple.product-type.application"');
    const [extensionId, extension] = entries(objects.PBXNativeTarget).find(([, value]) => value.name === 'PocketSafari');
    assert.notEqual(appId, extensionId);
    assert.equal(app.dependencies.length, 1);
    assert.equal(objects.PBXTargetDependency[app.dependencies[0].value].target, extensionId);
    const resourcePhase = extension.buildPhases.map((entry) => objects.PBXResourcesBuildPhase[entry.value]).find(Boolean);
    assert.equal(resourcePhase.files.length, 8);
    const beforeRepeat = reparsed.writeSync();
    plugin.configureProject(reparsed, options);
    assert.equal(reparsed.writeSync(), beforeRepeat);
  } finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep + 'pocket-safari-template-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
