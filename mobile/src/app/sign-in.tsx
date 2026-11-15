import { useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import { usePocket } from '@/data';
import { Card, Field, GlassButton, Icon, Notice, Screen, Txt } from '@/components/pocket-ui';

export default function SignIn() {
  const pocket = usePocket();
  const [familyName, setFamilyName] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  async function submit() {
    if (submitting) return;
    setSubmitting(true); setError(null); pocket.clearError();
    try {
      if (pocket.setupRequired) await pocket.setup({ familyName: familyName.trim(), name: name.trim(), username: username.trim(), password, setupCode });
      else await pocket.signIn(username.trim(), password);
      setPassword(''); setSetupCode('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not sign in.'); }
    finally { setSubmitting(false); }
  }
  if (pocket.signedIn) return <Screen title="Connecting"><Card><Txt>Loading your balances.</Txt><Notice message={pocket.error} /><GlassButton label="Try again" onPress={() => void pocket.refresh()} busy={pocket.busy} /><GlassButton label="Server settings" icon="server" onPress={() => router.push('/server')} /><GlassButton label="Sign out" onPress={() => void pocket.signOut().catch(caught => setError(String(caught)))} /><Notice message={error} /></Card></Screen>;
  return <Screen>
    <View style={{ gap: 16, paddingTop: 32, paddingBottom: 8 }}><Icon name="wallet" size={48} /><Txt size={46} weight="700">Pocket</Txt><Txt muted size={20}>{pocket.setupRequired ? 'Set up your family' : 'Sign in'}</Txt></View>
    <Card>
      {pocket.setupRequired && <><Field label="Family name" value={familyName} onChangeText={setFamilyName} editable={!submitting} /><Field label="Your name" value={name} onChangeText={setName} textContentType="givenName" editable={!submitting} /></>}
      <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" editable={!submitting} />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" textContentType={pocket.setupRequired ? 'newPassword' : 'password'} editable={!submitting} />
      {pocket.setupRequired && <><Field label="Setup code" value={setupCode} onChangeText={setSetupCode} autoCapitalize="none" autoCorrect={false} secureTextEntry editable={!submitting} /><Txt muted size={13}>Use the setup code shown by your server. Passwords need at least 10 characters.</Txt></>}
    </Card>
    <Notice message={error ?? pocket.error} />
    <GlassButton label={pocket.setupRequired ? 'Create family' : 'Sign in'} prominent busy={submitting} disabled={!username.trim() || !password || (pocket.setupRequired && (!name.trim() || !familyName.trim() || !setupCode || password.length < 10))} onPress={() => void submit()} />
    <GlassButton label="Server settings" icon="server" onPress={() => router.push('/server')} disabled={submitting} />
    <Txt muted size={12} style={{ textAlign: 'center' }}>{pocket.serverURL}</Txt>
  </Screen>;
}
