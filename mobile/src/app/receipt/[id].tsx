import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Avatar, Card, dateLabel, Empty, GlassButton, Icon, Notice, Screen, Section, Txt, usePalette } from '@/components/pocket-ui';
import { money, type ReceiptItems, usePocket } from '@/data';

export default function ReceiptScreen() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const transactionId = Array.isArray(id) ? id[0] : id;
  const { state, serverURL, error, refresh, markRead, transactionItems } = usePocket();
  const colors = usePalette();
  const [refreshing, setRefreshing] = useState(false);
  const [files, setFiles] = useState<{ key: string; data: ReceiptItems | null; error: string | null } | null>(null);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const item = state?.transactions.find(transaction => transaction.id === transactionId);
  const filesKey = `${serverURL}:${state?.user.id}:${item?.id}:${revision}`;
  const canRead = !!item;
  const unreadKey = (state?.notifications ?? [])
    .filter(notification => notification.transactionId === transactionId && !notification.readAt)
    .map(notification => notification.id).sort().join(',');

  useFocusEffect(useCallback(() => {
    if (unreadKey) void markRead(unreadKey.split(',')).catch(() => undefined);
  }, [unreadKey, markRead]));

  useFocusEffect(useCallback(() => {
    if (!canRead || !transactionId) return;
    let cancelled = false;
    setFiles(null); setPage(0);
    void transactionItems(transactionId).then(data => {
      if (!cancelled) setFiles({ key: filesKey, data, error: null });
    }).catch(caught => {
      if (!cancelled) setFiles({ key: filesKey, data: null, error: caught instanceof Error ? caught.message : 'Could not load the file list.' });
    });
    return () => { cancelled = true; };
  }, [transactionId, filesKey, canRead, transactionItems]));

  async function reload() {
    setRefreshing(true);
    try { await refresh(); setRevision(value => value + 1); } finally { setRefreshing(false); }
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
  const loaded = files?.key === filesKey ? files : null;
  const details = loaded?.data;
  const fileItems = details?.items ?? [];
  const start = page * 50;
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
      {!loaded ? <ActivityIndicator color={colors.accent} accessibilityLabel="Loading receipt files" /> : loaded.error ? <Notice message={loaded.error} /> : details && details.totalCount > 0 ? <Section title="Changed items">
        <Card>
          <Txt size={13} muted>{details.totalCount} {details.totalCount === 1 ? 'item' : 'items'} in this payment</Txt>
          {fileItems.slice(start, start + 50).map((file, index) => <View key={`${start + index}:${file.reportId}`} style={[styles.file, { borderTopColor: colors.line }]}>
            <View style={styles.fileHeading}><Icon name="computer" size={18} /><Txt size={12} weight="600" style={{ color: colors.accent }}>{({ added: 'Added', removed: 'Removed', modified: 'Modified', renamed: 'Renamed' })[file.status]}</Txt></View>
            <Txt size={15} weight="500">{file.path}</Txt>
            {file.oldPath && <Txt size={12} muted>Previously: {file.oldPath}</Txt>}
          </View>)}
          {details.omittedCount > 0 && <Txt size={13} muted>{fileItems.length ? `${details.omittedCount} more items were not included in this receipt.` : 'The file list was not saved with this older payment.'}</Txt>}
          {fileItems.length > 50 && <><Txt muted size={12}>{start + 1}–{Math.min(start + 50, fileItems.length)} of {fileItems.length}</Txt><View style={styles.paging}><View style={{ flex: 1 }}><GlassButton label="Previous" disabled={page === 0} onPress={() => setPage(value => value - 1)} /></View><View style={{ flex: 1 }}><GlassButton label="Next" disabled={start + 50 >= fileItems.length} onPress={() => setPage(value => value + 1)} /></View></View></>}
        </Card>
      </Section> : loaded.data === null && /file tracker|file edits/i.test(item.merchant) ? <Section title="Changed items"><Card><Txt muted size={14}>A file list is not available for this receipt.</Txt></Card></Section> : null}
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
  file: { gap: 5, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14 },
  fileHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  paging: { flexDirection: 'row', gap: 10 },
});
