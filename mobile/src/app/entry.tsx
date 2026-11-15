import { useRef, useState } from 'react';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { Pressable, View } from 'react-native';
import { centsFromInput, createRequestID, money, paymentAttempt, type PaymentAttempt, type TransactionKind, usePocket } from '@/data';
import { Avatar, Card, Choice, Empty, Field, GlassButton, Icon, Notice, Screen, Txt, usePalette } from '@/components/pocket-ui';
import { PayButton } from '@/components/payment-ui';

export default function Entry() {
  const pocket = usePocket();
  const colors = usePalette();
  const params = useLocalSearchParams<{ childId?: string }>();
  const parent = pocket.state?.user.role === 'parent';
  const children = pocket.state?.members.filter(member => member.role === 'child') ?? [];
  const unresolved = pocket.pendingTransaction;
  const [childID, setChildID] = useState(unresolved?.childId ?? params.childId ?? (parent ? children[0]?.id ?? '' : pocket.state?.user.id ?? ''));
  const [kind, setKind] = useState<TransactionKind>(unresolved?.kind ?? (parent ? 'addition' : 'purchase'));
  const [amount, setAmount] = useState(unresolved ? (unresolved.amountCents / 100).toFixed(2) : '');
  const [merchant, setMerchant] = useState(unresolved?.merchant ?? '');
  const [note, setNote] = useState(unresolved?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [paid, setPaid] = useState(false);
  const disablePrevention = usePreventRemove(saving);
  const pending = useRef(false);
  const attempt = useRef<PaymentAttempt | null>(null);
  const cents = centsFromInput(amount);
  const child = children.find(member => member.id === childID);
  async function save() {
    if (pending.current || paid || cents === null || !child) return;
    pending.current = true; setSaving(true); setError(null);
    const input = { childId: child.id, kind: parent ? kind : 'purchase' as const, amountCents: cents, merchant: merchant.trim(), note: note.trim() };
    attempt.current = paymentAttempt(input, attempt.current, createRequestID);
    try {
      await pocket.recordTransaction({ ...input, idempotencyKey: attempt.current.key });
      disablePrevention();
      if (parent && kind === 'addition') setPaid(true);
      else router.back();
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save. Try again.'); }
    finally { pending.current = false; setSaving(false); }
  }
  if (!children.length) return <Screen topSafe={false}><Empty icon="family" title="Add a child first" detail="A child account is needed to record a balance change." /></Screen>;
  if (paid) return <Screen topSafe={false}>
    <Card style={{ alignItems: 'center', padding: 30, gap: 16 }}><Avatar name={child?.name ?? ''} id={childID} size={66} /><Txt size={16} muted>Paid to {child?.name}</Txt><Txt size={44} weight="700" style={{ color: colors.accent, fontVariant: ['tabular-nums'] }}>{money(cents ?? 0)}</Txt><Txt muted style={{ textAlign: 'center' }}>Added to their Pocket balance.</Txt></Card>
    <PayButton label="Pay" status="paid" onPress={() => undefined} />
    <GlassButton label="Done" onPress={() => router.back()} />
  </Screen>;
  return <Screen topSafe={false}>
    {unresolved && !saving && <Notice message="This payment is not confirmed yet. Retry it to check the same request; it will not be added twice." />}
    {parent && <Card><Txt size={14} muted>For</Txt>{children.map(member => <Pressable key={member.id} accessibilityRole="radio" accessibilityState={{ checked: childID === member.id, disabled: saving || !!unresolved }} disabled={saving || !!unresolved} onPress={() => setChildID(member.id)}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 5 }}><Avatar name={member.name} id={member.id} size={38} /><View style={{ flex: 1 }}><Txt weight="600">{member.name}</Txt></View>{childID === member.id && <Icon name="check" />}</View></Pressable>)}</Card>}
    {parent && !saving && !unresolved && <Choice options={[{ label: 'Pay', value: 'addition' }, { label: 'Purchase', value: 'purchase' }]} value={kind} onChange={value => setKind(value as TransactionKind)} />}
    <Card><Field label="Amount · USD" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" editable={!saving && !unresolved} maxLength={12} style={{ fontSize: 34, fontWeight: '600', color: colors.accent }} /><Field label={kind === 'addition' ? 'Reason' : 'Store'} value={merchant} onChangeText={setMerchant} placeholder={kind === 'addition' ? 'Allowance' : 'Store name'} editable={!saving && !unresolved} maxLength={100} /><Field label={kind === 'purchase' ? 'What was bought? (optional)' : 'Note (optional)'} value={note} onChangeText={setNote} multiline editable={!saving && !unresolved} maxLength={300} /></Card>
    <Txt muted size={13}>{child?.name} and the parents will receive an Inbox update.</Txt>
    {!!amount && cents === null && <Notice message="Enter an amount from $0.01 to $10,000.00, with up to two decimal places." />}
    <Notice message={error} />{parent && kind === 'addition' ? <PayButton label={cents === null ? 'Pay' : `Pay ${money(cents)}`} status={saving ? 'paying' : 'idle'} disabled={cents === null || !merchant.trim() || !child} onPress={() => void save()} /> : <GlassButton label={cents === null ? 'Record purchase' : `Record ${money(cents)}`} icon="bag" prominent busy={saving} disabled={cents === null || !merchant.trim() || !child} onPress={() => void save()} />}
  </Screen>;
}
