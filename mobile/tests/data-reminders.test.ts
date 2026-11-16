/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Subscription, SubscriptionCharge } from '../src/data/models';
import { createReminderMarker, parseReminderMarker, planReminderSync, type ReminderFields,
  type ReminderSyncInput, type ReminderSyncOperation, type SyncedReminder } from '../src/data/reminder-sync';

const scopeId = 'a1e60a32-a102-40e3-8828-0963d141b634';
const otherScope = '1e943c55-8045-4b45-8e3b-fe9843e72739';
const calendarId = 'reminders-list-a';
const childId = 'child-a';
const subscription: Subscription = { id: 'subscription-a', childId, name: 'Music', amountCents: 499, interval: 'monthly',
  nextChargeDate: '2026-12-16', timeZone: 'America/New_York', paused: false,
  createdAt: '2026-11-16T12:00:00Z', updatedAt: '2026-11-16T12:00:00Z' };
const input = (changes: Partial<ReminderSyncInput> = {}): ReminderSyncInput => ({ scopeId, calendarId, allowedChildIds: [childId],
  subscriptions: [subscription], charges: [], reminders: [], now: new Date('2026-11-16T13:00:00Z'), ...changes });
const marker = (date = subscription.nextChargeDate, id = subscription.id) => createReminderMarker(scopeId, id, date);
const fields: ReminderFields = { title: 'Music', notes: '$4.99 · monthly\nPocket balance deduction.', dueDate: '2026-12-16', timeZone: 'America/New_York', completed: false };
const reminder = (changes: Partial<SyncedReminder> = {}): SyncedReminder => ({ id: 'native-a', calendarId, marker: marker(), ...fields, ...changes });
const charge = (changes: Partial<SubscriptionCharge> = {}): SubscriptionCharge => ({ subscriptionId: subscription.id, periodDate: '2026-11-16',
  transactionId: 'transaction-a', childId, createdAt: '2026-11-16T12:00:00Z', ...changes });

function apply(reminders: SyncedReminder[], operations: ReminderSyncOperation[]): SyncedReminder[] {
  const result = reminders.map(item => ({ ...item }));
  for (const operation of operations) {
    if (operation.kind === 'create') result.push({ id: 'new-' + result.length, calendarId, marker: operation.marker, ...operation.reminder });
    else {
      const index = result.findIndex(item => item.id === operation.reminderId);
      assert.notEqual(index, -1);
      if (operation.kind === 'delete') result.splice(index, 1);
      else if (operation.kind === 'complete') result[index].completed = true;
      else Object.assign(result[index], operation.reminder);
    }
  }
  return result;
}

test('marker round-trip is strict and rejects notes text, injected delimiters, invalid dates and other versions', () => {
  assert.deepEqual(parseReminderMarker(marker()), { scopeId, subscriptionId: subscription.id, periodDate: subscription.nextChargeDate });
  for (const value of [null, '', ' ' + marker(), marker() + '\n', 'Notes\n' + marker(), marker().replace(':v1:', ':v2:'),
    marker().replace('2026-12-16', '2026-02-30'), marker().replace('subscription-a', '../private'), marker().replace(scopeId, 'account-secret')]) {
    assert.equal(parseReminderMarker(value), null);
  }
  assert.throws(() => createReminderMarker(scopeId, 'id:injection', '2026-12-16'));
});

test('initial connection creates only active current or future periods without historical backfill', () => {
  const future = { ...subscription, id: 'future', nextChargeDate: '2026-12-16' };
  const today = { ...subscription, id: 'today', nextChargeDate: '2026-11-16' };
  const overdue = { ...subscription, id: 'overdue', nextChargeDate: '2026-11-15' };
  const paused = { ...subscription, id: 'paused', paused: true };
  const operations = planReminderSync(input({ subscriptions: [future, today, overdue, paused], charges: [charge({ subscriptionId: 'old-deleted' })] }));
  assert.deepEqual(operations.map(operation => parseReminderMarker(operation.marker)?.subscriptionId), ['future', 'today']);
  assert.ok(operations.every(operation => operation.kind === 'create' && operation.reminder.completed === false));
  const localYesterday = { ...subscription, nextChargeDate: '2026-11-15', timeZone: 'America/Los_Angeles' };
  assert.equal(planReminderSync(input({ subscriptions: [localYesterday], now: new Date('2026-11-16T02:00:00Z') })).length, 1);
});

test('only a committed matching subscription period completes reminders; local date and other subscriptions do not', () => {
  const old = reminder({ marker: marker('2026-11-16'), dueDate: '2026-01-01' });
  const wrong = charge({ subscriptionId: 'another-subscription' });
  const currentDue = { ...subscription, nextChargeDate: '2026-11-16' };
  const noCharge = planReminderSync(input({ subscriptions: [currentDue], reminders: [old], charges: [wrong], now: new Date('2026-11-20T12:00:00Z') }));
  assert.ok(noCharge.every(operation => operation.kind !== 'complete'));
  assert.deepEqual(noCharge.map(operation => operation.kind), ['update']);
  const matching = planReminderSync(input({ reminders: [old], charges: [charge()] }));
  assert.deepEqual(matching.map(operation => operation.kind), ['complete', 'create']);
  assert.equal(matching[0].kind === 'complete' && matching[0].completedAt, charge().createdAt);
});

test('a lost create response and partial completion retry discover native markers rather than duplicate reminders', () => {
  const original = [reminder({ marker: marker('2026-11-16'), dueDate: '2026-11-16' })];
  const feed = input({ reminders: original, charges: [charge()] });
  const operations = planReminderSync(feed);
  assert.deepEqual(operations.map(operation => operation.kind), ['complete', 'create']);
  const partial = apply(original, operations.slice(0, 1));
  const retry = planReminderSync({ ...feed, reminders: partial });
  assert.deepEqual(retry.map(operation => operation.kind), ['create']);
  const createdButReplyLost = apply(partial, retry);
  assert.deepEqual(planReminderSync({ ...feed, reminders: createdButReplyLost }), []);
});

test('paused, deleted, and rescheduled pending reminders are removed while charged and completed history remains', () => {
  const existing = [
    reminder({ id: 'paused', marker: marker('2026-12-16', 'paused') }),
    reminder({ id: 'deleted', marker: marker('2026-12-16', 'deleted') }),
    reminder({ id: 'rescheduled', marker: marker('2026-12-15') }),
    reminder({ id: 'history', marker: marker('2026-10-16', 'deleted'), completed: true }),
    reminder({ id: 'charged', marker: marker('2026-11-16', 'deleted') }),
  ];
  const operations = planReminderSync(input({ reminders: existing, subscriptions: [subscription, { ...subscription, id: 'paused', paused: true }],
    charges: [charge({ subscriptionId: 'deleted' })] }));
  assert.deepEqual(operations.filter(operation => operation.kind === 'delete').map(operation => operation.reminderId).sort(), ['deleted', 'paused', 'rescheduled']);
  assert.deepEqual(operations.filter(operation => operation.kind === 'complete').map(operation => operation.reminderId), ['charged']);
  assert.equal(operations.some(operation => 'reminderId' in operation && operation.reminderId === 'history'), false);
  assert.deepEqual(planReminderSync(input({ reminders: apply(existing, operations), subscriptions: [subscription, { ...subscription, id: 'paused', paused: true }], charges: [charge({ subscriptionId: 'deleted' })] })), []);
});

test('duplicate pending markers converge deterministically, and charged duplicates complete without deleting history', () => {
  const duplicates = [reminder({ id: 'z' }), reminder({ id: 'a' }), reminder({ id: 'm' })];
  const operations = planReminderSync(input({ reminders: duplicates }));
  assert.deepEqual(operations.filter(operation => operation.kind === 'delete').map(operation => operation.reminderId), ['m', 'z']);
  assert.deepEqual(planReminderSync(input({ reminders: [...duplicates].reverse() })), operations);
  const charged = planReminderSync(input({ subscriptions: [], reminders: duplicates, charges: [charge({ periodDate: subscription.nextChargeDate })] }));
  assert.deepEqual(charged.map(operation => operation.kind), ['complete', 'complete', 'complete']);
  const manuallyChecked = [reminder({ id: 'checked', completed: true, title: 'My edited reminder' }), reminder({ id: 'duplicate' })];
  assert.deepEqual(planReminderSync(input({ reminders: manuallyChecked })), [{ kind: 'delete', marker: marker(), reminderId: 'duplicate' }]);
});

test('name, amount, billing zone and missing due dates update the existing period rather than create another one', () => {
  const changed = { ...subscription, name: 'Music Plus', amountCents: 799, timeZone: 'Europe/London' };
  const operations = planReminderSync(input({ subscriptions: [changed], childNames: { [childId]: 'Avery' }, reminders: [reminder({ dueDate: null })] }));
  assert.equal(operations.length, 1);
  assert.equal(operations[0].kind, 'update');
  if (operations[0].kind !== 'update') throw new Error('Expected update');
  assert.equal(operations[0].marker, marker());
  assert.equal(operations[0].reminder.title, 'Avery · Music Plus');
  assert.match(operations[0].reminder.notes, /7\.99/);
  assert.equal(operations[0].reminder.timeZone, 'Europe/London');
  assert.deepEqual(planReminderSync(input({ reminders: [reminder({ timeZone: undefined })] })), [], 'native APIs that cannot round-trip zones should not update forever');
});

test('ownership requires both exact scope and calendar, preserving unrelated reminders even with matching dates', () => {
  const unrelated = [
    reminder({ id: 'other-calendar', calendarId: 'someone-elses-list' }),
    reminder({ id: 'other-scope', marker: createReminderMarker(otherScope, subscription.id, subscription.nextChargeDate) }),
    reminder({ id: 'no-marker', marker: null, title: 'Doctor appointment' }),
    reminder({ id: 'bad-marker', marker: marker() + '\nextra' }),
  ];
  const operations = planReminderSync(input({ reminders: unrelated, subscriptions: [], charges: [charge({ periodDate: subscription.nextChargeDate })] }));
  assert.deepEqual(operations, []);
});

test('foreign-child data and conflicting charge evidence reject the entire plan before any native mutation', () => {
  assert.throws(() => planReminderSync(input({ subscriptions: [{ ...subscription, childId: 'sibling' }] })), /cannot sync/);
  assert.throws(() => planReminderSync(input({ charges: [charge({ childId: 'sibling' })] })), /cannot sync/);
  assert.throws(() => planReminderSync(input({ allowedChildIds: [childId, 'sibling'], charges: [charge({ childId: 'sibling' })] })), /different child/);
  assert.throws(() => planReminderSync(input({ charges: [charge(), charge({ transactionId: 'different-transaction' })] })), /conflicting/);
  assert.throws(() => planReminderSync(input({ reminders: [reminder(), reminder()] })), /conflicting/);
});

test('operations expose only selected reminder content, without copying account, server, or transaction secrets', () => {
  const extraFields = { ...subscription, serverURL: 'https://private-server.invalid', token: 'private-token', username: 'private-login', familyCode: '12345678' };
  const operations = planReminderSync(input({ subscriptions: [extraFields], charges: [charge({ transactionId: 'private-transaction-id' })] }));
  const encoded = JSON.stringify(operations);
  for (const secret of ['private-server', 'private-token', 'private-login', '12345678', 'private-transaction-id', childId]) assert.equal(encoded.includes(secret), false);
  assert.deepEqual(Object.keys(operations[0]).sort(), ['kind', 'marker', 'reminder']);
});

test('a new billing cycle checks its existing paid reminder and creates exactly one next-period reminder', () => {
  const previous = reminder({ completed: false });
  const next = { ...subscription, nextChargeDate: '2027-01-16' };
  const feed = input({ subscriptions: [next], reminders: [previous], charges: [charge({ periodDate: '2026-12-16' })], now: new Date('2026-12-16T14:00:00Z') });
  const operations = planReminderSync(feed);
  assert.deepEqual(operations.map(operation => operation.kind), ['complete', 'create']);
  assert.equal(parseReminderMarker(operations[1].marker)?.periodDate, '2027-01-16');
  assert.deepEqual(planReminderSync({ ...feed, reminders: apply([previous], operations) }), []);
});
