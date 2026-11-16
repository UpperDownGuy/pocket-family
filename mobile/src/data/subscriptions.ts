import type { Subscription, SubscriptionCharge, SubscriptionFields, SubscriptionInput, SubscriptionInterval, SubscriptionPatch, SubscriptionSync } from './models';
import { MAX_TRANSACTION_CENTS } from './validation';

export const SUBSCRIPTIONS_UPDATE_MESSAGE = 'Update the Pocket server to use subscriptions. No recurring charge has been added.';
export const REMINDERS_UPDATE_MESSAGE = 'Update the Pocket server to sync subscription reminders.';

export function validateSubscriptionID(id: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error('Choose a valid subscription.');
  return id;
}

export function validateSubscriptionDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Enter a charge date as YYYY-MM-DD.');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Enter a valid charge date between 2000 and 2200.');
  }
  return value;
}

export function validateSubscriptionTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value)) throw new Error('Enter a time zone such as America/New_York.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); }
  catch { throw new Error('Enter a valid time zone such as America/New_York.'); }
  return value;
}

export function todayInTimeZone(now: Date, timeZone: string): string {
  validateSubscriptionTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Next calendar occurrence in the billing zone, clamped for shorter months. */
export function defaultSubscriptionDate(now: Date, timeZone: string, interval: SubscriptionInterval = 'monthly'): string {
  const [year, month, day] = todayInTimeZone(now, timeZone).split('-').map(Number);
  if (interval === 'weekly') return new Date(Date.UTC(year, month - 1, day + 7)).toISOString().slice(0, 10);
  const next = new Date(Date.UTC(interval === 'yearly' ? year + 1 : year, interval === 'yearly' ? month - 1 : month, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next.toISOString().slice(0, 10);
}

export function subscriptionDateLabel(value: string): string {
  validateSubscriptionDate(value);
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00Z`));
}

export function validateSubscriptionPatch(input: SubscriptionPatch): SubscriptionPatch {
  const allowed = ['name', 'amountCents', 'interval', 'nextChargeDate', 'timeZone', 'paused', 'idempotencyKey'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).some(key => key !== 'idempotencyKey') || Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Choose the subscription changes to save.');
  const result = { ...input };
  if ('name' in input) {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) throw new Error('Enter a subscription name of up to 100 characters.');
    result.name = input.name.trim();
  }
  if ('amountCents' in input && (!Number.isSafeInteger(input.amountCents) || input.amountCents! < 1 || input.amountCents! > MAX_TRANSACTION_CENTS)) throw new Error('Enter an amount from $0.01 to $10,000.00.');
  if ('interval' in input && !['weekly', 'monthly', 'yearly'].includes(input.interval!)) throw new Error('Choose weekly, monthly, or yearly.');
  if ('nextChargeDate' in input) result.nextChargeDate = validateSubscriptionDate(input.nextChargeDate);
  if ('timeZone' in input) result.timeZone = validateSubscriptionTimeZone(input.timeZone);
  if ('paused' in input && typeof input.paused !== 'boolean') throw new Error('Choose an active or paused subscription.');
  if ('idempotencyKey' in input && (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey))) throw new Error('This subscription request is invalid. Reopen the form.');
  return result;
}

export function validateSubscriptionInput(input: SubscriptionInput): SubscriptionInput {
  if (typeof input.childId !== 'string' || !input.childId || input.childId.length > 100) throw new Error('Choose a child for this subscription.');
  if (typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(input.idempotencyKey)) throw new Error('This subscription request is invalid. Reopen the form.');
  const fields = validateSubscriptionPatch({ name: input.name, amountCents: input.amountCents, interval: input.interval, nextChargeDate: input.nextChargeDate, timeZone: input.timeZone });
  return { childId: input.childId, ...fields, idempotencyKey: input.idempotencyKey } as SubscriptionInput;
}

export function subscriptionPayload(input: SubscriptionFields): string {
  return JSON.stringify([input.childId, input.name, input.amountCents, input.interval, input.nextChargeDate, input.timeZone]);
}

export function subscriptionPatchPayload(input: SubscriptionPatch): string {
  return JSON.stringify(Object.entries(input).filter(([key]) => key !== 'idempotencyKey').sort(([a], [b]) => a.localeCompare(b)));
}

export function parseSubscription(value: unknown): Subscription {
  const invalid = () => new Error('The server returned an unexpected subscription.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const row = value as Subscription;
  try {
    validateSubscriptionInput({ ...row, idempotencyKey: 'response-validation' });
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(row.id) || typeof row.paused !== 'boolean' ||
        typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw invalid();
  } catch { throw invalid(); }
  return row;
}

export function parseSubscriptions(value: unknown): Subscription[] {
  if (!value || typeof value !== 'object' || !('subscriptions' in value) || !Array.isArray(value.subscriptions)) throw new Error('The server returned an unexpected subscription list.');
  const items = value.subscriptions.map(parseSubscription);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('The server returned duplicate subscriptions.');
  return items;
}

export function parseSubscriptionResponse(value: unknown): Subscription {
  if (!value || typeof value !== 'object' || !('subscription' in value)) throw new Error('The server returned an unexpected subscription.');
  return parseSubscription(value.subscription);
}

export function parseSubscriptionSync(value: unknown): SubscriptionSync {
  const subscriptions = parseSubscriptions(value);
  const invalid = () => new Error('The server returned unexpected subscription charge history.');
  if (!value || typeof value !== 'object' || !('charges' in value) || !Array.isArray(value.charges)) throw invalid();
  const seen = new Set<string>();
  const charges = value.charges.map((entry: unknown): SubscriptionCharge => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const row = entry as SubscriptionCharge;
    try { validateSubscriptionID(row.subscriptionId); validateSubscriptionID(row.transactionId); validateSubscriptionDate(row.periodDate); }
    catch { throw invalid(); }
    if (typeof row.childId !== 'string' || !row.childId || row.childId.length > 100 || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw invalid();
    const key = `${row.subscriptionId}:${row.periodDate}`;
    if (seen.has(key)) throw invalid();
    seen.add(key);
    return row;
  });
  return { subscriptions, charges };
}
