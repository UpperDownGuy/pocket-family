import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Avatar, Card, Empty, GlassButton, Icon, Notice, Screen, Txt, usePalette } from '@/components/pocket-ui';
import { money, SUBSCRIPTIONS_UPDATE_MESSAGE, subscriptionDateLabel, type Subscription, usePocket } from '@/data';

export default function Subscriptions() {
  const { state, serverURL } = usePocket();
  const params = useLocalSearchParams<{ childId?: string }>();
  if (!state) return null;
  if (state.user.role === 'parent' && !params.childId) return <SubscriptionChildPicker key={`${serverURL}:${state.user.id}`} />;
  const childId = params.childId ?? state.user.id;
  return <SubscriptionList key={`${serverURL}:${state.user.id}:${childId}`} childId={childId} />;
}

function SubscriptionChildPicker() {
  const { state } = usePocket();
  const colors = usePalette();
  const children = state?.members.filter(member => member.role === 'child') ?? [];
  return <Screen topSafe={false} title="Subscriptions" subtitle="Choose a child to view their subscriptions.">
    <GlassButton label="Apple Reminders" icon="reminders" onPress={() => router.push('/reminders')} />
    {children.length ? children.map(child => <Pressable key={child.id} accessibilityRole="button" accessibilityLabel={`${child.name}, view subscriptions`} onPress={() => router.push({ pathname: '/subscriptions', params: { childId: child.id } })}>
      <Card style={styles.child}>
        <Avatar name={child.name} id={child.id} size={50} />
        <View style={styles.title}><Txt weight="600" size={20}>{child.name}</Txt><Txt muted size={13}>Balance · {money(child.balanceCents ?? 0)}</Txt></View>
        <Icon name="chevron" size={15} color={colors.secondary} />
      </Card>
    </Pressable>) : <Card><Empty icon="family" title="Add a child first" detail="Each child gets their own subscription list and balance." /><GlassButton label="Add member" icon="plus" onPress={() => router.push('/member')} /></Card>}
  </Screen>;
}

function SubscriptionList({ childId }: { childId?: string }) {
  const { state, listSubscriptions, pendingSubscription } = usePocket();
  const colors = usePalette();
  const [items, setItems] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const focused = useRef(true);
  const parent = state?.user.role === 'parent';
  const children = state?.members.filter(member => member.role === 'child') ?? [];
  const selectedChild = childId ? children.find(member => member.id === childId) : null;
  const inaccessible = !!childId && (!selectedChild || (!parent && childId !== state?.user.id));
  const visible = items.filter(item => (!childId || item.childId === childId) && (parent || item.childId === state?.user.id));
  const ordered = [...visible].sort((a, b) => Number(a.paused) - Number(b.paused) || a.nextChargeDate.localeCompare(b.nextChargeDate) || a.name.localeCompare(b.name));

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setError(null); setRefreshing(true);
    try {
      const result = await listSubscriptions();
      if (focused.current && current === sequence.current) setItems(result);
    } catch (caught) {
      if (focused.current && current === sequence.current) setError(caught instanceof Error ? caught.message : 'Could not load subscriptions.');
    } finally {
      if (focused.current && current === sequence.current) { setLoading(false); setRefreshing(false); }
    }
  }, [listSubscriptions]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    void load();
    return () => { focused.current = false; sequence.current++; };
  }, [load]));

  if (inaccessible) return <Screen topSafe={false}><Empty icon="repeat" title="Subscriptions unavailable" detail="This account cannot access that child's subscriptions." /></Screen>;
  return <Screen topSafe={false} title="Subscriptions" subtitle={selectedChild ? selectedChild.name : parent ? 'Family recurring charges' : 'Your recurring charges'} onRefresh={() => void load()} refreshing={refreshing && !loading}>
    <Card style={styles.intro}>
      <Icon name="repeat" size={30} />
      <Txt>Automatically deduct recurring costs from a Pocket balance, even when it goes below zero.</Txt>
      <Txt muted size={13}>These are balance records in Pocket. They do not pay a store or cancel an outside subscription.</Txt>
    </Card>
    {children.length > 0 && <GlassButton label={pendingSubscription ? 'Continue subscription setup' : 'Add subscription'} icon="plus" prominent disabled={loading || error === SUBSCRIPTIONS_UPDATE_MESSAGE} onPress={() => router.push({ pathname: '/subscription', params: childId ? { childId } : {} })} />}
    <GlassButton label="Apple Reminders" icon="reminders" onPress={() => router.push('/reminders')} />
    <Notice message={error} />
    {loading ? <ActivityIndicator color={colors.accent} accessibilityLabel="Loading subscriptions" /> : ordered.length ? ordered.map(item => {
      const owner = children.find(member => member.id === item.childId);
      return <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.name}, ${money(item.amountCents)} ${item.interval}, ${item.paused ? 'paused' : 'active'}, view subscription`} onPress={() => router.push({ pathname: '/subscription', params: { id: item.id } })}>
        <Card style={styles.subscription}>
          <View style={styles.heading}><View style={[styles.symbol, { backgroundColor: colors.soft }]}><Icon name={item.paused ? 'pause' : 'repeat'} /></View><View style={styles.title}><Txt weight="600" size={19}>{item.name}</Txt>{parent && <Txt muted size={13}>{owner?.name ?? 'Child'}</Txt>}</View><Icon name="chevron" size={14} color={colors.secondary} /></View>
          <View style={styles.price}><Txt size={27} weight="700" style={{ fontVariant: ['tabular-nums'] }}>{money(item.amountCents)}</Txt><Txt muted size={14}>/ {({ weekly: 'week', monthly: 'month', yearly: 'year' })[item.interval]}</Txt></View>
          <View style={styles.schedule}><Txt size={13} weight="600" style={{ color: item.paused ? colors.secondary : colors.accent }}>{item.paused ? 'Paused' : 'Active'}</Txt><Txt muted size={13}>{item.paused ? 'No charges while paused' : `Next · ${subscriptionDateLabel(item.nextChargeDate)}`}</Txt></View>
          <Txt muted size={12}>{item.timeZone}</Txt>
        </Card>
      </Pressable>;
    }) : !error && <Card><Empty icon="repeat" title={children.length ? 'No subscriptions yet' : 'Add a child first'} detail={children.length ? 'Add a weekly, monthly, or yearly cost to keep track of it automatically.' : 'Subscriptions are deducted from a child’s balance.'} />{!children.length && parent && <GlassButton label="Add member" icon="plus" onPress={() => router.push('/member')} />}</Card>}
    {!loading && error && <GlassButton label="Try again" icon="repeat" busy={refreshing} onPress={() => void load()} />}
  </Screen>;
}

const styles = StyleSheet.create({
  intro: { gap: 12, padding: 22 },
  subscription: { gap: 14, padding: 20 },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  symbol: { width: 42, height: 42, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, gap: 2 },
  child: { flexDirection: 'row', alignItems: 'center', gap: 15, padding: 20 },
  price: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  schedule: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
});
