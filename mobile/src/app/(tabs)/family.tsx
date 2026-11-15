import Constants, { ExecutionEnvironment } from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Avatar, Card, GlassButton, Icon, Notice, Row, Screen, Section, Txt, usePalette } from '@/components/pocket-ui';
import { money, usePocket } from '@/data';

export default function FamilyScreen() {
  const { state, serverURL, busy, error, refresh, signOut } = usePocket();
  const colors = usePalette();
  const [refreshing, setRefreshing] = useState(false);
  const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient && Constants.expoVersion != null;
  const isParent = state?.user.role === 'parent';
  const members = state?.members ?? [];

  async function reload() {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }

  function confirmSignOut() {
    Alert.alert('Sign out of Pocket?', 'You can sign in again with your family account.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => { void signOut().catch(() => undefined); } },
    ]);
  }

  return (
    <Screen title="Family" subtitle={state?.familyName} onRefresh={reload} refreshing={refreshing}>
      {error ? <Notice message={error} /> : null}
      {state ? (
        <Card style={styles.account}>
          <Avatar name={state.user.name} id={state.user.id} size={60} />
          <View style={styles.accountText}>
            <Txt size={22} weight="700">{state.user.name}</Txt>
            <Txt muted>{state.user.role === 'parent' ? 'Parent' : 'Child'} · @{state.user.username}</Txt>
          </View>
        </Card>
      ) : null}
      {isParent ? (
        <Section title="Members">
          <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
            {members.map((member, index) => {
              const isChild = member.role === 'child';
              const content = (
                <>
                  <Avatar name={member.name} id={member.id} size={42} />
                  <View style={styles.memberText}>
                    <Txt weight="600">{member.name}</Txt>
                    <Txt size={13} muted>{isChild ? 'Child' : 'Parent'}{member.id === state?.user.id ? ' · You' : ''}</Txt>
                  </View>
                  {isChild ? <Txt weight="600">{money(member.balanceCents ?? 0)}</Txt> : null}
                  {isChild ? <Icon name="chevron" size={14} color={colors.secondary} /> : null}
                </>
              );
              const border = index > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line } : undefined;
              return isChild ? (
                <Pressable key={member.id} accessibilityRole="button" accessibilityLabel={`${member.name}, ${money(member.balanceCents ?? 0)}, view balance`}
                  onPress={() => router.push({ pathname: '/child/[id]', params: { id: member.id } })}
                  style={({ pressed }) => [styles.member, border, pressed && { backgroundColor: colors.soft }]}>{content}</Pressable>
              ) : <View key={member.id} style={[styles.member, border]}>{content}</View>;
            })}
          </Card>
          <GlassButton label="Add member" icon="plus" onPress={() => router.push('/member')} />
        </Section>
      ) : null}
      <Section title="Connection">
        <Card><Row icon="server" title="Server" detail={serverURL} onPress={() => router.push('/server')} /></Card>
        {isParent && <Card><Row icon="computer" title="File Tracker" detail="Connect a computer to issue earnings codes." onPress={() => router.push('/file-tracker')} /></Card>}
      </Section>
      <Section title="Safari purchases">
        <Card style={styles.info}>
          <Icon name="safari" size={26} color={colors.accent} />
          <Txt weight="600">{isExpoGo ? 'A separate iPhone build is needed' : Platform.OS === 'ios' ? 'Enable Pocket in Safari' : 'Available on iPhone'}</Txt>
          <Txt size={14} muted>{isExpoGo
            ? 'Expo Go cannot include the Safari extension. You can record purchases in Pocket now.'
            : Platform.OS === 'ios'
              ? 'In Settings, open Apps → Safari → Extensions and enable Pocket. In Safari, sign in as a child and enable each store.'
              : 'Safari receipt capture requires the Pocket iPhone app with its extension.'}</Txt>
          <Txt size={13} muted>Only clear USD order confirmations on enabled sites can be recorded automatically.</Txt>
        </Card>
      </Section>
      <Section title="Notifications">
        <Card><Row icon="inbox" title="In-app inbox" detail="Parents and the child involved receive each balance change. Open Pocket to see updates." onPress={() => router.push('/(tabs)/inbox')} /></Card>
        <Txt size={13} muted>Background phone alerts are not enabled in this app.</Txt>
      </Section>
      <GlassButton label="Sign out" icon="logout" danger disabled={busy} onPress={confirmSignOut} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  account: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 20 },
  accountText: { flex: 1, gap: 4 },
  member: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, minHeight: 76 },
  memberText: { flex: 1, gap: 4 },
  info: { padding: 20, gap: 12 },
});
