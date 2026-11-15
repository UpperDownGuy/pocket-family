import { Tabs } from 'expo-router';
import { Icon, usePalette } from '@/components/pocket-ui';
import { inboxItems, usePocket } from '@/data';
export default function WebTabs() {
  const colors = usePalette();
  const { state } = usePocket();
  const unread = inboxItems(state).filter(item => !item.readAt).length;
  return <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.accent, tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line, height: 70, paddingBottom: 12 } }}>{([{ name: 'index', title: 'Balances', icon: 'wallet' }, { name: 'activity', title: 'Activity', icon: 'activity' }, { name: 'inbox', title: 'Inbox', icon: 'inbox' }, { name: 'family', title: 'Family', icon: 'family' }] as const).map(tab => <Tabs.Screen key={tab.name} name={tab.name} options={{ title: tab.title, tabBarBadge: tab.name === 'inbox' && unread > 0 ? unread : undefined, tabBarIcon: ({ color }) => <Icon name={tab.icon} color={typeof color === 'string' ? color : colors.accent} /> }} />)}</Tabs>;
}
