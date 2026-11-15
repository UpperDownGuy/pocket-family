import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Avatar, Card, Empty, GlassButton, Icon, Notice, Screen, Txt, usePalette } from '@/components/pocket-ui';
import { money, parseCreditCode, type CreditRedemption, type CreditVoucher, usePocket } from '@/data';
import SignIn from './sign-in';
import { PayButton } from '@/components/payment-ui';

export default function Redeem() {
  const { state, serverURL } = usePocket();
  const { code: rawCode } = useLocalSearchParams<{ code?: string | string[] }>();
  let code: string;
  try { code = parseCreditCode(rawCode); }
  catch { return <Screen topSafe={false}><Empty icon="qr" title="Invalid earnings code" detail="Scan the QR code shown in File Tracker." /><GlassButton label="Go to Pocket" onPress={() => router.replace('/(tabs)')} /></Screen>; }
  if (!state) return <SignIn nativeHeader notice="Sign in to redeem this File Tracker earnings code. The code will stay here while you sign in." />;
  return <RedeemCredit key={`${serverURL}:${state.user.id}:${code}`} code={code} />;
}

function RedeemCredit({ code }: { code: string }) {
  const { state, previewCredit, redeemCredit } = usePocket();
  const colors = usePalette();
  const [voucher, setVoucher] = useState<CreditVoucher | null>(null);
  const [result, setResult] = useState<CreditRedemption | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [childId, setChildId] = useState('');
  const [attemptChild, setAttemptChild] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const parent = state?.user.role === 'parent';
  const userId = state?.user.id;
  const children = state?.members.filter(member => member.role === 'child') ?? [];
  usePreventRemove(saving);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const checked = await previewCredit(code);
        if (cancelled) return;
        setVoucher(checked); setLoading(false);
        if (checked.status === 'issued' && !parent) {
          pending.current = true; setSaving(true);
          const added = await redeemCredit(code);
          if (!cancelled) setResult(added);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not redeem this code.');
      } finally {
        if (!cancelled) { setLoading(false); setSaving(false); pending.current = false; }
      }
    })();
    return () => { cancelled = true; };
  }, [code, parent, userId, previewCredit, redeemCredit, reload]);

  async function redeem() {
    if (pending.current || !voucher || voucher.status !== 'issued' || (parent && !childId)) return;
    pending.current = true; setSaving(true); setError(null);
    const recipient = parent ? (attemptChild ?? childId) : undefined;
    if (recipient) setAttemptChild(recipient);
    try {
      const added = await redeemCredit(code, recipient);
      if (mounted.current) setResult(added);
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not redeem this code. Try again.');
    } finally { if (mounted.current) { pending.current = false; setSaving(false); } }
  }

  if (loading) return <Screen topSafe={false}><Card><ActivityIndicator color={colors.accent} /><Txt>Checking earnings…</Txt></Card></Screen>;
  const redeemed = result || voucher?.status === 'redeemed';
  if (redeemed) return <Screen topSafe={false}><Card style={{ alignItems: 'center', padding: 30 }}><Icon name="check" size={44} /><Txt size={30} weight="700">{result && !result.replayed ? 'Added to balance' : 'Already redeemed'}</Txt><Txt size={38} weight="700" style={{ color: colors.accent }}>{money((result ?? voucher)!.amountCents)}</Txt><Txt muted style={{ textAlign: 'center' }}>{result && !result.replayed ? (parent ? `${children.find(member => member.id === childId)?.name ?? 'The child'} and the parents received an Inbox update.` : 'You and your parents received an Inbox update.') : 'This code cannot add money again.'}</Txt></Card><GlassButton label="Done" prominent onPress={() => router.replace('/(tabs)')} /></Screen>;
  if (voucher?.status === 'revoked') return <Screen topSafe={false}><Empty icon="computer" title="Connection removed" detail="The File Tracker connection that issued this code was removed." /><GlassButton label="Done" onPress={() => router.replace('/(tabs)')} /></Screen>;

  return <Screen topSafe={false} title="File Tracker earnings">
    {voucher && <Card><Txt muted>{voucher.editCount} edits · {voucher.reportCount} {voucher.reportCount === 1 ? 'report' : 'reports'}</Txt><Txt size={44} weight="700" style={{ color: colors.accent }}>{money(voucher.amountCents)}</Txt><Txt muted>{parent ? 'Choose who earned this money.' : saving ? 'Adding to your balance…' : 'These earnings will be added to your balance.'}</Txt></Card>}
    {parent && voucher && <Card><Txt weight="600">Add money to</Txt>{children.length ? children.map(child => <Pressable key={child.id} accessibilityRole="radio" accessibilityState={{ checked: child.id === childId, disabled: saving || attemptChild !== null }} disabled={saving || attemptChild !== null} onPress={() => setChildId(child.id)}><View style={{ flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 6 }}><Avatar id={child.id} name={child.name} size={42} /><View style={{ flex: 1 }}><Txt weight="600">{child.name}</Txt></View>{childId === child.id && <Icon name="check" />}</View></Pressable>) : <Txt muted>Add a child in Family before redeeming this code.</Txt>}</Card>}
    <Notice message={error} />
    {voucher ? parent ? <PayButton label={`Pay ${money(voucher.amountCents)}`} status={saving ? 'paying' : 'idle'} disabled={!childId} onPress={() => void redeem()} /> : <GlassButton label={saving ? 'Adding earnings' : 'Try again'} prominent icon="plus" busy={saving} onPress={() => void redeem()} /> : <GlassButton label="Try again" onPress={() => { setLoading(true); setError(null); setReload(value => value + 1); }} />}
    <Txt muted size={13}>Each code can be used once. FTS will show Redeemed when it receives the update.</Txt>
  </Screen>;
}
