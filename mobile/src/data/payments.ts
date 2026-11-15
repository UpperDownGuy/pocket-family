import type { FamilyState, LedgerTransaction, ReceiptItems, TransactionInput } from './models';

export interface PaymentAttempt { payload: string; key: string }
export function transactionPayload(input: Omit<TransactionInput, 'idempotencyKey'>): string {
  return JSON.stringify([input.childId, input.kind, input.amountCents, input.merchant, input.note]);
}
export function paymentAttempt(input: Omit<TransactionInput, 'idempotencyKey'>, previous: PaymentAttempt | null, newKey: () => string): PaymentAttempt {
  const payload = transactionPayload(input);
  return previous?.payload === payload ? previous : { payload, key: newKey() };
}

export interface ReceivedPayments { notificationIds: string[]; transactions: LedgerTransaction[]; amountCents: number }
/** Server-scoped unread notifications are the durable source of unseen payments. */
export function receivedPayments(state: FamilyState | null, dismissed: ReadonlySet<string> = new Set()): ReceivedPayments | null {
  if (!state || state.user.role !== 'child') return null;
  const own = new Map(state.transactions.filter(item => item.kind === 'addition' && item.childId === state.user.id).map(item => [item.id, item]));
  const ids: string[] = [];
  const transactions = new Map<string, LedgerTransaction>();
  for (const note of state.notifications) {
    const item = own.get(note.transactionId);
    if (note.readAt !== null || dismissed.has(note.id) || !item) continue;
    ids.push(note.id);
    transactions.set(item.id, item);
  }
  if (!ids.length) return null;
  const items = [...transactions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { notificationIds: [...new Set(ids)], transactions: items, amountCents: items.reduce((sum, item) => sum + item.amountCents, 0) };
}

export function parseReceiptItems(value: unknown): ReceiptItems {
  const invalid = () => new Error('The server returned an unexpected file list.');
  if (!value || typeof value !== 'object') throw invalid();
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.items) || !Number.isSafeInteger(row.totalCount) || !Number.isSafeInteger(row.omittedCount) ||
      (row.totalCount as number) < 0 || (row.omittedCount as number) < 0 || row.items.length + (row.omittedCount as number) !== row.totalCount) throw invalid();
  for (const item of row.items) {
    if (!item || typeof item !== 'object' || typeof item.reportId !== 'string' || !item.reportId ||
        typeof item.path !== 'string' || !item.path || !['added', 'removed', 'modified', 'renamed'].includes(item.status) ||
        (item.oldPath !== undefined && (typeof item.oldPath !== 'string' || !item.oldPath))) throw invalid();
  }
  return value as ReceiptItems;
}
