import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import type { TextInputProps, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type LedgerTransaction, money } from '@/data';

const light = { background: '#F4F6F3', card: '#FFFFFF', text: '#172F29', secondary: '#64726C', accent: '#0C6D57', line: '#E2E8E2', soft: '#E5F2EA', danger: '#AD303B' };
const dark = { background: '#101B18', card: '#1B2924', text: '#F1F6F2', secondary: '#ABBEB3', accent: '#7CD8AE', line: '#31423A', soft: '#263D31', danger: '#FF9DA5' };
export function usePalette() { return useColorScheme() === 'dark' ? dark : light; }
export type IconName = 'wallet' | 'activity' | 'inbox' | 'family' | 'plus' | 'bag' | 'chevron' | 'check' | 'server' | 'safari' | 'logout' | 'bellOff' | 'person' | 'close' | 'qr' | 'computer' | 'copy' | 'trash';
const icons: Record<IconName, ComponentProps<typeof SymbolView>['name']> = {
  wallet: { ios: 'wallet.bifold.fill', android: 'account_balance_wallet', web: 'account_balance_wallet' },
  activity: { ios: 'arrow.up.arrow.down', android: 'swap_vert', web: 'swap_vert' },
  inbox: { ios: 'tray.fill', android: 'inbox', web: 'inbox' },
  family: { ios: 'person.2.fill', android: 'group', web: 'group' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  bag: { ios: 'bag', android: 'shopping_bag', web: 'shopping_bag' },
  chevron: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  server: { ios: 'network', android: 'dns', web: 'dns' },
  safari: { ios: 'safari', android: 'language', web: 'language' },
  logout: { ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' },
  bellOff: { ios: 'bell.slash', android: 'notifications_off', web: 'notifications_off' },
  person: { ios: 'person.fill', android: 'person', web: 'person' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  qr: { ios: 'qrcode.viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' },
  computer: { ios: 'desktopcomputer', android: 'computer', web: 'computer' },
  copy: { ios: 'doc.on.doc', android: 'content_copy', web: 'content_copy' },
  trash: { ios: 'trash', android: 'delete_outline', web: 'delete_outline' },
};
export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const colors = usePalette();
  return <SymbolView name={icons[name]} size={size} tintColor={color ?? colors.accent} type="monochrome" style={{ width: size, height: size }} />;
}
export function Txt({ children, size = 16, muted = false, weight = '400', style }: PropsWithChildren<{ size?: number; muted?: boolean; weight?: '400' | '500' | '600' | '700' | '800'; style?: ComponentProps<typeof Text>['style'] }>) {
  const colors = usePalette();
  return <Text style={[{ color: muted ? colors.secondary : colors.text, fontSize: size, fontWeight: weight, lineHeight: size * 1.4 }, style]}>{children}</Text>;
}
export function Screen({ title, subtitle, children, action, refreshing = false, onRefresh, topSafe = true }: PropsWithChildren<{ title?: string; subtitle?: string; action?: ReactNode; refreshing?: boolean; onRefresh?: () => void; topSafe?: boolean }>) {
  const colors = usePalette();
  // UIKit accounts for both native headers and the floating tab bar. Adding a
  // second top safe area would double the spacing; Android handles top manually.
  const manualTop = Platform.OS !== 'ios' && topSafe;
  return <SafeAreaView collapsable={false} edges={manualTop ? ['top', 'left', 'right'] : ['left', 'right']} style={{ flex: 1, backgroundColor: colors.background }}>
    <ScrollView contentInsetAdjustmentBehavior="automatic" automaticallyAdjustContentInsets automaticallyAdjustsScrollIndicatorInsets automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.screen} refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} /> : undefined}>
      {title && <View style={styles.heading}><View style={{ flex: 1 }}><Txt size={34} weight="700">{title}</Txt>{subtitle && <Txt muted size={14}>{subtitle}</Txt>}</View>{action}</View>}{children}
    </ScrollView>
  </SafeAreaView>;
}
export function Card({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  const colors = usePalette();
  return <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.line }, style]}>{children}</View>;
}
export function Section({ title, children }: PropsWithChildren<{ title: string }>) { return <View style={{ gap: 12 }}><Txt size={19} weight="600">{title}</Txt>{children}</View>; }
export function GlassButton({ label, icon, onPress, disabled = false, busy = false, prominent = false, danger = false }: { label: string; icon?: IconName; onPress: () => void; disabled?: boolean; busy?: boolean; prominent?: boolean; danger?: boolean }) {
  const colors = usePalette();
  const available = Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  const backgroundColor = prominent ? '#0C6D57' : colors.soft;
  const color = prominent ? '#FFFFFF' : danger ? colors.danger : colors.accent;
  const content = <>{busy ? <ActivityIndicator color={color} /> : icon ? <Icon name={icon} color={color} size={20} /> : null}<Text style={{ color, fontSize: 16, fontWeight: '600' }}>{label}</Text></>;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} onPress={onPress} disabled={disabled || busy} style={({ pressed }) => ({ transform: [{ scale: pressed ? 0.98 : 1 }], borderRadius: 19, borderWidth: disabled ? 1 : 0, borderColor: colors.line })}>
    {available ? <GlassView isInteractive glassEffectStyle="regular" tintColor={prominent ? '#0C6D57' : undefined} style={styles.button}>{content}</GlassView> : <View style={[styles.button, { backgroundColor }]}>{content}</View>}
  </Pressable>;
}
const avatarColors = ['#176E59', '#305EA6', '#7654AB', '#A84578', '#AB542B', '#407347', '#266E8C', '#5C61A8'];
export function Avatar({ name, id, size = 44 }: { name: string; id: string; size?: number }) {
  let hash = 14695981039346656037n;
  for (const byte of new TextEncoder().encode(id || name)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => [...word][0] ?? '').join('').toUpperCase();
  return <View accessible={false} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: avatarColors[Number(hash % 8n)], alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Text numberOfLines={1} adjustsFontSizeToFit style={{ color: '#FFFFFF', fontSize: size * 0.34, fontWeight: '700', paddingHorizontal: 4 }}>{initials || '•'}</Text></View>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const colors = usePalette();
  return <View style={{ gap: 8 }}><Txt muted size={13} weight="500">{label}</Txt><TextInput accessibilityLabel={label} placeholderTextColor={colors.secondary} selectionColor={colors.accent} {...props} style={[styles.input, { color: colors.text, backgroundColor: colors.card, borderColor: colors.line }, props.style]} /></View>;
}
export function Notice({ message }: { message?: string | null }) {
  const colors = usePalette();
  return message ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ color: colors.danger, fontSize: 14, lineHeight: 21 }}>{message}</Text> : null;
}
export function Empty({ icon = 'inbox', title, detail }: { icon?: IconName; title: string; detail: string }) { return <View style={{ alignItems: 'center', padding: 28, gap: 12 }}><Icon name={icon} size={30} /><Txt weight="600" size={18}>{title}</Txt><Txt muted size={14} style={{ textAlign: 'center' }}>{detail}</Txt></View>; }
export function Row({ icon, title, detail, onPress, trailing }: { icon?: IconName; title: string; detail?: string; onPress?: () => void; trailing?: ReactNode }) {
  const content = <View style={styles.row}>{icon && <Icon name={icon} />}<View style={{ flex: 1, gap: 3 }}><Txt weight="500">{title}</Txt>{detail && <Txt muted size={13}>{detail}</Txt>}</View>{trailing ?? (onPress && <Icon name="chevron" size={15} />)}</View>;
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress}>{content}</Pressable> : content;
}
export function TransactionRow({ item, showChild = true }: { item: LedgerTransaction; showChild?: boolean }) {
  const colors = usePalette();
  const addition = item.kind === 'addition';
  return <Pressable accessibilityRole="button" accessibilityLabel={`${item.merchant}, ${addition ? 'added' : 'spent'} ${money(item.amountCents)}`} onPress={() => router.push({ pathname: '/receipt/[id]', params: { id: item.id } })}><View style={styles.row}>
    <View style={[styles.transactionIcon, { backgroundColor: colors.soft }]}><Icon name={addition ? 'plus' : 'bag'} /></View><View style={{ flex: 1, gap: 4 }}><Txt weight="600" size={15}>{item.merchant}</Txt><Txt muted size={12}>{showChild ? item.childName : dateLabel(item.createdAt)}</Txt></View><Txt weight="600" size={15} style={{ fontVariant: ['tabular-nums'], color: addition ? colors.accent : colors.text }}>{addition ? '+' : '−'}{money(item.amountCents)}</Txt>
  </View></Pressable>;
}
export function Choice({ options, value, onChange }: { options: { label: string; value: string }[]; value: string; onChange: (value: string) => void }) {
  const colors = usePalette();
  return <View style={{ flexDirection: 'row', gap: 6, padding: 4, backgroundColor: colors.soft, borderRadius: 16 }}>{options.map(option => <Pressable key={option.value} accessibilityRole="radio" accessibilityState={{ checked: option.value === value }} onPress={() => onChange(option.value)} style={{ flex: 1, padding: 11, borderRadius: 12, alignItems: 'center', backgroundColor: option.value === value ? colors.card : 'transparent' }}><Txt size={14} weight={value === option.value ? '600' : '400'}>{option.label}</Txt></Pressable>)}</View>;
}
export function dateLabel(date: string) { return new Date(date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
export const styles = StyleSheet.create({ screen: { padding: 22, paddingBottom: 42, gap: 24, maxWidth: 720, width: '100%', alignSelf: 'center' }, heading: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8, marginBottom: 3 }, card: { borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, padding: 20, gap: 16 }, button: { minHeight: 52, paddingHorizontal: 20, paddingVertical: 14, borderRadius: 19, flexDirection: 'row', gap: 9, alignItems: 'center', justifyContent: 'center' }, input: { borderWidth: 1, borderRadius: 16, minHeight: 52, padding: 15, fontSize: 17 }, row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 10 }, transactionIcon: { width: 43, height: 43, borderRadius: 14, justifyContent: 'center', alignItems: 'center' } });
