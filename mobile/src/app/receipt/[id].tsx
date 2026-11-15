import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar, Card, dateLabel, Empty, GlassButton, Icon, Notice, Screen, Section, Txt, usePalette } from '@/components/pocket-ui';
import { money, usePocket } from '@/data';

export default function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const transactionId = Array.isArray(id) ? id[0] : id;
  const { state, error, refresh, markRead } = usePocket();
  const colors = usePalette();
  const [refreshing, setRefreshing] = useState(false);
  const item = state?.transactions.find(transaction => transaction.id === transactionId);
  const unreadKey = (state?.notifications ?? [])
    .filter(notification => notification.transactionId === transactionId && !notification.readAt)
    .map(notification => notification.id).sort().join(',');

  useFocusEffect(useCallback(() => {
    if (unreadKey) void markRead(unreadKey.split(',')).catch(() => undefined);
  }, [unreadKey, markRead]));

  async function reload() {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }

  if (!item) return (
    <Screen topSafe={false} onRefresh={reload} refreshing={refreshing}>
      {error ? <Notice message={error} /> : null}
      <Empty icon="activity" title="Activity unavailable" detail="This entry is not in your current activity list." />
      <GlassButton label="Refresh" icon="activity" onPress={() => { void reload(); }} busy={refreshing} />
    </Screen>
  );

  const addition = item.kind === 'addition';
  const title = item.merchant || (addition ? 'Money added' : 'Purchase');
  return (
    <Screen topSafe={false} onRefresh={reload} refreshing={refreshing}>
      {error ? <Notice message={error} /> : null}
      <Card style={styles.hero}>
        <View style={[styles.symbol, { backgroundColor: colors.soft }]}>
          <Icon name={addition ? 'plus' : 'bag'} size={32} color={colors.accent} />
        </View>
        <Txt size={21} weight="600" style={styles.centered}>{title}</Txt>
        <Txt size={42} weight="700" style={[styles.centered, { color: addition ? colors.accent : colors.text }]}>
          {addition ? '+' : '−'}{money(item.amountCents)}
        </Txt>
        <Txt size={14} muted>{dateLabel(item.createdAt)}</Txt>
      </Card>
      <Section title="Details">
        <Card style={styles.details}>
          <View style={styles.child}>
            <Avatar name={item.childName} id={item.childId} size={42} />
            <View style={styles.childText}>
              <Txt size={13} muted>Balance</Txt>
              <Txt weight="600">{item.childName}</Txt>
            </View>
          </View>
          <View style={[styles.detailRow, { borderTopColor: colors.line }]}>
            <Txt muted>Type</Txt>
            <Txt weight="500">{addition ? 'Addition' : 'Purchase'}</Txt>
          </View>
          <View style={[styles.detailRow, { borderTopColor: colors.line }]}>
            <Txt muted>Currency</Txt>
            <Txt weight="500">USD</Txt>
          </View>
        </Card>
      </Section>
      {item.note ? <Section title="Note"><Card style={styles.note}><Txt>{item.note}</Txt></Card></Section> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', padding: 28, gap: 14 },
  symbol: { width: 68, height: 68, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  centered: { textAlign: 'center', fontVariant: ['tabular-nums'] },
  details: { paddingHorizontal: 18, paddingVertical: 0, gap: 0 },
  child: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 18 },
  childText: { gap: 4 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth },
  note: { padding: 20 },
});
