const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withXcodeProject } = require('expo/config-plugins');

const TARGET = 'PocketSafari';
const RESOURCE_NAMES = [
  'manifest.json', 'background.js', 'content.js', 'detector.js',
  'popup.html', 'popup.js', 'popup.css', 'icon.svg',
];
const unquote = (value) => typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
const id = (name) => crypto.createHash('sha256').update(`PocketSafari.config-plugin.v1:${name}`).digest('hex').slice(0, 24).toUpperCase();
const ref = (value, comment) => ({ value, comment });

function optionsFor(config, options = {}) {
  const appIdentifier = config.ios?.bundleIdentifier;
  const bundleIdentifier = options.bundleIdentifier || `${appIdentifier}.Safari`;
  if (!appIdentifier || !bundleIdentifier.startsWith(`${appIdentifier}.`) ||
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleIdentifier)) {
    throw new Error('Pocket Safari needs ios.bundleIdentifier and an extension identifier prefixed by it.');
  }
  const deploymentTarget = options.deploymentTarget || '26.0';
  if (!/^\d+\.\d+$/.test(deploymentTarget) || Number(deploymentTarget) < 26) {
    throw new Error('Pocket Safari requires an iOS deployment target of 26.0 or newer.');
  }
  return {
    sourceDirectory: options.sourceDirectory || '../PocketSafari',
    bundleIdentifier,
    deploymentTarget,
    version: config.version || '1.0.0',
    buildNumber: config.ios?.buildNumber || '1',
    appleTeamId: config.ios?.appleTeamId,
  };
}

function declareExtension(config, options) {
  const extra = config.extra || {};
  const eas = extra.eas || {};
  const build = eas.build || {};
  const experimental = build.experimental || {};
  const ios = experimental.ios || {};
  const extensions = (ios.appExtensions || []).filter((item) => item.targetName !== TARGET);
  extensions.push({ targetName: TARGET, bundleIdentifier: options.bundleIdentifier, entitlements: {} });
  config.extra = { ...extra, eas: { ...eas, build: { ...build, experimental: {
    ...experimental, ios: { ...ios, appExtensions: extensions },
  } } } };
  return config;
}

function extensionInfo() {
  // Use build settings for versions so the containing app and extension stay aligned.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Pocket for Safari</string>
  <key>CFBundleExecutable</key><string>$(EXECUTABLE_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundlePackageType</key><string>XPC!</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>NSLocalNetworkUsageDescription</key><string>Connect to your family's Pocket server.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSExtension</key><dict>
    <key>NSExtensionPointIdentifier</key><string>com.apple.Safari.web-extension</string>
    <key>NSExtensionPrincipalClass</key><string>$(PRODUCT_MODULE_NAME).SafariWebExtensionHandler</string>
  </dict>
</dict></plist>
`;
}

function installFiles(projectRoot, nativeRoot, options) {
  const source = path.resolve(projectRoot, options.sourceDirectory);
  const destination = path.join(nativeRoot, TARGET);
  const sourceFiles = ['SafariWebExtensionHandler.swift', ...RESOURCE_NAMES.map((name) => `Resources/${name}`)];
  for (const file of sourceFiles) {
    if (!fs.statSync(path.join(source, file), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Pocket Safari source is missing: ${path.join(source, file)}`);
    }
  }
  fs.mkdirSync(path.join(destination, 'Resources'), { recursive: true });
  for (const file of sourceFiles) fs.copyFileSync(path.join(source, file), path.join(destination, file));
  fs.writeFileSync(path.join(destination, 'Info.plist'), extensionInfo());
}

function configureProject(project, options) {
  const objects = project.hash.project.objects;
  const projectEntry = Object.entries(objects.PBXProject).find(([, value]) => value && typeof value === 'object');
  if (!projectEntry) throw new Error('Pocket Safari could not find the generated Xcode project.');
  const [projectId, projectObject] = projectEntry;
  const applicationEntry = Object.entries(objects.PBXNativeTarget).find(([, value]) => value && typeof value === 'object' &&
    unquote(value.productType) === 'com.apple.product-type.application');
  if (!applicationEntry) throw new Error('Pocket Safari needs a containing iPhone application target.');
  const [applicationId, application] = applicationEntry;
  const targetId = id('target');
  const conflict = Object.entries(objects.PBXNativeTarget).find(([uuid, value]) => uuid !== targetId && value &&
    typeof value === 'object' && unquote(value.name) === TARGET);
  if (conflict) throw new Error('A PocketSafari target already exists outside this plugin. Run a clean Expo prebuild.');

  function put(section, key, value, comment) {
    objects[section] ||= {};
    objects[section][key] = value;
    objects[section][`${key}_comment`] = comment;
    return key;
  }
  function appendOnce(items, key, comment) {
    if (!items.some((item) => (typeof item === 'string' ? item : item.value) === key)) items.push(ref(key, comment));
  }
  function file(name, filename, type) {
    return put('PBXFileReference', id(name), { isa: 'PBXFileReference', lastKnownFileType: type,
      path: JSON.stringify(filename), sourceTree: '"<group>"' }, filename);
  }
  const swift = file('swift', 'SafariWebExtensionHandler.swift', 'sourcecode.swift');
  const plist = file('plist', 'Info.plist', 'text.plist.xml');
  const sourceBuild = put('PBXBuildFile', id('swift-build'), { isa: 'PBXBuildFile', fileRef: swift,
    fileRef_comment: 'SafariWebExtensionHandler.swift' }, 'SafariWebExtensionHandler.swift in Sources');
  const resourceReferences = [];
  const resourceBuilds = [];
  const types = { '.json': 'text.json', '.js': 'sourcecode.javascript', '.html': 'text.html', '.css': 'text.css', '.svg': 'image.svg' };
  for (const filename of RESOURCE_NAMES) {
    const fileId = file(`resource:${filename}`, filename, types[path.extname(filename)]);
    resourceReferences.push(ref(fileId, filename));
    const buildId = put('PBXBuildFile', id(`resource-build:${filename}`), { isa: 'PBXBuildFile',
      fileRef: fileId, fileRef_comment: filename }, `${filename} in Resources`);
    resourceBuilds.push(ref(buildId, `${filename} in Resources`));
  }
  const resourceGroup = put('PBXGroup', id('resources-group'), { isa: 'PBXGroup', children: resourceReferences,
    path: 'Resources', sourceTree: '"<group>"' }, 'Resources');
  const sourceGroup = put('PBXGroup', id('source-group'), { isa: 'PBXGroup', children: [
    ref(swift, 'SafariWebExtensionHandler.swift'), ref(plist, 'Info.plist'), ref(resourceGroup, 'Resources'),
  ], path: TARGET, sourceTree: '"<group>"' }, TARGET);
  appendOnce(objects.PBXGroup[projectObject.mainGroup].children, sourceGroup, TARGET);

  const product = put('PBXFileReference', id('product'), { isa: 'PBXFileReference',
    explicitFileType: '"wrapper.app-extension"', includeInIndex: 0,
    path: `${TARGET}.appex`, sourceTree: 'BUILT_PRODUCTS_DIR' }, `${TARGET}.appex`);
  const productsId = projectObject.productRefGroup;
  if (!productsId || !objects.PBXGroup[productsId]) throw new Error('Generated Xcode project is missing its Products group.');
  appendOnce(objects.PBXGroup[productsId].children, product, `${TARGET}.appex`);
  const phase = (name, isa, files) => put(isa, id(name), { isa, buildActionMask: 2147483647,
    files, runOnlyForDeploymentPostprocessing: 0 }, name);
  const sources = phase('Sources', 'PBXSourcesBuildPhase', [ref(sourceBuild, 'SafariWebExtensionHandler.swift in Sources')]);
  const resources = phase('Resources', 'PBXResourcesBuildPhase', resourceBuilds);
  const frameworks = phase('Frameworks', 'PBXFrameworksBuildPhase', []);

  const configurations = [];
  const appConfigList = objects.XCConfigurationList[application.buildConfigurationList];
  for (const entry of appConfigList.buildConfigurations) {
    const appConfig = objects.XCBuildConfiguration[entry.value];
    const name = unquote(appConfig.name);
    const settings = {
      APPLICATION_EXTENSION_API_ONLY: 'YES', CLANG_ENABLE_MODULES: 'YES', CODE_SIGN_STYLE: 'Automatic',
      CURRENT_PROJECT_VERSION: JSON.stringify(options.buildNumber), MARKETING_VERSION: JSON.stringify(options.version),
      GENERATE_INFOPLIST_FILE: 'NO', INFOPLIST_FILE: '"PocketSafari/Info.plist"',
      IPHONEOS_DEPLOYMENT_TARGET: options.deploymentTarget,
      LD_RUNPATH_SEARCH_PATHS: ['"$(inherited)"', '"@executable_path/Frameworks"', '"@executable_path/../../Frameworks"'],
      PRODUCT_BUNDLE_IDENTIFIER: options.bundleIdentifier, PRODUCT_MODULE_NAME: TARGET, PRODUCT_NAME: TARGET,
      SDKROOT: 'iphoneos', SKIP_INSTALL: 'YES', SUPPORTED_PLATFORMS: '"iphoneos iphonesimulator"',
      SWIFT_VERSION: '5.0', SWIFT_STRICT_CONCURRENCY: 'targeted', TARGETED_DEVICE_FAMILY: '"1,2"',
    };
    if (options.appleTeamId || appConfig.buildSettings.DEVELOPMENT_TEAM) {
      settings.DEVELOPMENT_TEAM = options.appleTeamId || appConfig.buildSettings.DEVELOPMENT_TEAM;
    }
    if (name === 'Debug') settings.SWIFT_OPTIMIZATION_LEVEL = '"-Onone"';
    const configuration = put('XCBuildConfiguration', id(`config:${name}`), { isa: 'XCBuildConfiguration',
      buildSettings: settings, name: appConfig.name }, name);
    configurations.push(ref(configuration, name));
  }
  const configurationList = put('XCConfigurationList', id('configuration-list'), { isa: 'XCConfigurationList',
    buildConfigurations: configurations, defaultConfigurationIsVisible: 0,
    defaultConfigurationName: appConfigList.defaultConfigurationName || 'Release' }, `Build configuration list for ${TARGET}`);
  put('PBXNativeTarget', targetId, { isa: 'PBXNativeTarget', buildConfigurationList: configurationList,
    buildPhases: [ref(sources, 'Sources'), ref(frameworks, 'Frameworks'), ref(resources, 'Resources')],
    buildRules: [], dependencies: [], name: TARGET, productName: TARGET, productReference: product,
    productType: '"com.apple.product-type.app-extension"' }, TARGET);
  appendOnce(projectObject.targets, targetId, TARGET);

  const proxy = put('PBXContainerItemProxy', id('proxy'), { isa: 'PBXContainerItemProxy', containerPortal: projectId,
    proxyType: 1, remoteGlobalIDString: targetId, remoteInfo: TARGET }, 'PBXContainerItemProxy');
  const dependency = put('PBXTargetDependency', id('dependency'), { isa: 'PBXTargetDependency',
    target: targetId, targetProxy: proxy }, 'PBXTargetDependency');
  application.dependencies ||= [];
  appendOnce(application.dependencies, dependency, 'PBXTargetDependency');
  const embedFile = put('PBXBuildFile', id('embed-file'), { isa: 'PBXBuildFile', fileRef: product,
    fileRef_comment: `${TARGET}.appex`, settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] } }, `${TARGET}.appex in Embed App Extensions`);
  const embed = put('PBXCopyFilesBuildPhase', id('embed-phase'), { isa: 'PBXCopyFilesBuildPhase', buildActionMask: 2147483647,
    dstPath: '""', dstSubfolderSpec: 13, files: [ref(embedFile, `${TARGET}.appex in Embed App Extensions`)],
    name: '"Embed App Extensions"', runOnlyForDeploymentPostprocessing: 0 }, 'Embed App Extensions');
  application.buildPhases ||= [];
  appendOnce(application.buildPhases, embed, 'Embed App Extensions');
  projectObject.attributes ||= {};
  projectObject.attributes.TargetAttributes ||= {};
  projectObject.attributes.TargetAttributes[targetId] = { CreatedOnToolsVersion: '26.0', ProvisioningStyle: 'Automatic' };
  // The application is the only scheme entry. Its dependency builds and embeds this extension.
  if (applicationId === targetId) throw new Error('The Safari target cannot be the containing application.');
  return project;
}

function withPocketSafari(config, options = {}) {
  if (options.enabled === false) return config;
  const resolved = optionsFor(config, options);
  declareExtension(config, resolved);
  return withXcodeProject(config, (mod) => {
    installFiles(mod.modRequest.projectRoot, mod.modRequest.platformProjectRoot, resolved);
    mod.modResults = configureProject(mod.modResults, resolved);
    return mod;
  });
}

module.exports = withPocketSafari;
module.exports.optionsFor = optionsFor;
module.exports.declareExtension = declareExtension;
module.exports.configureProject = configureProject;
module.exports.installFiles = installFiles;
