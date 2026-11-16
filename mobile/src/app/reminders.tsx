import { useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import { Card, GlassButton, Icon, Notice, Screen, Section, Txt } from '@/components/pocket-ui';
import { usePocket, useReminders } from '@/data';

export default function RemindersScreen() {
  const { state } = usePocket();
  const reminders = useReminders();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parent = state?.user.role === 'parent';
  async function run(action: () => Promise<void>) {
    if (working || reminders.syncing) return;
    setWorking(true); setError(null);
    try { await action(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not update Reminders.'); }
    finally { setWorking(false); }
  }
  function disconnect() {
    Alert.alert('Turn off Reminders sync?', 'Pocket will stop updating its Reminders list. The list and completed reminders will stay in Apple Reminders. Subscription charges in Pocket will continue.', [
      { text: 'Cancel', style: 'cancel', isPreferred: true },
      { text: 'Turn off sync', onPress: () => void run(reminders.disconnect) },
    ], { cancelable: true });
  }
  return <Screen topSafe={false} title="Apple Reminders" subtitle="Your subscription list, kept in sync.">
    <Card style={{ padding: 24, gap: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}><Icon name="reminders" size={30} /><Txt size={22} weight="600">{reminders.enabled ? 'Connected' : 'Connect your list'}</Txt></View>
      <Txt>Pocket creates a separate list for {parent ? 'all your kids’ subscriptions' : 'your subscriptions'} in Apple Reminders.</Txt>
      <Txt muted size={14}>When a billing period is charged in Pocket, its reminder is checked off and the next charge appears. Checking off a reminder yourself does not change your balance.</Txt>
    </Card>
    {!reminders.available ? <Notice message={Platform.OS === 'ios' ? 'Apple Reminders needs the updated Pocket iPhone app. Expo Go cannot access it. Install the new signed app to connect your list.' : 'Apple Reminders sync is available in the Pocket iPhone app.'} /> : reminders.enabled ? <Section title="Sync">
      <Card><Txt weight="600">{`Pocket · ${state?.familyName ?? ''} · ${state?.user.name ?? ''}`}</Txt><Txt muted size={14}>{reminders.lastSync ? `Last synced ${new Date(reminders.lastSync).toLocaleString()}` : 'The first sync is waiting.'}</Txt></Card>
      <GlassButton label={reminders.syncing ? 'Syncing' : 'Sync now'} icon="repeat" prominent busy={reminders.syncing || working} onPress={() => void run(reminders.sync)} />
      <GlassButton label="Turn off sync" icon="pause" disabled={working || reminders.syncing} onPress={disconnect} />
    </Section> : <GlassButton label="Connect Apple Reminders" icon="reminders" prominent busy={working || reminders.syncing} onPress={() => void run(reminders.connect)} />}
    <Notice message={error ?? reminders.error} />
    <Txt muted size={13}>Sync runs while Pocket is open and when you return to it. It does not run continuously in the background. The server keeps charging subscriptions while the app is closed.</Txt>
    <Txt muted size={13}>Reminders access is requested only when you connect. Each Pocket account uses its own list on this iPhone.</Txt>
  </Screen>;
}
