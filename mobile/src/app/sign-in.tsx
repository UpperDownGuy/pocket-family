import { useRef, useState } from 'react';
import { router } from 'expo-router';
import { View } from 'react-native';
import { FAMILY_UPDATE_MESSAGE, usePocket } from '@/data';
import { Card, Field, GlassButton, Icon, Notice, Screen, Txt } from '@/components/pocket-ui';

type SignInProps = { notice?: string; nativeHeader?: boolean };
export default function SignIn(props: SignInProps = {}) {
  const { serverURL, familyCodeHint, signedIn } = usePocket();
  return <SignInForm key={`${serverURL}:${familyCodeHint}:${signedIn}`} {...props} />;
}

function SignInForm({ notice, nativeHeader = false }: SignInProps) {
  const pocket = usePocket();
  const [creating, setCreating] = useState(false);
  const [familyName, setFamilyName] = useState('');
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [familyCode, setFamilyCode] = useState(pocket.familyCodeHint);
  const [setupCode, setSetupCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const legacySetup = pocket.setupRequired && !pocket.familyRegistrationAvailable;
  const creationForm = creating || legacySetup;
  async function submit() {
    if (pending.current) return;
    pending.current = true; setSubmitting(true); setError(null); pocket.clearError();
    try {
      if (legacySetup) await pocket.setup({ familyName: familyName.trim(), name: name.trim(), username: username.trim(), password, setupCode });
      else if (creating) await pocket.createFamily({ familyName: familyName.trim(), name: name.trim(), username: username.trim(), password });
      else await pocket.signIn(username.trim(), password, familyCode.trim() || undefined);
      setPassword(''); setSetupCode('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not sign in.'); }
    finally { pending.current = false; setSubmitting(false); }
  }
  function changeMode(create: boolean) {
    setCreating(create); setError(null); setPassword(''); setSetupCode('');
    setUsername(''); setName(''); setFamilyName(''); pocket.clearError();
  }
  if (pocket.signedIn) return <Screen title="Connecting" topSafe={!nativeHeader}><Card><Txt>Loading your balances.</Txt><Notice message={pocket.error} /><GlassButton label="Try again" onPress={() => void pocket.refresh()} busy={pocket.busy} /><GlassButton label="Server settings" icon="server" onPress={() => router.push('/server')} /><GlassButton label="Sign out" onPress={() => void pocket.signOut().catch(caught => setError(String(caught)))} /><Notice message={error} /></Card></Screen>;
  const invalidCode = !!familyCode && !/^[0-9]{8}$/.test(familyCode);
  const disabled = !username.trim() || !password || (creationForm && (!name.trim() || !familyName.trim() || password.length < 10)) ||
    (legacySetup && !setupCode) || (!creationForm && invalidCode) || (creating && !legacySetup && !pocket.familyRegistrationAvailable);
  return <Screen topSafe={!nativeHeader}>
    {notice && <Card><Txt>{notice}</Txt></Card>}
    <View style={{ gap: 16, paddingTop: 32, paddingBottom: 8 }}><Icon name={creationForm ? 'family' : 'wallet'} size={48} /><Txt size={46} weight="700">Pocket</Txt><Txt muted size={20}>{creationForm ? 'Create your family' : 'Sign in'}</Txt></View>
    {creating && !legacySetup && !pocket.familyRegistrationAvailable ? <Card><Notice message={FAMILY_UPDATE_MESSAGE} /><GlassButton label="Check for server update" icon="server" busy={pocket.busy} onPress={() => void pocket.checkServer().catch(caught => setError(String(caught)))} /></Card> : null}
    <Card>
      {creationForm ? <><Field label="Family name" value={familyName} onChangeText={setFamilyName} editable={!submitting} maxLength={60} placeholder="Our family" /><Field label="Your name" value={name} onChangeText={setName} textContentType="givenName" editable={!submitting} maxLength={60} /><Txt muted size={13}>You’ll be the first parent. Add the other family members after signing in.</Txt></> : <><Field label="Family code" value={familyCode} onChangeText={setFamilyCode} keyboardType="number-pad" autoCapitalize="none" autoCorrect={false} maxLength={8} placeholder="8 digits" editable={!submitting} /><Txt muted size={13}>{pocket.multipleFamilies ? 'Find this in Pocket → Family. Your username and password are still required.' : 'Leave this blank on an older single-family server. Your username and password are still required.'}</Txt></>}
      <Field label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" editable={!submitting} maxLength={40} />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" textContentType={creationForm ? 'newPassword' : 'password'} editable={!submitting} />
      {creationForm && <Txt muted size={13}>Use at least 10 characters for your password.</Txt>}
      {legacySetup && <><Field label="Server setup code" value={setupCode} onChangeText={setSetupCode} autoCapitalize="none" autoCorrect={false} secureTextEntry editable={!submitting} /><Txt muted size={13}>This older server needs the setup code shown in its logs to create its first family.</Txt></>}
    </Card>
    {!creationForm && invalidCode && <Notice message="Enter all eight digits, including any leading zero." />}
    <Notice message={error ?? pocket.error} />
    <GlassButton label={creationForm ? 'Create a family' : 'Sign in'} icon={creationForm ? 'plus' : undefined} prominent busy={submitting} disabled={!!disabled} onPress={() => void submit()} />
    {creationForm ? !legacySetup && <GlassButton label="Back to sign in" disabled={submitting} onPress={() => changeMode(false)} /> : <Card><Txt size={16} weight="600">Starting your own family?</Txt><Txt muted size={14}>Create a separate family with its own members, balances, and activity.</Txt><GlassButton label="Create a family" icon="plus" prominent disabled={submitting} onPress={() => changeMode(true)} /></Card>}
    <GlassButton label="Server settings" icon="server" onPress={() => router.push('/server')} disabled={submitting} />
    <Txt muted size={12} style={{ textAlign: 'center' }}>{pocket.serverURL}</Txt>
  </Screen>;
}
