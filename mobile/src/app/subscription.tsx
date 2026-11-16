import { useCallback, useEffect, useRef, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { Avatar, Card, Choice, Empty, Field, GlassButton, Icon, Notice, Screen, Section, Txt, usePalette } from '@/components/pocket-ui';
import { SubscriptionDate } from '@/components/subscription-date';
import { centsFromInput, createRequestID, defaultSubscriptionDate, money, subscriptionDateLabel, todayInTimeZone, type Subscription, type SubscriptionInput, type SubscriptionPatch, usePocket } from '@/data';

export default function SubscriptionScreen() {
  const { state, serverURL } = usePocket();
  const params = useLocalSearchParams<{ id?: string; childId?: string }>();
  if (!state) return null;
  return <SubscriptionLoader key={`${serverURL}:${state.user.id}:${params.id ?? 'new'}:${params.childId ?? ''}`} id={params.id} childId={params.childId} />;
}

function SubscriptionLoader({ id, childId }: { id?: string; childId?: string }) {
  const { listSubscriptions, state } = usePocket();
  const colors = usePalette();
  const [record, setRecord] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const focused = useRef(true);
  const load = useCallback(async () => {
    if (!id) return;
    const current = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const items = await listSubscriptions();
      if (!focused.current || sequence.current !== current) return;
      const item = items.find(value => value.id === id && (state?.user.role === 'parent' || value.childId === state?.user.id));
      setRecord(item ?? null);
      if (!item) setError('This subscription is unavailable or was deleted.');
    } catch (caught) {
      if (focused.current && sequence.current === current) setError(caught instanceof Error ? caught.message : 'Could not load this subscription.');
    } finally {
      if (focused.current && sequence.current === current) setLoading(false);
    }
  }, [id, listSubscriptions, state?.user.id, state?.user.role]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    void load();
    return () => { focused.current = false; sequence.current++; };
  }, [load]));
  if (loading) return <Screen topSafe={false}><ActivityIndicator color={colors.accent} accessibilityLabel="Loading subscription" /></Screen>;
  if (id && (!record || error)) return <Screen topSafe={false}><Notice message={error} /><GlassButton label="Try again" icon="repeat" onPress={() => void load()} /></Screen>;
  return <SubscriptionForm key={record ? `${record.id}:${record.updatedAt}` : 'new'} initial={record} childId={childId} />;
}

function zoneToday(timeZone: string): string {
  try { return todayInTimeZone(new Date(), timeZone); } catch { return ''; }
}

function SubscriptionForm({ initial, childId }: { initial: Subscription | null; childId?: string }) {
  const { state, pendingSubscription, pendingSubscriptionUpdate, createSubscription, updateSubscription, deleteSubscription } = usePocket();
  const colors = usePalette();
  const unresolved = initial ? null : pendingSubscription;
  const unresolvedUpdate = initial && pendingSubscriptionUpdate?.id === initial.id ? pendingSubscriptionUpdate.patch : null;
  const parent = state?.user.role === 'parent';
  const children = state?.members.filter(member => member.role === 'child') ?? [];
  const [record, setRecord] = useState(initial);
  const [selectedChild, setSelectedChild] = useState(unresolved?.childId ?? initial?.childId ?? (parent ? childId ?? children[0]?.id ?? '' : state?.user.id ?? ''));
  const [name, setName] = useState(unresolvedUpdate?.name ?? unresolved?.name ?? initial?.name ?? '');
  const [amount, setAmount] = useState(unresolvedUpdate?.amountCents !== undefined ? (unresolvedUpdate.amountCents / 100).toFixed(2) : unresolved ? (unresolved.amountCents / 100).toFixed(2) : initial ? (initial.amountCents / 100).toFixed(2) : '');
  const [interval, setInterval] = useState<Subscription['interval']>(unresolvedUpdate?.interval ?? unresolved?.interval ?? initial?.interval ?? 'monthly');
  const [timeZone, setTimeZone] = useState(unresolvedUpdate?.timeZone ?? unresolved?.timeZone ?? initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [date, setDate] = useState(() => unresolvedUpdate?.nextChargeDate ?? unresolved?.nextChargeDate ?? initial?.nextChargeDate ?? defaultSubscriptionDate(new Date(), timeZone, interval));
  const customizedDate = useRef(!!initial || !!unresolved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const requestID = useRef(unresolved?.idempotencyKey ?? createRequestID());
  const disablePrevention = usePreventRemove(busy);
  const cents = centsFromInput(amount);
  const owner = children.find(member => member.id === selectedChild);
  const locked = busy || !!unresolved || !!unresolvedUpdate;
  const today = zoneToday(timeZone.trim());
  const patch: SubscriptionPatch = unresolvedUpdate ? { ...unresolvedUpdate } : {};
  if (record && !unresolvedUpdate) {
    if (name.trim() !== record.name) patch.name = name.trim();
    if (cents !== null && cents !== record.amountCents) patch.amountCents = cents;
    if (interval !== record.interval) patch.interval = interval;
    if (date.trim() !== record.nextChargeDate) patch.nextChargeDate = date.trim();
    if (timeZone.trim() !== record.timeZone) patch.timeZone = timeZone.trim();
  }
  const changed = !record || Object.keys(patch).length > 0;
  const valid = !!owner && !!name.trim() && cents !== null && /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) && !!today;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function goBack() {
    disablePrevention();
    if (router.canGoBack()) router.back(); else router.replace('/subscriptions');
  }
  function chooseDate(value: string) { customizedDate.current = true; setDate(value); }
  function chooseInterval(value: Subscription['interval']) {
    setInterval(value);
    if (!record && !customizedDate.current && today) setDate(defaultSubscriptionDate(new Date(), timeZone.trim(), value));
  }
  async function save() {
    if (!mounted.current || pending.current || !valid || !owner || cents === null || !changed) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      if (record) await updateSubscription(record.id, { ...patch, idempotencyKey: patch.idempotencyKey ?? createRequestID() });
      else {
        const input: SubscriptionInput = { childId: owner.id, name: name.trim(), amountCents: cents, interval, nextChargeDate: date.trim(), timeZone: timeZone.trim(), idempotencyKey: requestID.current };
        await createSubscription(input);
      }
      if (mounted.current) goBack();
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not save this subscription.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function setPaused(paused: boolean) {
    if (!mounted.current || pending.current || !record) return;
    pending.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      const result = await updateSubscription(record.id, { paused, idempotencyKey: createRequestID() });
      if (mounted.current) { setRecord(result); setDate(result.nextChargeDate); setNotice(paused ? 'Subscription paused. No charges will be added while it is paused.' : `Subscription resumed. Next charge: ${subscriptionDateLabel(result.nextChargeDate)}.`); }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not update this subscription.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function confirmResume() {
    if (!record) return;
    Alert.alert(`Resume ${record.name}?`, 'Charges will resume on the next scheduled date after today. Charges from the paused period will be skipped.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true }, { text: 'Resume', onPress: () => void setPaused(false) },
    ], { cancelable: true });
  }
  async function remove() {
    if (!mounted.current || pending.current || !record) return;
    pending.current = true; setBusy(true); setError(null);
    try { await deleteSubscription(record.id); if (mounted.current) goBack(); }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not delete this subscription.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function confirmDelete() {
    if (!record) return;
    Alert.alert(`Delete ${record.name}?`, 'Future Pocket charges will stop. Past charges will stay in the balance and history. This does not cancel a subscription with a store.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true }, { text: 'Delete subscription', style: 'destructive', onPress: () => void remove() },
    ], { cancelable: true });
  }

  if (!children.length) return <Screen topSafe={false}><Empty icon="family" title="Add a child first" detail="Subscriptions are deducted from a child’s balance." /></Screen>;
  if (record && !owner) return <Screen topSafe={false}><Empty icon="repeat" title="Subscription unavailable" detail="This account cannot access that subscription." /></Screen>;
  return <Screen topSafe={false} title={record ? record.name : 'New subscription'} subtitle={record ? `${record.paused ? 'Paused' : 'Active'} · ${owner?.name ?? ''}` : 'A recurring Pocket balance deduction'}>
    {unresolved && <Notice message="This subscription is not confirmed yet. Retry the saved setup to check the same request without creating it twice." />}
    {unresolvedUpdate && <Notice message="This update is not confirmed yet. Retry the saved update to check the same request without applying it twice." />}
    {parent && !record ? <Section title="Whose balance?"><Card>{children.map(member => <Pressable key={member.id} accessibilityRole="radio" accessibilityState={{ checked: selectedChild === member.id, disabled: locked }} disabled={locked} onPress={() => setSelectedChild(member.id)}><View style={styles.member}><Avatar name={member.name} id={member.id} size={40} /><View style={{ flex: 1 }}><Txt weight="600">{member.name}</Txt><Txt muted size={13}>{money(member.balanceCents ?? 0)}</Txt></View>{selectedChild === member.id && <Icon name="check" />}</View></Pressable>)}</Card></Section> : owner ? <Card><View style={styles.member}><Avatar name={owner.name} id={owner.id} size={42} /><View><Txt weight="600">{owner.name}</Txt><Txt muted size={13}>Current balance · {money(owner.balanceCents ?? 0)}</Txt></View></View></Card> : null}
    <Card><Field label="Subscription name" placeholder="Music, games, or another recurring cost" value={name} onChangeText={setName} maxLength={100} editable={!locked} /><Field label="Price · USD" placeholder="0.00" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" maxLength={12} editable={!locked} style={{ fontSize: 30, fontWeight: '600', color: colors.accent }} /></Card>
    <Section title="Billing schedule">
      {locked ? <Card><Txt weight="600">{({ weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' })[interval]}</Txt></Card> : <Choice options={[{ label: 'Weekly', value: 'weekly' }, { label: 'Monthly', value: 'monthly' }, { label: 'Yearly', value: 'yearly' }]} value={interval} onChange={value => chooseInterval(value as Subscription['interval'])} />}
      <Card><SubscriptionDate label={record ? 'Next charge' : 'First charge'} value={date} onChange={chooseDate} disabled={locked} />
        {!locked && <View style={styles.dateButtons}><View style={{ flex: 1 }}><GlassButton label="Today" disabled={!today} onPress={() => chooseDate(today)} /></View><View style={{ flex: 1 }}><GlassButton label={interval === 'weekly' ? 'Next week' : interval === 'yearly' ? 'Next year' : 'Next month'} disabled={!today} onPress={() => chooseDate(defaultSubscriptionDate(new Date(), timeZone.trim(), interval))} /></View></View>}
        <Field label="Billing time zone" value={timeZone} onChangeText={setTimeZone} placeholder="America/New_York" autoCapitalize="none" autoCorrect={false} maxLength={100} editable={!locked} />
        <Txt muted size={13}>Dates follow this time zone. A charge scheduled for today is deducted immediately{record?.paused ? ' when the subscription is active' : ''}.</Txt>
      </Card>
    </Section>
    <Txt muted size={13}>Each charge deducts {cents === null ? 'the price' : money(cents)} from {owner?.name ?? 'the child'}’s Pocket balance, even below zero. The child and parents receive an Inbox update.</Txt>
    <Notice message={error} />
    {notice && <Txt size={14} style={{ color: colors.accent }}>{notice}</Txt>}
    {!!amount && cents === null && <Notice message="Enter a price from $0.01 to $10,000.00, with up to two decimal places." />}
    <GlassButton label={unresolvedUpdate ? 'Retry update' : record ? 'Save changes' : unresolved ? 'Retry subscription setup' : 'Create subscription'} icon="check" prominent busy={busy} disabled={!valid || !changed} onPress={() => void save()} />
    {record && <Section title="Manage subscription"><GlassButton label={record.paused ? 'Resume subscription' : 'Pause subscription'} icon={record.paused ? 'play' : 'pause'} disabled={busy || changed} onPress={record.paused ? confirmResume : () => void setPaused(true)} />{changed && <Txt muted size={13}>{unresolvedUpdate ? 'Confirm the saved update before making another change.' : 'Save your changes before pausing or resuming.'}</Txt>}<GlassButton label="Delete subscription" icon="trash" danger disabled={busy || !!unresolvedUpdate} onPress={confirmDelete} /></Section>}
  </Screen>;
}

const styles = StyleSheet.create({
  member: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 5 },
  dateButtons: { flexDirection: 'row', gap: 10 },
});
