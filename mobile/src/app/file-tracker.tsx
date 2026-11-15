import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { Card, Field, GlassButton, Icon, Notice, Screen, Section, Txt } from '@/components/pocket-ui';
import { centsFromInput, money, type FTSIssuer, type IssuedFTSKey, usePocket } from '@/data';

export default function FileTrackerConnection() {
  const { state, serverURL, listFTSIssuers, createFTSIssuer, revokeFTSIssuer } = usePocket();
  const [issuers, setIssuers] = useState<FTSIssuer[]>([]);
  const [name, setName] = useState('File Tracker');
  const [price, setPrice] = useState('0.15');
  const [created, setCreated] = useState<IssuedFTSKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const pending = useRef(false);
  const mounted = useRef(true);
  const cents = centsFromInput(price);
  useEffect(() => {
    mounted.current = true;
    void listFTSIssuers().then(values => { if (mounted.current) setIssuers(values); }).catch(caught => { if (mounted.current) setError(String(caught.message ?? caught)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [listFTSIssuers]);

  async function create() {
    if (pending.current || loading || cents === null || !name.trim()) return;
    pending.current = true; setBusy(true); setError(null); setNote(null);
    try {
      const result = await createFTSIssuer(name, cents);
      if (mounted.current) { setCreated(result); setShowKey(false); setIssuers(values => [...values, result.issuer]); }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not connect File Tracker.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function revoke(id: string) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const issuer = await revokeFTSIssuer(id);
      if (mounted.current) { setIssuers(values => values.map(value => value.id === id ? issuer : value)); if (created?.issuer.id === id) setCreated(null); }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : 'Could not remove this connection.'); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  function confirmRevoke(issuer: FTSIssuer) {
    Alert.alert('Remove File Tracker connection?', `Unused codes from ${issuer.name} will stop working. Money already added will stay in the balance.`, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Remove connection', style: 'destructive', onPress: () => void revoke(issuer.id) },
    ]);
  }
  async function copy(value: string, message: string) {
    try { await Clipboard.setStringAsync(value, { android: { isSensitive: true }, ios: { localOnly: true, expiresAt: new Date(Date.now() + 5 * 60_000) } }); setNote(message); }
    catch { setError('Could not copy. Try again.'); }
  }
  if (!state) return null;
  return <Screen topSafe={false} title="File Tracker" subtitle="Turn completed edits into earnings.">
    <Card><Icon name="computer" size={36} /><Txt>Connect your FTS computer once. It can then create QR codes for report earnings at the price you approve.</Txt><Txt muted size={13}>Only connect a computer you trust. A child who scans a code receives its earnings; a parent chooses which child receives them.</Txt></Card>
    <Notice message={error} />
    {created ? <Section title="Finish setup in FTS"><Card><Txt weight="600">{created.issuer.name} · {money(created.issuer.priceCents)} per edit</Txt><Txt muted size={13}>In FTS, open Pocket setup and enter this server address and setup key. The key is shown only here.</Txt><Field label="Server address" value={serverURL} editable={false} /><GlassButton label="Copy server address" icon="copy" onPress={() => void copy(serverURL, 'Server address copied.')} /><Field label="Setup key" value={created.token} editable={false} secureTextEntry={!showKey} multiline={showKey} /><GlassButton label={showKey ? 'Hide key' : 'Show key'} onPress={() => setShowKey(value => !value)} /><GlassButton label="Copy setup key" icon="copy" prominent onPress={() => void copy(created.token, 'Setup key copied. Paste it into FTS.')} />{note && <Txt muted>{note}</Txt>}<GlassButton label="I saved the key" onPress={() => { setCreated(null); setNote(null); setShowKey(false); }} /></Card></Section> : <Section title="Connect a computer"><Card><Field label="Computer name" value={name} onChangeText={setName} maxLength={100} editable={!busy} /><Field label="Price per edit · USD" value={price} onChangeText={setPrice} keyboardType="decimal-pad" maxLength={12} editable={!busy} /><Txt muted size={13}>Use the same price in FTS budget settings.</Txt><GlassButton label="Create setup key" prominent busy={busy || loading} disabled={!name.trim() || cents === null} onPress={() => void create()} /></Card></Section>}
    {!!issuers.length && <Section title={state.user.role === 'parent' ? 'Family connections' : 'Your connections'}>{issuers.map(issuer => <Card key={issuer.id}><Txt weight="600">{issuer.name}</Txt><Txt muted>{money(issuer.priceCents)} per edit · {issuer.revokedAt ? 'Removed' : 'Connected'}</Txt>{!issuer.revokedAt && <GlassButton label="Remove connection" danger disabled={busy} onPress={() => confirmRevoke(issuer)} />}</Card>)}</Section>}
  </Screen>;
}
