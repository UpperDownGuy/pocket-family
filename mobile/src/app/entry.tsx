import { useRef, useState } from 'react';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { Pressable, View } from 'react-native';
import { centsFromInput, createRequestID, money, type TransactionKind, usePocket } from '@/data';
import { Avatar, Card, Choice, Empty, Field, GlassButton, Icon, Notice, Screen, Txt, usePalette } from '@/components/pocket-ui';

export default function Entry() {
  const pocket = usePocket();
  const colors = usePalette();
  const params = useLocalSearchParams<{ childId?: string }>();
  const parent = pocket.state?.user.role === 'parent';
  const children = pocket.state?.members.filter(member => member.role === 'child') ?? [];
  const [childID, setChildID] = useState(params.childId ?? (parent ? children[0]?.id ?? '' : pocket.state?.user.id ?? ''));
  const [kind, setKind] = useState<TransactionKind>(parent ? 'addition' : 'purchase');
  const [amount, setAmount] = useState('');
  const [merchant, setMerchant] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const disablePrevention = usePreventRemove(saving);
  const pending = useRef(false);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const cents = centsFromInput(amount);
  const child = children.find(member => member.id === childID);
  async function save() {
    if (pending.current || cents === null || !child) return;
    pending.current = true; setSaving(true); setError(null);
    const input = { childId: child.id, kind: parent ? kind : 'purchase' as const, amountCents: cents, merchant: merchant.trim(), note: note.trim() };
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: createRequestID() };
    try { await pocket.recordTransaction({ ...input, idempotencyKey: attempt.current.key }); disablePrevention(); router.back(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not save. Try again.'); }
    finally { pending.current = false; setSaving(false); }
  }
  if (!children.length) return <Screen topSafe={false}><Empty icon="family" title="Add a child first" detail="A child account is needed to record a balance change." /></Screen>;
  return <Screen topSafe={false}>
    {parent && <Card><Txt size={14} muted>For</Txt>{children.map(member => <Pressable key={member.id} accessibilityRole="radio" accessibilityState={{ checked: childID === member.id, disabled: saving }} disabled={saving} onPress={() => setChildID(member.id)}><View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 5 }}><Avatar name={member.name} id={member.id} size={38} /><View style={{ flex: 1 }}><Txt weight="600">{member.name}</Txt></View>{childID === member.id && <Icon name="check" />}</View></Pressable>)}</Card>}
    {parent && !saving && <Choice options={[{ label: 'Add money', value: 'addition' }, { label: 'Purchase', value: 'purchase' }]} value={kind} onChange={value => setKind(value as TransactionKind)} />}
    <Card><Field label="Amount · USD" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" editable={!saving} maxLength={12} style={{ fontSize: 34, fontWeight: '600', color: colors.accent }} /><Field label={kind === 'addition' ? 'Reason' : 'Store'} value={merchant} onChangeText={setMerchant} placeholder={kind === 'addition' ? 'Allowance' : 'Store name'} editable={!saving} maxLength={100} /><Field label={kind === 'purchase' ? 'What was bought? (optional)' : 'Note (optional)'} value={note} onChangeText={setNote} multiline editable={!saving} maxLength={300} /></Card>
    <Txt muted size={13}>{child?.name} and the parents will receive an Inbox update.</Txt>
    {!!amount && cents === null && <Notice message="Enter an amount from $0.01 to $10,000.00, with up to two decimal places." />}
    <Notice message={error} /><GlassButton label={cents === null ? 'Save' : `${kind === 'addition' ? 'Add' : 'Record'} ${money(cents)}`} icon={kind === 'addition' ? 'plus' : 'bag'} prominent busy={saving} disabled={cents === null || !merchant.trim() || !child} onPress={() => void save()} />
  </Screen>;
}
