import { CameraView, useCameraPermissions } from 'expo-camera';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View } from 'react-native';
import { Card, Field, GlassButton, Icon, Notice, Screen, Txt } from '@/components/pocket-ui';
import { parseCreditCode, usePocket } from '@/data';

export default function ScanEarnings() {
  const { state } = usePocket();
  const [permission, requestPermission] = useCameraPermissions();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [manual, setManual] = useState('');
  const captured = useRef(false);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => setActive(next === 'active'));
    return () => subscription.remove();
  }, []);

  function scan(value: string) {
    if (captured.current) return;
    captured.current = true;
    try {
      const code = parseCreditCode(value);
      router.replace({ pathname: '/redeem', params: { code } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read this code.');
      setPaused(true);
    }
  }
  function reset() { captured.current = false; setPaused(false); setError(null); }
  async function enableCamera() {
    try {
      if (permission?.canAskAgain === false) await Linking.openSettings();
      else await requestPermission();
    } catch { setError('Could not open the camera. You can paste the earnings code below.'); }
  }

  return <Screen topSafe={false} title="Scan earnings" subtitle={state?.user.role === 'parent' ? 'Scan the code in File Tracker, then choose a child.' : 'Scan the code in File Tracker to add your earnings.'}>
    {permission?.granted ? <View style={{ height: 310, borderRadius: 26, overflow: 'hidden', backgroundColor: '#101B18', alignItems: 'center', justifyContent: 'center' }}>
      {focused && active && !paused ? <CameraView style={{ width: '100%', height: '100%' }} facing="back" mute barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => scan(data)} onMountError={() => { setError('The camera could not start. You can paste the earnings code below.'); setPaused(true); }} /> : <Icon name="qr" size={72} color="#FFFFFF" />}
      {!paused && <View pointerEvents="none" style={{ position: 'absolute', width: 210, height: 210, borderWidth: 2, borderColor: '#FFFFFF', borderRadius: 20 }} />}
    </View> : <Card><Icon name="qr" size={42} /><Txt weight="600">Scan with your camera</Txt><Txt muted>Point it at the QR code shown by File Tracker.</Txt><GlassButton label={permission?.canAskAgain === false ? 'Open camera settings' : 'Allow camera'} prominent onPress={() => void enableCamera()} /></Card>}
    <Notice message={error} />
    {paused && <GlassButton label="Scan again" onPress={reset} />}
    <Card><Field label="Or paste the earnings code" value={manual} onChangeText={setManual} autoCapitalize="none" autoCorrect={false} maxLength={100} placeholder="pocket://redeem?code=…" /><GlassButton label="Use code" disabled={!manual.trim()} onPress={() => { captured.current = false; scan(manual); }} /></Card>
    <Txt muted size={13}>Each code can be redeemed once. Your family server confirms the amount.</Txt>
  </Screen>;
}
