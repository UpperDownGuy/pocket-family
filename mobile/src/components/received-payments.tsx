import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Modal, ScrollView, StyleSheet, View } from 'react-native';
import { money, receivedPayments, type ReceivedPayments, usePocket } from '@/data';
import { Avatar, Card, GlassButton, Icon, Notice, Txt, usePalette } from './pocket-ui';
import { useReducedMotion } from './payment-ui';

export function ReceivedPaymentsCard() {
  const { state, serverURL } = usePocket();
  if (state?.user.role !== 'child') return null;
  // Changing account or server destroys the captured card and its local state.
  return <ChildPayments key={`${serverURL}\n${state.user.id}`} />;
}

function ChildPayments() {
  const { state, markRead } = usePocket();
  const colors = usePalette();
  const reduced = useReducedMotion();
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [batch, setBatch] = useState<ReceivedPayments | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const pending = useRef(false);
  const mounted = useRef(true);
  const [entrance] = useState(() => new Animated.Value(1));
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', value => setActive(value === 'active'));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (active && !batch) setBatch(receivedPayments(state, dismissed.current));
  }, [state, active, batch]);
  useEffect(() => {
    if (!batch || !active || reduced) { entrance.setValue(1); return; }
    entrance.setValue(0);
    const animation = Animated.timing(entrance, { toValue: 1, duration: 280, useNativeDriver: true, isInteraction: false });
    animation.start();
    return () => animation.stop();
  }, [batch, active, reduced, entrance]);

  async function dismiss(openReceipt = false) {
    if (!batch || pending.current) return;
    pending.current = true;
    setSaving(true); setError(null);
    const captured = batch;
    try {
      await markRead(captured.notificationIds);
      if (!mounted.current) return;
      captured.notificationIds.forEach(id => dismissed.current.add(id));
      setBatch(null);
      if (openReceipt) {
        if (captured.transactions.length === 1) router.push({ pathname: '/receipt/[id]', params: { id: captured.transactions[0].id } });
        else router.push('/(tabs)/inbox');
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not dismiss. Try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  if (!batch || !state) return null;
  const count = batch.transactions.length;
  return <Modal visible={active} transparent animationType="none" onRequestClose={() => void dismiss()}>
    <View style={styles.backdrop}>
      <Animated.View accessibilityViewIsModal style={[styles.container, { opacity: entrance, transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Card style={styles.card}>
            <View style={[styles.seal, { backgroundColor: colors.soft }]}><Icon name="check" size={30} /></View>
            <Txt size={14} muted weight="500">{count === 1 ? 'PAYMENT RECEIVED' : `${count} PAYMENTS RECEIVED`}</Txt>
            <Txt size={46} weight="700" style={{ color: colors.accent, fontVariant: ['tabular-nums'] }}>{money(batch.amountCents)}</Txt>
            <View style={styles.recipient}><Avatar id={state.user.id} name={state.user.name} size={28} /><Txt size={15}>Added to your Pocket balance</Txt></View>
            <View style={[styles.summary, { borderColor: colors.line }]}>{batch.transactions.slice(0, 3).map(item => <View key={item.id} style={styles.payment}><View style={{ flex: 1, gap: 3 }}><Txt weight="600" size={15}>{item.merchant || 'Money added'}</Txt>{item.note ? <Txt size={13} muted>{item.note}</Txt> : null}</View><Txt weight="600">{money(item.amountCents)}</Txt></View>)}{count > 3 && <Txt muted size={13}>And {count - 3} more in your Inbox.</Txt>}</View>
            <Notice message={error} />
            <View style={{ alignSelf: 'stretch', gap: 10 }}><GlassButton label="Got it" icon="check" prominent busy={saving} onPress={() => void dismiss()} /><GlassButton label={count === 1 ? 'View receipt' : 'View Inbox'} disabled={saving} onPress={() => void dismiss(true)} /></View>
          </Card>
        </ScrollView>
      </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#071E23AA', alignItems: 'center', justifyContent: 'center', padding: 24 },
  container: { width: '100%', maxWidth: 480, maxHeight: '90%' },
  scroll: { flexGrow: 1 },
  card: { alignItems: 'center', gap: 17, padding: 26, borderRadius: 32 },
  seal: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center' },
  recipient: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  summary: { alignSelf: 'stretch', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, gap: 16 },
  payment: { flexDirection: 'row', alignItems: 'center', gap: 12 },
});
