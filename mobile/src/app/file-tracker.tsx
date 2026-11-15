import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { Card, Field, GlassButton, Icon, Notice, Screen, Section, Txt } from '@/components/pocket-ui';
import { centsFromInput, FTS_SERVER_UPDATE_MESSAGE, money, type FTSIssuer, type IssuedFTSKey, usePocket } from '@/data';

export default function FileTrackerConnection() {
  const { state, serverURL, listFTSIssuers, checkFTSSupport, createFTSIssuer, revokeFTSIssuer } = usePocket();
  const [issuers, setIssuers] = useState<FTSIssuer[]>([]);
  const [name, setName] = useState('File Tracker');
  const [price, setPrice] = useState('0.15');
  const [created, setCreated] = useState<IssuedFTSKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const cents = centsFromInput(price);
  const expired = !!created && Date.parse(created.expiresAt) <= now;
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void Promise.allSettled([listFTSIssuers(), checkFTSSupport()]).then(([list, support]) => {
      if (cancelled) return;
      if (list.status === 'fulfilled') setIssuers(list.value);
      else setError(list.reason instanceof Error ? list.reason.message : 'Could not load computers.');
      if (support.status === 'fulfilled') setSupported(support.value);
      setLoading(false);
    });
    return () => { cancelled = true; mounted.current = false; };
  }, [listFTSIssuers, checkFTSSupport]);
  useEffect(() => {
    if (!created) return;
    const remaining = Math.max(0, Date.parse(created.expiresAt) - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.min(remaining + 50, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [created]);

  async function create() {
    if (pending.current || loading || refreshing || cents === null || !name.trim()) return;
    pending.current = true; setBusy(true); setError(null); setNote(null);
    try {
      const result = await createFTSIssuer(name, cents);
      if (mounted.current) { setCreated(result); setNow(Date.now()); setIssuers(values => [...values, result.issuer]); }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not connect File Tracker.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function revoke(id: string) {
    if (pending.current || refreshing) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const issuer = await revokeFTSIssuer(id);
      if (mounted.current) { setIssuers(values => values.map(value => value.id === id ? issuer : value)); if (created?.issuer.id === id) setCreated(null); }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not remove this computer.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function confirmRevoke(issuer: FTSIssuer) {
    Alert.alert('Remove computer?', `Unused codes from ${issuer.name} will stop working. Money already added will stay in the balance.`, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Remove computer', style: 'destructive', onPress: () => void revoke(issuer.id) },
    ]);
  }
  async function refreshComputers() {
    if (pending.current || loading || refreshing) return;
    pending.current = true;
    setRefreshing(true); setError(null);
    try {
      const [list, support] = await Promise.allSettled([listFTSIssuers(), checkFTSSupport()]);
      if (!mounted.current) return;
      if (list.status === 'fulfilled') setIssuers(list.value);
      else setError(list.reason instanceof Error ? list.reason.message : 'Could not load computers.');
      if (support.status === 'fulfilled') setSupported(support.value);
    } finally { pending.current = false; if (mounted.current) setRefreshing(false); }
  }
  async function copy(value: string, message: string) {
    try { await Clipboard.setStringAsync(value, { android: { isSensitive: true }, ios: { localOnly: true, expiresAt: new Date(Date.now() + 5 * 60_000) } }); setNote(message); }
    catch { setError('Could not copy. Try again.'); }
  }
  function copySetupCode() {
    if (!created) return;
    if (Date.parse(created.expiresAt) <= Date.now()) { setNow(Date.now()); setNote(null); return; }
    void copy(created.setupCode, 'Setup key copied. Enter all 8 digits in FTS.');
  }
  if (!state) return null;
  return <Screen topSafe={false} title="File Tracker" subtitle="Turn completed edits into earnings." onRefresh={() => void refreshComputers()} refreshing={refreshing}>
    <Card><Icon name="computer" size={36} /><Txt>Connect your FTS computer once. It can then create QR codes for report earnings at the price you approve.</Txt><Txt muted size={13}>Only connect a computer you trust. A child who scans a code receives its earnings; a parent chooses which child receives them.</Txt></Card>
    {state.user.role === 'parent' && <Txt muted size={13}>You can view and remove every family computer. Setup and connection activity is logged in your Inbox.</Txt>}
    {supported === false && <Notice message={FTS_SERVER_UPDATE_MESSAGE} />}
    <Notice message={supported === false && error === FTS_SERVER_UPDATE_MESSAGE ? null : error} />
    {created ? <Section title="Finish setup in FTS">
      <Card>
        <Txt weight="600">{created.issuer.name} · {money(created.issuer.priceCents)} per edit</Txt>
        <Txt muted size={13}>In FTS, open Pocket setup and enter this server address and the 8-digit setup key.</Txt>
        <Field label="Server address" value={serverURL} editable={false} />
        <GlassButton label="Copy server address" icon="copy" onPress={() => void copy(serverURL, 'Server address copied.')} />
        <Txt muted size={13}>Setup key · 8 digits</Txt>
        {expired ? <Notice message="This setup key expired. Create a new key to connect FTS." /> : <>
          <Txt size={34} weight="700" style={{ fontFamily: Platform.OS === 'ios' ? 'ui-monospace' : 'monospace', fontVariant: ['tabular-nums'], letterSpacing: 2, textAlign: 'center' }}>{created.setupCode}</Txt>
          <Txt muted size={13}>Use once within 10 minutes. Expires at {new Date(created.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.</Txt>
          <GlassButton label="Copy setup key" icon="copy" prominent onPress={copySetupCode} />
        </>}
        {note && !expired && <Txt muted>{note}</Txt>}
        <GlassButton label={expired ? 'Create another key' : 'Done'} onPress={() => { setCreated(null); setNote(null); }} />
      </Card>
    </Section> : <Section title="Connect a computer"><Card><Field label="Computer name" value={name} onChangeText={setName} maxLength={60} editable={!busy} /><Field label="Price per edit · USD" value={price} onChangeText={setPrice} keyboardType="decimal-pad" maxLength={12} editable={!busy} /><Txt muted size={13}>Use the same price in FTS budget settings.</Txt><GlassButton label="Create setup key" prominent busy={busy || loading} disabled={refreshing || !name.trim() || cents === null} onPress={() => void create()} /></Card></Section>}
    <Section title={state.user.role === 'parent' ? 'Family computers' : 'Your computers'}>
      <GlassButton label="Refresh computers" busy={refreshing} disabled={busy || loading} onPress={() => void refreshComputers()} />
      {issuers.map(issuer => <Card key={issuer.id}>
        <Txt weight="600">{issuer.name}</Txt>
        {issuer.ownerName && <Txt muted size={14}>Owner: {issuer.ownerName}</Txt>}
        <Txt muted>{money(issuer.priceCents)} per edit · {issuer.revokedAt ? 'Removed' : issuer.pairedAt === null ? 'Awaiting setup' : issuer.pairedAt ? 'Connected' : 'Connection'}</Txt>
        {!issuer.revokedAt && <GlassButton label="Remove computer" danger disabled={busy || refreshing} onPress={() => confirmRevoke(issuer)} />}
      </Card>)}
      {!loading && !issuers.length && <Txt muted>No computers yet.</Txt>}
    </Section>
  </Screen>;
}
