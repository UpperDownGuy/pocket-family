import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Card, Choice, dateLabel, Empty, GlassButton, Icon, Notice, Screen, Txt, usePalette } from '@/components/pocket-ui';
import { inboxDestination, inboxItems, usePocket } from '@/data';

export default function InboxScreen() {
  const { state, busy, error, refresh, markRead } = usePocket();
  const colors = usePalette();
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const notifications = useMemo(() => inboxItems(state), [state]);
  const unreadIds = notifications.filter(item => !item.readAt).map(item => item.id);
  const visible = notifications.filter(item => filter === 'all' || !item.readAt);

  async function reload() {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }

  return (
    <Screen title="Inbox" onRefresh={reload} refreshing={refreshing}>
      {error ? <Notice message={error} /> : null}
      <Choice value={filter} onChange={setFilter} options={[
        { label: 'All', value: 'all' },
        { label: `Unread${unreadIds.length ? ` (${unreadIds.length})` : ''}`, value: 'unread' },
      ]} />
      {unreadIds.length ? (
        <GlassButton
          label="Mark all read"
          icon="check"
          disabled={busy}
          onPress={() => { void markRead(unreadIds).catch(() => undefined); }}
        />
      ) : null}
      {visible.length ? (
        <Card style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
          {visible.map((item, index) => (
            <Pressable
              key={`${item.category}:${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={`${item.readAt ? '' : 'Unread. '}${item.title}. ${item.body}. ${dateLabel(item.createdAt)}`}
              onPress={() => {
                if (item.category === 'computer' && !item.readAt) void markRead([item.id]).catch(() => undefined);
                router.push(inboxDestination(item));
              }}
              style={({ pressed }) => [styles.notification, index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }, pressed && { backgroundColor: colors.soft }]}
            >
              <View style={[styles.indicator, { backgroundColor: item.readAt ? 'transparent' : colors.accent }]} />
              {item.category === 'computer' && <Icon name="computer" size={21} />}
              <View style={styles.message}>
                <Txt weight={item.readAt ? '500' : '700'}>{item.title}</Txt>
                <Txt size={14} muted>{item.body}</Txt>
                <Txt size={12} muted>{dateLabel(item.createdAt)}</Txt>
              </View>
              <Icon name="chevron" size={14} color={colors.secondary} />
            </Pressable>
          ))}
        </Card>
      ) : (
        <Empty
          icon="inbox"
          title={filter === 'unread' ? 'No unread activity' : 'Your inbox is empty'}
          detail={state?.user.role === 'parent' ? 'Balance changes and family computer activity will appear here.' : 'Balance changes for you will appear here.'}
        />
      )}
      <Txt size={13} muted>Updates appear here while Pocket is open.</Txt>
    </Screen>
  );
}

const styles = StyleSheet.create({
  notification: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 18, paddingHorizontal: 16, minHeight: 92 },
  indicator: { width: 7, height: 7, borderRadius: 4 },
  message: { flex: 1, gap: 5 },
});
