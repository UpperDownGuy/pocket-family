import type { ComputerNotification, FamilyState, InboxNotification } from './models';

export type InboxItem = (InboxNotification & { category: 'balance' }) | (ComputerNotification & { category: 'computer' });

/** Keep the computer audit separate in storage, then present one chronological inbox. */
export function inboxItems(state: Pick<FamilyState, 'notifications' | 'computerNotifications'> | null): InboxItem[] {
  if (!state) return [];
  return [
    ...state.notifications.map(item => ({ ...item, category: 'balance' as const })),
    ...state.computerNotifications.map(item => ({ ...item, category: 'computer' as const })),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function inboxDestination(item: InboxItem) {
  return item.category === 'computer' ? { pathname: '/file-tracker' as const }
    : { pathname: '/receipt/[id]' as const, params: { id: item.transactionId } };
}
