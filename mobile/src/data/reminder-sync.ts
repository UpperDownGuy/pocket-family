import type { Subscription, SubscriptionCharge } from './models';
import { parseSubscription, todayInTimeZone, validateSubscriptionDate, validateSubscriptionID } from './subscriptions';

const markerPrefix = 'pocket-reminder:v1:';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface ReminderMarker { scopeId: string; subscriptionId: string; periodDate: string }

/** Native adapters extract this exact line from notes, not from the title/date. */
export function createReminderMarker(scopeId: string, subscriptionId: string, periodDate: string): string {
  if (!uuid.test(scopeId)) throw new Error('Choose a valid Pocket Reminders connection.');
  validateSubscriptionID(subscriptionId);
  validateSubscriptionDate(periodDate);
  return `${markerPrefix}${scopeId}:${subscriptionId}:${periodDate}`;
}

export function parseReminderMarker(value: unknown): ReminderMarker | null {
  if (typeof value !== 'string' || !value.startsWith(markerPrefix)) return null;
  const parts = value.slice(markerPrefix.length).split(':');
  if (parts.length !== 3) return null;
  const [scopeId, subscriptionId, periodDate] = parts;
  try { return createReminderMarker(scopeId, subscriptionId, periodDate) === value ? { scopeId, subscriptionId, periodDate } : null; }
  catch { return null; }
}

export interface SyncedReminder {
  id: string;
  calendarId: string;
  marker: string | null;
  title: string;
  /** User-visible notes, without the ownership-marker line. */
  notes?: string | null;
  dueDate: string | null;
  timeZone?: string | null;
  completed: boolean;
}

export interface ReminderFields {
  title: string;
  notes: string;
  dueDate: string;
  timeZone: string;
  completed: false;
}

export type ReminderSyncOperation =
  | { kind: 'create'; marker: string; reminder: ReminderFields }
  | { kind: 'update'; marker: string; reminderId: string; reminder: ReminderFields }
  | { kind: 'complete'; marker: string; reminderId: string; completedAt: string }
  | { kind: 'delete'; marker: string; reminderId: string };

export interface ReminderSyncInput {
  scopeId: string;
  calendarId: string;
  allowedChildIds: readonly string[];
  /** Supply names only in a parent's connection; a child sees subscription names. */
  childNames?: Readonly<Record<string, string>>;
  subscriptions: readonly Subscription[];
  charges: readonly SubscriptionCharge[];
  reminders: readonly SyncedReminder[];
  now: Date;
}

function periodKey(subscriptionId: string, periodDate: string): string { return `${subscriptionId}:${periodDate}`; }

function desiredFields(subscription: Subscription, childNames?: Readonly<Record<string, string>>): ReminderFields {
  const childName = childNames?.[subscription.childId];
  return {
    title: childName ? `${childName} · ${subscription.name}` : subscription.name,
    notes: `$${(subscription.amountCents / 100).toFixed(2)} · ${subscription.interval}\nPocket balance deduction.`,
    dueDate: subscription.nextChargeDate,
    timeZone: subscription.timeZone,
    completed: false,
  };
}

function needsUpdate(reminder: SyncedReminder, desired: ReminderFields): boolean {
  return reminder.title !== desired.title || (reminder.notes ?? '') !== desired.notes
    || reminder.dueDate !== desired.dueDate || (reminder.timeZone != null && reminder.timeZone !== desired.timeZone);
}

/**
 * Pure reconciliation against one complete, freshly authorized server feed.
 * Never infer payment from a date or a local checkbox. Existing completed
 * reminders stay immutable. The native executor must re-read ownership and
 * calendar before each mutation, and fetch again after a failed/uncertain write.
 */
export function planReminderSync(input: ReminderSyncInput): ReminderSyncOperation[] {
  if (!uuid.test(input.scopeId) || typeof input.calendarId !== 'string' || !input.calendarId
      || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) || !Array.isArray(input.allowedChildIds)
      || input.allowedChildIds.some(id => typeof id !== 'string' || !id)) {
    throw new Error('The Pocket Reminders connection is invalid.');
  }
  const allowed = new Set(input.allowedChildIds);
  const subscriptions = new Map<string, Subscription>();
  for (const value of input.subscriptions) {
    const subscription = parseSubscription(value);
    if (!allowed.has(subscription.childId)) throw new Error('This account cannot sync that child’s reminders.');
    if (subscriptions.has(subscription.id)) throw new Error('The server returned duplicate subscriptions.');
    subscriptions.set(subscription.id, subscription);
  }
  const charges = new Map<string, SubscriptionCharge>();
  for (const charge of input.charges) {
    validateSubscriptionID(charge.subscriptionId);
    validateSubscriptionDate(charge.periodDate);
    if (!allowed.has(charge.childId)) throw new Error('This account cannot sync that child’s reminders.');
    if (typeof charge.transactionId !== 'string' || !charge.transactionId || typeof charge.createdAt !== 'string'
        || !Number.isFinite(Date.parse(charge.createdAt))) throw new Error('The server returned an invalid subscription charge.');
    const subscription = subscriptions.get(charge.subscriptionId);
    if (subscription && subscription.childId !== charge.childId) throw new Error('A subscription charge belongs to a different child.');
    const key = periodKey(charge.subscriptionId, charge.periodDate);
    const previous = charges.get(key);
    if (previous && (previous.transactionId !== charge.transactionId || previous.childId !== charge.childId)) {
      throw new Error('The server returned conflicting subscription charges.');
    }
    charges.set(key, charge);
  }

  const owned = new Map<string, { identity: ReminderMarker; reminders: SyncedReminder[] }>();
  const nativeIds = new Set<string>();
  for (const reminder of input.reminders) {
    const identity = parseReminderMarker(reminder.marker);
    if (reminder.calendarId !== input.calendarId || identity?.scopeId !== input.scopeId) continue;
    if (typeof reminder.id !== 'string' || !reminder.id || typeof reminder.completed !== 'boolean' || nativeIds.has(reminder.id)) {
      throw new Error('The Reminders list contains conflicting entries. Refresh it and try again.');
    }
    nativeIds.add(reminder.id);
    const group = owned.get(reminder.marker!) ?? { identity, reminders: [] };
    group.reminders.push(reminder);
    owned.set(reminder.marker!, group);
  }

  const operations: ReminderSyncOperation[] = [];
  for (const [marker, group] of [...owned].sort(([a], [b]) => a.localeCompare(b))) {
    const { subscriptionId, periodDate } = group.identity;
    const charge = charges.get(periodKey(subscriptionId, periodDate));
    const pending = group.reminders.filter(reminder => !reminder.completed).sort((a, b) => a.id.localeCompare(b.id));
    if (charge) {
      // Complete all owned copies after an uncertain duplicate creation. Their
      // matching committed period is the proof; their local due dates are not.
      for (const reminder of pending) operations.push({ kind: 'complete', marker, reminderId: reminder.id, completedAt: charge.createdAt });
      continue;
    }
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription || subscription.paused || subscription.nextChargeDate !== periodDate) {
      for (const reminder of pending) operations.push({ kind: 'delete', marker, reminderId: reminder.id });
      continue;
    }
    // A manually completed future reminder also represents this same period.
    // Preserve it and remove only extra pending copies, without reopening it.
    const keep = group.reminders.some(reminder => reminder.completed) ? undefined : pending[0];
    for (const reminder of pending) {
      if (reminder !== keep) operations.push({ kind: 'delete', marker, reminderId: reminder.id });
      else {
        const desired = desiredFields(subscription, input.childNames);
        if (needsUpdate(reminder, desired)) operations.push({ kind: 'update', marker, reminderId: reminder.id, reminder: desired });
      }
    }
  }
  for (const subscription of [...subscriptions.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (subscription.paused || subscription.nextChargeDate < todayInTimeZone(input.now, subscription.timeZone)
        || charges.has(periodKey(subscription.id, subscription.nextChargeDate))) continue;
    const marker = createReminderMarker(input.scopeId, subscription.id, subscription.nextChargeDate);
    if (!owned.has(marker)) operations.push({ kind: 'create', marker, reminder: desiredFields(subscription, input.childNames) });
  }
  return operations;
}
