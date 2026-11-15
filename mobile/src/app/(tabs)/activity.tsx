import { useMemo, useState } from 'react';
import { Card, Choice, Empty, Field, Notice, Screen, Section, TransactionRow } from '@/components/pocket-ui';
import { usePocket } from '@/data';

export default function ActivityScreen() {
  const { state, error, refresh } = usePocket();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const transactions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (state?.transactions ?? [])
      .filter(item => kind === 'all' || item.kind === kind)
      .filter(item => !search || [item.merchant, item.note, item.childName]
        .some(value => value.toLocaleLowerCase().includes(search)))
      .slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [state?.transactions, query, kind]);

  async function reload() {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  }

  return (
    <Screen title="Activity" onRefresh={reload} refreshing={refreshing}>
      {error ? <Notice message={error} /> : null}
      <Field
        label="Search"
        value={query}
        onChangeText={setQuery}
        placeholder={state?.user.role === 'parent' ? 'Store, note, or child' : 'Store or note'}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        returnKeyType="search"
      />
      <Choice
        value={kind}
        onChange={setKind}
        options={[
          { label: 'All', value: 'all' },
          { label: 'Purchases', value: 'purchase' },
          { label: 'Additions', value: 'addition' },
        ]}
      />
      {transactions.length ? (
        <Section title={`${transactions.length} ${transactions.length === 1 ? 'entry' : 'entries'}`}>
          <Card>
            {transactions.map(item => (
              <TransactionRow key={item.id} item={item} showChild={state?.user.role === 'parent'} />
            ))}
          </Card>
        </Section>
      ) : (
        <Empty
          icon="activity"
          title={query.trim() || kind !== 'all' ? 'No matching activity' : 'No activity yet'}
          detail={query.trim() || kind !== 'all'
            ? 'Try another search or filter.'
            : 'Recorded purchases and additions will appear here.'}
        />
      )}
    </Screen>
  );
}
