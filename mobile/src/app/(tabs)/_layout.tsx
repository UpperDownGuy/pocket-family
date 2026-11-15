import { NativeTabs } from 'expo-router/native-tabs';
import { usePocket } from '@/data';
import { usePalette } from '@/components/pocket-ui';
export default function TabsLayout() {
  const { state } = usePocket();
  const colors = usePalette();
  const unread = state?.notifications.filter(item => !item.readAt).length ?? 0;
  return <NativeTabs tintColor={colors.accent}>
    <NativeTabs.Trigger name="index"><NativeTabs.Trigger.Label>Balances</NativeTabs.Trigger.Label><NativeTabs.Trigger.Icon sf="wallet.bifold" md="account_balance_wallet" /></NativeTabs.Trigger>
    <NativeTabs.Trigger name="activity"><NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label><NativeTabs.Trigger.Icon sf="arrow.up.arrow.down" md="swap_vert" /></NativeTabs.Trigger>
    <NativeTabs.Trigger name="inbox"><NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label><NativeTabs.Trigger.Icon sf="bell" md="notifications" />{unread > 0 && <NativeTabs.Trigger.Badge>{String(unread)}</NativeTabs.Trigger.Badge>}</NativeTabs.Trigger>
    <NativeTabs.Trigger name="family"><NativeTabs.Trigger.Label>Family</NativeTabs.Trigger.Label><NativeTabs.Trigger.Icon sf="person.2.fill" md="group" /></NativeTabs.Trigger>
  </NativeTabs>;
}
