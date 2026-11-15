import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { usePocket, money } from '@/data';
import { Avatar, Card, Empty, GlassButton, Icon, Notice, Screen, Section, TransactionRow, Txt, usePalette } from '@/components/pocket-ui';
export default function Balances() {
  const { state, refresh, busy, error } = usePocket();
  const colors = usePalette();
  if (!state) return null;
  const parent = state.user.role === 'parent';
  const children = state.members.filter(member => member.role === 'child');
  const own = state.members.find(member => member.id === state.user.id) ?? state.user;
  const total = parent ? children.reduce((sum, child) => sum + (child.balanceCents ?? 0), 0) : own.balanceCents ?? 0;
  return <Screen title="Balances" subtitle={state.familyName} onRefresh={() => void refresh()} refreshing={busy}>
    <Notice message={error} />
    <Card style={{ padding: 26, gap: 16 }}><View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}><Icon name="wallet" /><Txt muted size={14}>{parent ? 'Family balance' : 'Your balance'}</Txt></View><Txt size={46} weight="700" style={{ fontVariant: ['tabular-nums'], color: colors.accent }}>{money(total)}</Txt>
      {(children.length > 0 || !parent) && <GlassButton label={parent ? 'Add or spend' : 'Record a purchase'} icon={parent ? 'plus' : 'bag'} prominent onPress={() => router.push('/entry')} />}
    </Card>
    {parent && <Section title="Kids">{children.length ? children.map(child => <Pressable accessibilityRole="button" key={child.id} onPress={() => router.push({ pathname: '/child/[id]', params: { id: child.id } })}><Card><View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}><Avatar name={child.name} id={child.id} /><View style={{ flex: 1 }}><Txt weight="600">{child.name}</Txt><Txt muted size={12}>Balance</Txt></View><Txt weight="600" size={19}>{money(child.balanceCents ?? 0)}</Txt><Icon name="chevron" size={13} /></View></Card></Pressable>) : <Card><Empty icon="family" title="Add your first child" detail="Each child gets their own balance and sign-in." /><GlassButton label="Add member" icon="plus" onPress={() => router.push('/member')} /></Card>}</Section>}
    <Section title="Recent activity"><Card>{state.transactions.length ? state.transactions.slice(0, 5).map(item => <TransactionRow key={item.id} item={item} showChild={parent} />) : <Empty title="No activity" detail="Purchases and additions appear here." />}</Card></Section>
  </Screen>;
}
