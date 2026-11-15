import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PocketProvider, usePocket } from '@/data';
import { usePalette } from '@/components/pocket-ui';
import { ReceivedPaymentsCard } from '@/components/received-payments';

export const unstable_settings = { anchor: '(tabs)' };

function Navigation() {
  const { ready, state } = usePocket();
  const colors = usePalette();
  if (!ready) return <View style={{ flex: 1, backgroundColor: colors.background, justifyContent: 'center' }}><ActivityIndicator color={colors.accent} accessibilityLabel="Loading Pocket" /></View>;
  return <Stack screenOptions={{ headerTintColor: colors.accent, headerBackTitle: 'Back', contentStyle: { backgroundColor: colors.background } }}>
    <Stack.Protected guard={!!state} redirectTo="/sign-in">
      <Stack.Screen name="(tabs)" options={{ title: 'Pocket', headerShown: false }} />
      <Stack.Screen name="entry" options={{ title: 'Pay or record', presentation: 'modal' }} />
      <Stack.Screen name="member" options={{ title: 'Add member', presentation: 'modal' }} />
      <Stack.Screen name="child/[id]" options={{ title: 'Balance' }} />
      <Stack.Screen name="receipt/[id]" options={{ title: 'Details' }} />
      <Stack.Screen name="scan" options={{ title: 'Scan earnings' }} />
      <Stack.Screen name="file-tracker" options={{ title: 'File Tracker' }} />
    </Stack.Protected>
    <Stack.Protected guard={!state} redirectTo="/(tabs)"><Stack.Screen name="sign-in" options={{ headerShown: false }} /></Stack.Protected>
    <Stack.Screen name="server" options={{ title: 'Server', presentation: 'modal' }} />
    {/* Keep an incoming code in this route while the user signs in. */}
    <Stack.Screen name="redeem" options={{ title: 'Earnings' }} />
  </Stack>;
}
export default function RootLayout() {
  const dark = useColorScheme() === 'dark';
  return <SafeAreaProvider><ThemeProvider value={dark ? DarkTheme : DefaultTheme}><PocketProvider><StatusBar style={dark ? 'light' : 'dark'} /><Navigation /><ReceivedPaymentsCard /></PocketProvider></ThemeProvider></SafeAreaProvider>;
}
