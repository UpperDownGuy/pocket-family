import type { ExpoConfig } from 'expo/config';

const bundleIdentifier = process.env.POCKET_BUNDLE_IDENTIFIER || 'com.example.PocketFamily';
const config: ExpoConfig = {
  name: 'Pocket', slug: 'pocket-family', scheme: 'pocket', version: '1.1.0',
  orientation: 'portrait', userInterfaceStyle: 'automatic',
  icon: './assets/images/pocket.png',
  ios: {
    bundleIdentifier, supportsTablet: true,
    infoPlist: {
      NSLocalNetworkUsageDescription: 'Pocket connects to your family server on your local network.',
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: { package: bundleIdentifier, predictiveBackGestureEnabled: true },
  web: { output: 'static', favicon: './assets/images/pocket.png' },
  plugins: [
    'expo-router', 'expo-secure-store',
    ['expo-camera', { cameraPermission: 'Pocket uses your camera to scan File Tracker earnings codes.', microphonePermission: false, recordAudioAndroid: false, barcodeScannerEnabled: true }],
    ['expo-splash-screen', { image: './assets/images/pocket.png', imageWidth: 96, backgroundColor: '#F4F6F3', dark: { backgroundColor: '#101B18' } }],
    ['expo-build-properties', { ios: { deploymentTarget: '26.0' }, android: { usesCleartextTraffic: true } }],
    ['./plugins/withPocketSafari.cjs', { enabled: true, sourceDirectory: '../PocketSafari', bundleIdentifier: `${bundleIdentifier}.Safari`, deploymentTarget: '26.0' }],
  ],
  experiments: { typedRoutes: true },
  extra: { safariExtensionIncluded: true },
};
export default config;
