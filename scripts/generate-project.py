"""Recreate the small, dependency-free Xcode project. Run from any directory."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
objects = []

def ident(name):
    return hashlib.sha256(name.encode()).hexdigest()[:24].upper()

def q(value):
    return json.dumps(str(value))

def add(name, fields):
    key = ident(name)
    objects.append(f"\t\t{key} = {{ {fields} }};")
    return key

def refs(values):
    return "(" + ", ".join(values) + ("," if values else "") + ")"

def file(name, path, kind):
    return add(name, f"isa = PBXFileReference; lastKnownFileType = {kind}; path = {q(path)}; sourceTree = \"<group>\";")

app_files = sorted(path.name for path in (ROOT / "PocketFamily").glob("*.swift"))
app_refs, app_builds = [], []
for filename in app_files:
    ref = file("app:" + filename, filename, "sourcecode.swift")
    app_refs.append(ref)
    app_builds.append(add("compile:" + filename, f"isa = PBXBuildFile; fileRef = {ref};"))
app_refs += [file("app-plist", "Info.plist", "text.plist.xml"), file("app-push", "Push.entitlements", "text.plist.entitlements")]
assets = file("assets", "Assets.xcassets", "folder.assetcatalog")
app_refs.append(assets)
assets_build = add("assets-build", f"isa = PBXBuildFile; fileRef = {assets};")
app_group = add("app-group", f"isa = PBXGroup; children = {refs(app_refs)}; path = PocketFamily; sourceTree = \"<group>\";")

ext_swift = file("ext-swift", "SafariWebExtensionHandler.swift", "sourcecode.swift")
ext_compile = add("ext-compile", f"isa = PBXBuildFile; fileRef = {ext_swift};")
resource_refs, resource_builds = [], []
for filename in ["manifest.json", "background.js", "content.js", "detector.js", "popup.html", "popup.js", "popup.css", "icon.svg"]:
    kind = {".js": "sourcecode.javascript", ".json": "text.json", ".html": "text.html", ".css": "text.css", ".svg": "image.svg"}[Path(filename).suffix]
    ref = file("resource:" + filename, filename, kind)
    resource_refs.append(ref)
    resource_builds.append(add("bundle:" + filename, f"isa = PBXBuildFile; fileRef = {ref};"))
resources_group = add("resources-group", f"isa = PBXGroup; children = {refs(resource_refs)}; path = Resources; sourceTree = \"<group>\";")
ext_plist = file("ext-plist", "Info.plist", "text.plist.xml")
ext_group = add("ext-group", f"isa = PBXGroup; children = {refs([ext_swift, ext_plist, resources_group])}; path = PocketSafari; sourceTree = \"<group>\";")

app_product = add("app-product", 'isa = PBXFileReference; explicitFileType = wrapper.application; path = Pocket.app; sourceTree = BUILT_PRODUCTS_DIR;')
ext_product = add("ext-product", 'isa = PBXFileReference; explicitFileType = "wrapper.app-extension"; path = PocketSafari.appex; sourceTree = BUILT_PRODUCTS_DIR;')
products = add("products", f"isa = PBXGroup; children = {refs([app_product, ext_product])}; name = Products; sourceTree = \"<group>\";")
main_group = add("main-group", f"isa = PBXGroup; children = {refs([app_group, ext_group, products])}; sourceTree = \"<group>\";")

def phase(name, isa, files):
    return add(name, f"isa = {isa}; buildActionMask = 2147483647; files = {refs(files)}; runOnlyForDeploymentPostprocessing = 0;")

app_sources = phase("app-sources", "PBXSourcesBuildPhase", app_builds)
app_resources = phase("app-resources", "PBXResourcesBuildPhase", [assets_build])
app_frameworks = phase("app-frameworks", "PBXFrameworksBuildPhase", [])
ext_sources = phase("ext-sources", "PBXSourcesBuildPhase", [ext_compile])
ext_resources = phase("ext-resources", "PBXResourcesBuildPhase", resource_builds)
ext_frameworks = phase("ext-frameworks", "PBXFrameworksBuildPhase", [])
embed_file = add("embed-file", f"isa = PBXBuildFile; fileRef = {ext_product}; settings = {{ ATTRIBUTES = (RemoveHeadersOnCopy,); }};")
embed = add("embed", f"isa = PBXCopyFilesBuildPhase; buildActionMask = 2147483647; dstPath = \"\"; dstSubfolderSpec = 13; files = ({embed_file},); name = \"Embed App Extensions\"; runOnlyForDeploymentPostprocessing = 0;")
proxy = add("proxy", f"isa = PBXContainerItemProxy; containerPortal = {ident('project')}; proxyType = 1; remoteGlobalIDString = {ident('ext-target')}; remoteInfo = PocketSafari;")
dependency = add("dependency", f"isa = PBXTargetDependency; target = {ident('ext-target')}; targetProxy = {proxy};")

def configlist(name, settings):
    configurations = []
    for mode in ["Debug", "Release"]:
        extras = 'SWIFT_OPTIMIZATION_LEVEL = "-Onone"; DEBUG_INFORMATION_FORMAT = dwarf; ENABLE_TESTABILITY = YES;' if mode == "Debug" else 'SWIFT_OPTIMIZATION_LEVEL = "-O"; DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";'
        configurations.append(add(name + mode, f"isa = XCBuildConfiguration; buildSettings = {{ {settings} {extras} }}; name = {mode};"))
    return add(name + "-list", f"isa = XCConfigurationList; buildConfigurations = {refs(configurations)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")

common = 'CLANG_ENABLE_MODULES = YES; CLANG_ENABLE_OBJC_ARC = YES; IPHONEOS_DEPLOYMENT_TARGET = 26.0; SDKROOT = iphoneos; SWIFT_VERSION = 5.0; SWIFT_STRICT_CONCURRENCY = targeted; ENABLE_USER_SCRIPT_SANDBOXING = YES;'
project_configs = configlist("project-config", common)
target_common = 'CODE_SIGN_STYLE = Automatic; DEVELOPMENT_TEAM = ""; TARGETED_DEVICE_FAMILY = 1; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator"; SUPPORTS_MACCATALYST = NO; GENERATE_INFOPLIST_FILE = NO; CURRENT_PROJECT_VERSION = 1; MARKETING_VERSION = 1.0;'
app_configs = configlist("app-config", target_common + ' PRODUCT_NAME = Pocket; PRODUCT_BUNDLE_IDENTIFIER = com.example.PocketFamily; INFOPLIST_FILE = PocketFamily/Info.plist; ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon; LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks",);')
ext_configs = configlist("ext-config", target_common + ' PRODUCT_NAME = PocketSafari; PRODUCT_BUNDLE_IDENTIFIER = com.example.PocketFamily.Safari; INFOPLIST_FILE = PocketSafari/Info.plist; APPLICATION_EXTENSION_API_ONLY = YES; SKIP_INSTALL = YES; LD_RUNPATH_SEARCH_PATHS = ("$(inherited)", "@executable_path/Frameworks", "@executable_path/../../Frameworks",);')
app_target = add("app-target", f'isa = PBXNativeTarget; buildConfigurationList = {app_configs}; buildPhases = {refs([app_sources, app_frameworks, app_resources, embed])}; buildRules = (); dependencies = ({dependency},); name = Pocket; productName = Pocket; productReference = {app_product}; productType = "com.apple.product-type.application";')
ext_target = add("ext-target", f'isa = PBXNativeTarget; buildConfigurationList = {ext_configs}; buildPhases = {refs([ext_sources, ext_frameworks, ext_resources])}; buildRules = (); dependencies = (); name = PocketSafari; productName = PocketSafari; productReference = {ext_product}; productType = "com.apple.product-type.app-extension";')
project = add("project", f'isa = PBXProject; attributes = {{ BuildIndependentTargetsInParallel = YES; LastUpgradeCheck = 2600; TargetAttributes = {{ {app_target} = {{ CreatedOnToolsVersion = 26.0; }}; {ext_target} = {{ CreatedOnToolsVersion = 26.0; }}; }}; }}; buildConfigurationList = {project_configs}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base,); mainGroup = {main_group}; productRefGroup = {products}; projectDirPath = ""; projectRoot = ""; targets = ({app_target}, {ext_target},);')
(ROOT / "PocketFamily.xcodeproj").mkdir(exist_ok=True)
(ROOT / "PocketFamily.xcodeproj/project.pbxproj").write_text("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 56;\n\tobjects = {\n" + "\n".join(objects) + f"\n\t}};\n\trootObject = {project};\n}}\n", encoding="utf-8")
scheme_dir = ROOT / "PocketFamily.xcodeproj/xcshareddata/xcschemes"
scheme_dir.mkdir(parents=True, exist_ok=True)
ref = f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="Pocket.app" BlueprintName="Pocket" ReferencedContainer="container:PocketFamily.xcodeproj"/>'
(scheme_dir / "Pocket.xcscheme").write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2600" version="1.3">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables/></TestAction>
<LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>''', encoding="utf-8")
print(f"Created Xcode project with {len(app_files)} app sources and the Safari extension.")
