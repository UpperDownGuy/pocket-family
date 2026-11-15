import { useRef, useState } from 'react';
import { router, usePreventRemove } from 'expo-router';
import { type MemberRole, usePocket } from '@/data';
import { Card, Choice, Empty, Field, GlassButton, Notice, Screen, Txt } from '@/components/pocket-ui';
export default function AddMember() {
  const pocket = usePocket();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<MemberRole>('child');
  const [saving, setSaving] = useState(false);
  const disablePrevention = usePreventRemove(saving);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  async function save() {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError(null);
    try { await pocket.addMember({ name: name.trim(), username: username.trim(), password, role }); setPassword(''); disablePrevention(); router.back(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not add this member.'); }
    finally { pending.current = false; setSaving(false); }
  }
  if (pocket.state?.user.role !== 'parent') return <Screen topSafe={false}><Empty icon="family" title="Parents only" detail="A parent can add family members." /></Screen>;
  return <Screen topSafe={false}><Card><Field label="Name" value={name} onChangeText={setName} textContentType="givenName" editable={!saving} maxLength={60} />{!saving && <Choice options={[{ label: 'Child', value: 'child' }, { label: 'Parent', value: 'parent' }]} value={role} onChange={value => setRole(value as MemberRole)} />}</Card><Card><Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" editable={!saving} maxLength={32} /><Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" textContentType="newPassword" editable={!saving} /><Txt muted size={13}>Use at least 10 characters. Each person signs in with their own account.</Txt></Card><Notice message={error} /><GlassButton label="Add member" icon="plus" prominent busy={saving} disabled={!name.trim() || !username.trim() || password.length < 10} onPress={() => void save()} /></Screen>;
}
