/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Subscription, SubscriptionSyncFeed } from '../src/data/models';
import { createReminderMarker, type ReminderSyncOperation, type SyncedReminder } from '../src/data/reminder-sync';
import { RemindersService, RemindersListUnavailableError, REMINDERS_BUILD_MESSAGE, type RemindersConfiguration, type RemindersDependencies, type RemindersScope } from '../src/data/reminders-service';

const owner = 'aaaaaaaa-1111-4222-8333-444444444444';
const unrelatedOwner = 'bbbbbbbb-1111-4222-8333-444444444444';
const calendarId = 'owned-list';
const scope: RemindersScope = { serverURL: 'https://family.example.test', userId: 'child-a', familyName: 'Family',
  userName: 'Avery', role: 'child', allowedChildIds: ['child-a'] };
const subscription: Subscription = { id: 'subscription-a', childId: 'child-a', name: 'Music', amountCents: 499,
  interval: 'monthly', nextChargeDate: '2026-12-16', timeZone: 'America/New_York', paused: false,
  createdAt: '2026-11-16T12:00:00Z', updatedAt: '2026-11-16T12:00:00Z' };
const saved: RemindersConfiguration = { version: 1, scopeId: owner, calendarId, enabled: true, lastSync: '2026-11-15T12:00:00Z' };
const copy = <T>(value: T): T => structuredClone(value);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function reminder(item = subscription, changes: Partial<SyncedReminder> = {}): SyncedReminder {
  return { id: 'native-existing', calendarId, marker: createReminderMarker(owner, item.id, item.nextChargeDate),
    title: item.name, notes: '$4.99 · monthly\nPocket balance deduction.', dueDate: item.nextChargeDate,
    timeZone: item.timeZone, completed: false, ...changes };
}
function fixture(options: { available?: boolean; config?: RemindersConfiguration | null; reminders?: SyncedReminder[]; scope?: RemindersScope } = {}) {
  let config = options.config === undefined ? copy(saved) : copy(options.config);
  let feed: SubscriptionSyncFeed = { subscriptions: [copy(subscription)], charges: [] };
  let reminders = copy(options.reminders ?? []);
  let nextID = 0;
  let granted = true;
  const calls: string[] = [];
  const writes: RemindersConfiguration[] = [];
  const nativeWrites: ReminderSyncOperation[] = [];
  const hooks: {
    read?: () => Promise<RemindersConfiguration | null>;
    feed?: () => Promise<SubscriptionSyncFeed>;
    permission?: () => Promise<boolean>;
    createList?: () => Promise<string>;
    list?: () => Promise<SyncedReminder[]>;
    beforeApply?: (operation: ReminderSyncOperation, isCurrent: () => boolean) => Promise<void>;
    afterApply?: (operation: ReminderSyncOperation) => Promise<void>;
  } = {};
  const device: RemindersDependencies = {
    available: options.available ?? true,
    async read() { calls.push('read'); return hooks.read ? hooks.read() : copy(config); },
    async write(value) { calls.push('write'); writes.push(copy(value)); config = copy(value); },
    async requestPermission() { calls.push('requestPermission'); return hooks.permission ? hooks.permission() : granted; },
    async hasPermission() { calls.push('hasPermission'); return granted; },
    async createList(title) { calls.push(`createList:${title}`); return hooks.createList ? hooks.createList() : calendarId; },
    async list(id) { calls.push(`list:${id}`); return hooks.list ? hooks.list() : copy(reminders); },
    async apply(id, scopeId, operation, isCurrent) {
      calls.push(`apply:${operation.kind}`);
      assert.equal(id, config?.calendarId);
      assert.equal(scopeId, owner);
      await hooks.beforeApply?.(operation, isCurrent);
      if (!isCurrent()) throw new Error('Reminders sync stopped because the account or connection changed.');
      nativeWrites.push(copy(operation));
      if (operation.kind === 'create') {
        reminders.push({ id: `native-${++nextID}`, calendarId: id, marker: operation.marker, ...operation.reminder });
      } else {
        const existing = reminders.find(item => item.id === operation.reminderId);
        assert.ok(existing, 'The injected native store must contain the target');
        assert.equal(existing.calendarId, id);
        assert.equal(existing.marker, operation.marker);
        if (operation.kind === 'update') Object.assign(existing, operation.reminder);
        else if (operation.kind === 'complete') existing.completed = true;
        else reminders = reminders.filter(item => item !== existing);
      }
      await hooks.afterApply?.(operation);
    },
    uuid() { calls.push('uuid'); return owner; },
    now() { return new Date('2026-11-16T12:00:00Z'); },
  };
  const getFeed = async () => { calls.push('feed'); return hooks.feed ? hooks.feed() : copy(feed); };
  const service = new RemindersService(options.scope ?? scope, getFeed, device);
  return { service, device, calls, writes, nativeWrites, hooks, getFeed,
    get config() { return copy(config); }, get reminders() { return copy(reminders); },
    setFeed(value: SubscriptionSyncFeed) { feed = copy(value); }, setGranted(value: boolean) { granted = value; } };
}

test('initialize and automatic sync never request OS permission; only explicit connect may ask', async () => {
  const f = fixture({ config: null });
  await Promise.all([f.service.initialize(), f.service.initialize()]);
  await f.service.sync();
  assert.deepEqual(f.calls, ['read']);
  assert.equal(f.service.getSnapshot().enabled, false);
  await f.service.connect();
  assert.equal(f.calls.filter(call => call === 'requestPermission').length, 1);
  assert.ok(f.calls.indexOf('feed') < f.calls.indexOf('requestPermission'));
  assert.ok(f.calls.indexOf('write') < f.calls.findIndex(call => call.startsWith('createList:')));
  assert.equal(f.nativeWrites.filter(operation => operation.kind === 'create').length, 1);
  assert.equal(f.config?.calendarId, calendarId);
  assert.equal(f.config?.enabled, true);
  assert.equal(f.service.getSnapshot().lastSync, '2026-11-16T12:00:00.000Z');
  assert.equal(f.service.getSnapshot().syncing, false);
});

test('unsupported builds are passive and denied permission makes no list, reminder, or configuration writes', async () => {
  const unsupported = fixture({ available: false, config: null });
  await unsupported.service.initialize(); await unsupported.service.sync(); await unsupported.service.disconnect();
  assert.deepEqual(unsupported.calls, []);
  await assert.rejects(unsupported.service.connect(), { message: REMINDERS_BUILD_MESSAGE });
  assert.deepEqual(unsupported.calls, []);
  assert.equal(unsupported.service.getSnapshot().enabled, false);
  const denied = fixture({ config: null });
  denied.setGranted(false);
  await assert.rejects(denied.service.connect(), /Allow Reminders access/);
  assert.equal(denied.calls.filter(call => call === 'requestPermission').length, 1);
  assert.deepEqual(denied.writes, []);
  assert.deepEqual(denied.nativeWrites, []);
  assert.ok(denied.calls.every(call => !call.startsWith('createList:')));
  assert.equal(denied.service.getSnapshot().syncing, false);
});

test('overdue dates do not complete reminders; a committed period completes it and creates the next occurrence', async () => {
  const overdue = { ...subscription, nextChargeDate: '2026-11-15' };
  const f = fixture({ reminders: [reminder(overdue)] });
  f.setFeed({ subscriptions: [overdue], charges: [] });
  await f.service.sync();
  assert.equal(f.reminders[0].completed, false);
  assert.equal(f.nativeWrites.length, 0);
  const chargedAt = '2026-11-16T10:01:00.000Z';
  f.setFeed({ subscriptions: [{ ...subscription, nextChargeDate: '2026-12-15' }], charges: [{
    subscriptionId: subscription.id, periodDate: '2026-11-15', transactionId: 'transaction-actual', childId: 'child-a', createdAt: chargedAt,
  }] });
  await f.service.sync();
  assert.deepEqual(f.nativeWrites.map(operation => operation.kind), ['complete', 'create']);
  assert.equal((f.nativeWrites[0] as Extract<ReminderSyncOperation, { kind: 'complete' }>).completedAt, chargedAt);
  assert.equal(f.reminders.find(item => item.id === 'native-existing')?.completed, true);
  assert.equal(f.reminders.find(item => item.id !== 'native-existing')?.dueDate, '2026-12-15');
});

test('a failed authoritative feed causes zero device writes and never completes or deletes existing reminders', async () => {
  const f = fixture({ reminders: [reminder()] });
  f.hooks.feed = async () => { throw new Error('Family server offline'); };
  await assert.rejects(f.service.sync(), /Family server offline/);
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.writes, []);
  assert.ok(f.calls.every(call => !call.startsWith('list:')));
  assert.equal(f.reminders[0].completed, false);
  assert.equal(f.service.getSnapshot().lastSync, saved.lastSync);
  assert.equal(f.service.getSnapshot().syncing, false);
  const fresh = fixture({ config: null });
  fresh.hooks.feed = async () => { throw new Error('Server does not support sync'); };
  await assert.rejects(fresh.service.connect(), /does not support/);
  assert.deepEqual(fresh.writes, []);
  assert.ok(!fresh.calls.includes('requestPermission'));
});

test('permission revocation does not prompt from background sync or write to native reminders', async () => {
  const f = fixture();
  f.setGranted(false);
  await assert.rejects(f.service.sync(), /Reminders access is off/);
  assert.ok(!f.calls.includes('requestPermission'));
  assert.ok(!f.calls.includes('feed'));
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.writes, []);
});

test('disposing during an authoritative feed prevents native reads and all subsequent writes', async () => {
  const f = fixture();
  const started = deferred<void>();
  const waiting = deferred<SubscriptionSyncFeed>();
  f.hooks.feed = () => { started.resolve(); return waiting.promise; };
  const running = f.service.sync();
  const rejection = assert.rejects(running, /account or connection changed/);
  await started.promise;
  f.service.dispose();
  waiting.resolve({ subscriptions: [subscription], charges: [] });
  await rejection;
  assert.ok(f.calls.every(call => !call.startsWith('list:')));
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.writes, []);
  await assert.rejects(f.service.sync(), /account or connection changed/);
});

test('disposing during a native read cancels all planned mutations and a separate account cannot reuse the old scope', async () => {
  const f = fixture();
  const started = deferred<void>();
  const waiting = deferred<SyncedReminder[]>();
  f.hooks.list = () => { started.resolve(); return waiting.promise; };
  const rejection = assert.rejects(f.service.sync(), /account or connection changed/);
  await started.promise;
  f.service.dispose();
  waiting.resolve([]);
  await rejection;
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.writes, []);
  const other = fixture({ scope: { ...scope, userId: 'child-b', allowedChildIds: ['child-b'] } });
  // A stale or misrouted feed is rejected before the executor can touch it.
  await assert.rejects(other.service.sync(), /cannot sync that child/);
  assert.deepEqual(other.nativeWrites, []);
  assert.deepEqual(other.writes, []);
});

test('disconnect immediately invalidates an in-flight feed, disables durable sync, and preserves reminder history', async () => {
  const history = reminder(subscription, { completed: true });
  const f = fixture({ reminders: [history] });
  const started = deferred<void>();
  const waiting = deferred<SubscriptionSyncFeed>();
  f.hooks.feed = () => { started.resolve(); return waiting.promise; };
  const rejection = assert.rejects(f.service.sync(), /account or connection changed/);
  await started.promise;
  const disconnected = f.service.disconnect();
  assert.equal(f.service.getSnapshot().enabled, false);
  waiting.resolve({ subscriptions: [], charges: [] });
  await rejection; await disconnected;
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.reminders, [history]);
  assert.equal(f.config?.enabled, false);
  assert.equal(f.config?.scopeId, owner);
  assert.equal(f.config?.calendarId, calendarId);
  assert.equal(f.service.getSnapshot().syncing, false);
  const count = f.calls.length;
  await f.service.sync();
  assert.equal(f.calls.length, count);
});

test('disconnect during one native mutation stops later operations while retaining completed history', async () => {
  const history = reminder(subscription, { id: 'old-completed', completed: true });
  const f = fixture({ reminders: [history] });
  f.setFeed({ subscriptions: [{ ...subscription, id: 'new-a' }, { ...subscription, id: 'new-b' }], charges: [] });
  const started = deferred<void>();
  const waiting = deferred<void>();
  f.hooks.afterApply = () => { started.resolve(); return waiting.promise; };
  const rejection = assert.rejects(f.service.sync(), /account or connection changed/);
  await started.promise;
  const disconnected = f.service.disconnect();
  waiting.resolve();
  await rejection; await disconnected;
  assert.equal(f.nativeWrites.length, 1, 'The already-started native write may finish, but the second must not start');
  assert.equal(f.reminders.find(item => item.id === history.id)?.completed, true);
  assert.equal(f.config?.enabled, false);
});

test('an uncertain partial apply is retried from fresh native state without creating a duplicate reminder', async () => {
  const f = fixture();
  f.setFeed({ subscriptions: [{ ...subscription, id: 'subscription-a' }, { ...subscription, id: 'subscription-b' }], charges: [] });
  let failed = false;
  f.hooks.afterApply = async () => { if (!failed) { failed = true; throw new Error('Native response lost after commit'); } };
  await assert.rejects(f.service.sync(), /response lost/);
  assert.equal(f.reminders.length, 1);
  assert.equal(f.writes.length, 0);
  await f.service.sync();
  assert.equal(f.calls.filter(call => call.startsWith('list:')).length, 2);
  assert.equal(f.reminders.length, 2);
  assert.equal(new Set(f.reminders.map(item => item.marker)).size, 2);
  assert.equal(f.nativeWrites.filter(operation => operation.kind === 'create').length, 2);
  assert.equal(f.service.getSnapshot().error, null);
});

test('restoring durable ownership reuses its list and ignores manual or foreign reminders', async () => {
  const own = reminder(subscription, { title: 'Old title' });
  const manual = reminder(subscription, { id: 'manual', marker: null, title: 'Personal' });
  const foreign = reminder(subscription, { id: 'foreign', marker: createReminderMarker(unrelatedOwner, subscription.id, subscription.nextChargeDate) });
  const otherList = reminder(subscription, { id: 'other-list', calendarId: 'someone-else-list' });
  const f = fixture({ reminders: [own, manual, foreign, otherList] });
  await f.service.initialize(); await f.service.sync();
  assert.deepEqual(f.nativeWrites.map(operation => operation.kind), ['update']);
  assert.ok(f.calls.every(call => !call.startsWith('createList:')));
  assert.ok(!f.calls.includes('uuid'));
  assert.ok(!f.calls.includes('requestPermission'));
  assert.deepEqual(f.reminders.filter(item => item.id !== own.id), [manual, foreign, otherList]);
  f.service.dispose();
  const restored = new RemindersService(scope, f.getFeed, f.device);
  await restored.initialize(); await restored.sync();
  assert.equal(f.nativeWrites.length, 1);
  assert.equal(f.config?.scopeId, owner);
  assert.equal(f.config?.calendarId, calendarId);
});

test('simultaneous sync requests share one pass and listeners stop after disposal', async () => {
  const f = fixture();
  const started = deferred<void>();
  const waiting = deferred<SubscriptionSyncFeed>();
  f.hooks.feed = () => { started.resolve(); return waiting.promise; };
  let notifications = 0;
  f.service.subscribe(() => { notifications++; });
  const first = f.service.sync();
  const second = f.service.sync();
  assert.equal(first, second);
  await started.promise;
  waiting.resolve({ subscriptions: [subscription], charges: [] });
  await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call === 'feed').length, 1);
  assert.equal(f.nativeWrites.length, 1);
  assert.ok(notifications > 0);
  const before = notifications;
  f.service.dispose();
  await assert.rejects(f.service.disconnect(), /account or connection changed/);
  assert.equal(notifications, before);
});

test('disposal during list creation preserves its returned ID disabled and reconnect reuses that owned list', async () => {
  const f = fixture({ config: null });
  const started = deferred<void>();
  const waiting = deferred<string>();
  f.hooks.createList = () => { started.resolve(); return waiting.promise; };
  const rejection = assert.rejects(f.service.connect(), /account or connection changed/);
  await started.promise;
  assert.equal(f.config?.scopeId, owner);
  assert.equal(f.config?.calendarId, null);
  f.service.dispose();
  waiting.resolve(calendarId);
  await rejection;
  assert.deepEqual(f.config, { version: 1, scopeId: owner, calendarId, enabled: false, lastSync: null });
  assert.equal(f.nativeWrites.length, 0);
  const reconnected = new RemindersService(scope, f.getFeed, f.device);
  await reconnected.connect();
  assert.equal(f.calls.filter(call => call.startsWith('createList:')).length, 1);
  assert.equal(f.calls.filter(call => call === 'uuid').length, 1);
  assert.equal(f.nativeWrites.filter(operation => operation.kind === 'create').length, 1);
  assert.equal(f.config?.enabled, true);
});

test('disconnect invalidates the executor guard while its ownership fetch is pending, before any native mutation', async () => {
  const f = fixture();
  const started = deferred<void>();
  const waiting = deferred<void>();
  let guard!: () => boolean;
  f.hooks.beforeApply = async (_operation, isCurrent) => {
    guard = isCurrent;
    assert.equal(guard(), true);
    started.resolve();
    await waiting.promise;
  };
  const rejection = assert.rejects(f.service.sync(), /account or connection changed/);
  await started.promise;
  const disconnected = f.service.disconnect();
  assert.equal(guard(), false);
  waiting.resolve();
  await rejection; await disconnected;
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.reminders, []);
  assert.equal(f.config?.enabled, false);
  assert.equal(f.config?.lastSync, saved.lastSync);
});

test('a removed or read-only list is durably disabled and explicit reconnect creates a replacement without deleting history', async () => {
  const history = reminder(subscription, { id: 'completed-history', completed: true });
  const f = fixture({ reminders: [history] });
  f.hooks.list = async () => { throw new RemindersListUnavailableError(); };
  await assert.rejects(f.service.sync(), RemindersListUnavailableError);
  assert.equal(f.service.getSnapshot().enabled, false);
  assert.equal(f.service.getSnapshot().syncing, false);
  assert.equal(f.config?.calendarId, null);
  assert.equal(f.config?.enabled, false);
  assert.equal(f.config?.scopeId, owner);
  assert.equal(f.config?.lastSync, saved.lastSync);
  assert.equal(f.nativeWrites.length, 0);
  assert.deepEqual(f.reminders, [history]);
  assert.ok(!f.calls.includes('requestPermission'));
  f.service.dispose();
  const restored = new RemindersService(scope, f.getFeed, f.device);
  await restored.initialize();
  const calls = f.calls.length;
  await restored.sync();
  assert.equal(f.calls.length, calls, 'A missing list must not recreate itself through automatic sync');
  delete f.hooks.list;
  f.hooks.createList = async () => 'replacement-list';
  await restored.connect();
  assert.equal(f.config?.calendarId, 'replacement-list');
  assert.equal(f.config?.enabled, true);
  assert.equal(f.calls.filter(call => call.startsWith('createList:')).length, 1);
  assert.equal(f.nativeWrites.length, 1);
  assert.equal(f.nativeWrites[0].kind, 'create');
  assert.deepEqual(f.reminders.find(item => item.id === history.id), history);
  assert.equal(f.reminders.filter(item => item.calendarId === 'replacement-list').length, 1);
});

test('an ordinary native-list read failure preserves the existing connection instead of resetting ownership', async () => {
  const f = fixture({ reminders: [reminder()] });
  f.hooks.list = async () => { throw new Error('Native store temporarily unavailable'); };
  await assert.rejects(f.service.sync(), /temporarily unavailable/);
  assert.equal(f.config?.calendarId, calendarId);
  assert.equal(f.config?.enabled, true);
  assert.equal(f.nativeWrites.length, 0);
  assert.equal(f.writes.length, 0);
  delete f.hooks.list;
  await f.service.sync();
  assert.equal(f.nativeWrites.length, 0);
  assert.equal(f.service.getSnapshot().error, null);
});

test('a transient configuration read does not permanently cache rejection and initialization can recover', async () => {
  const f = fixture({ reminders: [reminder()] });
  let reads = 0;
  f.hooks.read = async () => {
    if (++reads === 1) throw new Error('Secure storage temporarily unavailable');
    return copy(saved);
  };
  const first = f.service.initialize();
  assert.equal(f.service.initialize(), first);
  await assert.rejects(first, /Secure storage temporarily unavailable/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.nativeWrites.length, 0);
  assert.ok(!f.calls.includes('requestPermission'));
  await f.service.initialize();
  assert.equal(reads, 2);
  assert.equal(f.service.getSnapshot().enabled, true);
  assert.equal(f.service.getSnapshot().lastSync, saved.lastSync);
  await f.service.sync();
  assert.equal(reads, 2, 'Recovered configuration should be cached once loaded successfully');
  assert.equal(f.nativeWrites.length, 0);
  assert.equal(f.service.getSnapshot().error, null);
});
