import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { usePocket, money } from '@/data';
import { Avatar, Card, Empty, GlassButton, Notice, Row, Screen, Section, TransactionRow, Txt } from '@/components/pocket-ui';
export default function ChildBalance() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state, error, refresh, busy } = usePocket();
  const child = state?.members.find(member => member.id === id && member.role === 'child');
  if (!child) return <Screen topSafe={false}><Empty title="Balance unavailable" detail="This account cannot access that balance." /></Screen>;
  const items = state?.transactions.filter(item => item.childId === child.id) ?? [];
  return <Screen topSafe={false} onRefresh={() => void refresh()} refreshing={busy}><Notice message={error} /><Card><View style={{ alignItems: 'center', gap: 12 }}><Avatar name={child.name} id={child.id} size={72} /><Txt size={20} weight="600">{child.name}</Txt><Txt size={44} weight="700" style={{ fontVariant: ['tabular-nums'] }}>{money(child.balanceCents ?? 0)}</Txt></View><GlassButton label={state?.user.role === 'parent' ? 'Pay or record' : 'Record a purchase'} icon="plus" prominent onPress={() => router.push({ pathname: '/entry', params: { childId: child.id } })} /></Card><Card><Row icon="repeat" title="Subscriptions" detail={`Recurring deductions for ${child.name}`} onPress={() => router.push({ pathname: '/subscriptions', params: { childId: child.id } })} /></Card><Section title="Activity"><Card>{items.length ? items.map(item => <TransactionRow item={item} key={item.id} showChild={false} />) : <Empty title="No activity" detail="Purchases and additions appear here." />}</Card></Section></Screen>;
}
