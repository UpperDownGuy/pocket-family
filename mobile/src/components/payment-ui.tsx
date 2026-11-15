import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon, usePalette } from './pocket-ui';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  return reduced;
}

/** Visual feedback reflects the request; success is set only after server confirmation. */
export function PayButton({ label, status, disabled, onPress }: {
  label: string; status: 'idle' | 'paying' | 'paid'; disabled?: boolean; onPress: () => void;
}) {
  const colors = usePalette();
  const reduced = useReducedMotion();
  const [shimmer] = useState(() => new Animated.Value(0));
  const [check] = useState(() => new Animated.Value(0));
  const busy = status === 'paying';
  const paid = status === 'paid';
  const glass = Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  useEffect(() => {
    shimmer.setValue(0);
    if (!busy || reduced) return;
    const animation = Animated.loop(Animated.timing(shimmer, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true, isInteraction: false }));
    animation.start();
    return () => animation.stop();
  }, [busy, reduced, shimmer]);
  useEffect(() => {
    check.setValue(paid && reduced ? 1 : 0);
    if (!paid || reduced) return;
    const animation = Animated.timing(check, { toValue: 1, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true, isInteraction: false });
    animation.start();
    return () => animation.stop();
  }, [paid, reduced, check]);
  const text = paid ? 'Paid' : busy ? 'Paying…' : label;
  const content = <>
    {busy && !reduced && <Animated.View pointerEvents="none" style={[styles.stripes, { transform: [{ translateX: shimmer.interpolate({ inputRange: [0, 1], outputRange: [-56, 0] }) }] }]}>
      {Array.from({ length: 28 }, (_, index) => <View key={index} style={styles.stripe} />)}
    </Animated.View>}
    <View style={styles.label}>
      {paid ? <Animated.View style={{ opacity: check, transform: [{ scale: check.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) }] }}><Icon name="check" color="#FFFFFF" size={22} /></Animated.View> : !busy && <Icon name="plus" color="#FFFFFF" size={21} />}
      <Text style={styles.text} accessibilityLiveRegion="polite">{text}</Text>
    </View>
  </>;
  return <Pressable accessibilityRole="button" accessibilityLabel={text} accessibilityState={{ disabled: !!disabled || busy || paid, busy }}
    disabled={disabled || busy || paid} onPress={onPress}
    style={({ pressed }) => [styles.shell, { opacity: disabled ? 0.5 : 1, borderColor: colors.line, transform: [{ scale: pressed && !reduced ? 0.985 : 1 }] }]}>
    {glass ? <GlassView isInteractive glassEffectStyle="regular" tintColor="#0C6D57" style={styles.button}>{content}</GlassView> : <View style={[styles.button, styles.fallback]}>{content}</View>}
  </Pressable>;
}

const styles = StyleSheet.create({
  shell: { borderRadius: 22, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  button: { minHeight: 58, borderRadius: 22, overflow: 'hidden', justifyContent: 'center', paddingVertical: 17, paddingHorizontal: 20 },
  fallback: { backgroundColor: '#0C6D57' },
  label: { flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center' },
  text: { color: '#FFFFFF', fontWeight: '600', fontSize: 17, letterSpacing: 0.2 },
  stripes: { position: 'absolute', top: -20, bottom: -20, left: -28, flexDirection: 'row', gap: 28 },
  stripe: { width: 28, height: '100%', backgroundColor: '#FFFFFF', opacity: 0.09, transform: [{ skewX: '-24deg' }] },
});
