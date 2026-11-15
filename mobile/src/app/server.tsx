import { useState } from 'react';
import { router, usePreventRemove } from 'expo-router';
import { usePocket } from '@/data';
import { Card, Field, GlassButton, Notice, Screen, Txt } from '@/components/pocket-ui';
export default function Server() {
  const pocket = usePocket();
  const [address, setAddress] = useState(pocket.serverURL);
  const [saving, setSaving] = useState(false);
  const disablePrevention = usePreventRemove(saving);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (saving) return;
    setSaving(true); setError(null);
    try { await pocket.changeServer(address); disablePrevention(); if (router.canGoBack()) router.back(); else router.replace('/sign-in'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not connect.'); }
    finally { setSaving(false); }
  }
  return <Screen topSafe={false}><Card><Field label="Server address" value={address} onChangeText={setAddress} keyboardType="url" autoCapitalize="none" autoCorrect={false} placeholder="http://192.168.1.20:8787" editable={!saving} /><Txt muted size={14}>Enter your family server’s address. Your iPhone must be able to reach it. Changing servers signs you out.</Txt><Txt muted size={13}>127.0.0.1 points to this iPhone. Use your server’s local IP address or HTTPS address.</Txt></Card><Notice message={error} /><GlassButton label="Save" icon="check" prominent busy={saving} disabled={!address.trim()} onPress={() => void save()} /></Screen>;
}
