/// <reference types="node" />
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createFamilyServer } from '../../server/index.mjs';
import { APIError, PocketAPI, type FetchOptions, type FetchResponse } from '../src/data/api';
import { PocketController, type SessionStorage } from '../src/data/controller';
import type { FamilyState, Subscription, SubscriptionInput } from '../src/data/models';
import { defaultSubscriptionDate, parseSubscription, parseSubscriptions, parseSubscriptionSync, REMINDERS_UPDATE_MESSAGE, subscriptionDateLabel, subscriptionPatchPayload, SUBSCRIPTIONS_UPDATE_MESSAGE, todayInTimeZone, validateSubscriptionDate, validateSubscriptionInput, validateSubscriptionPatch, validateSubscriptionTimeZone } from '../src/data/subscriptions';
import { money, parseFamilyState, parseHealth } from '../src/data/validation';

const serverURL = 'http://127.0.0.1:8787';
const parent = { id: 'parent-a', name: 'Parent', username: 'parent', role: 'parent' as const };
const child = { id: 'child-a', name: 'Avery', username: 'avery', role: 'child' as const, balanceCents: -499 };
const sibling = { id: 'child-b', name: 'Jordan', username: 'jordan', role: 'child' as const, balanceCents: 0 };
const auths = [parent, child, sibling].map((user, index) => ({ user, token: String.fromCharCode(65 + index).repeat(43), familyName: 'Family', familyCode: '00123456' }));
const health = { setupRequired: false, pushConfigured: false, capabilities: { subscriptions: true } };
const input: SubscriptionInput = { childId: child.id, name: 'Music', amountCents: 499, interval: 'monthly', nextChargeDate: '2026-12-16', timeZone: 'America/New_York', idempotencyKey: 'create-subscription-a' };
const item: Subscription = { id: 'subscription-a', childId: input.childId, name: input.name, amountCents: input.amountCents, interval: input.interval, nextChargeDate: input.nextChargeDate, timeZone: input.timeZone, paused: false, createdAt: '2026-11-16T14:00:00Z', updatedAt: '2026-11-16T14:00:00Z' };
const charge = { subscriptionId: item.id, periodDate: '2026-11-16', transactionId: 'transaction-a', childId: child.id, createdAt: item.createdAt };
function response(payload: unknown, status = 200): FetchResponse { return { status, async json() { return payload; } }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class Storage implements SessionStorage {
  server = serverURL;
  tokens = new Map<string, string>();
  async getServerURL() { return this.server; }
  async setServerURL(value: string) { this.server = value; }
  async getToken(server: string) { return this.tokens.get(server) ?? null; }
  async setToken(server: string, token: string) { this.tokens.set(server, token); }
  async removeToken(server: string) { this.tokens.delete(server); }
}
type Hook = (path: string, options: FetchOptions) => Promise<FetchResponse | undefined>;
async function fixture(hook: Hook = async () => undefined, username = 'avery') {
  const calls: { path: string; options: FetchOptions }[] = [];
  const controller = new PocketController(new Storage(), async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    const overridden = await hook(path, options);
    if (overridden) return overridden;
    if (path === '/health') return response(health);
    if (path === '/login') return response(auths.find(auth => auth.user.username === JSON.parse(options.body!).username));
    if (path === '/state') {
      const auth = auths.find(auth => `Bearer ${auth.token}` === options.headers.Authorization)!;
      const state: FamilyState = { user: auth.user, familyName: auth.familyName, familyCode: auth.familyCode, members: auth.user.role === 'parent' ? [parent, child, sibling] : [auth.user], transactions: [], notifications: [], computerNotifications: [], pushConfigured: false };
      return response(state);
    }
    if (path === '/subscriptions' && options.method === 'GET') return response({ subscriptions: [item] });
    if (path === '/subscriptions' && options.method === 'POST') return response({ subscription: { ...item, ...JSON.parse(options.body!) } });
    if (path.startsWith('/subscriptions/') && options.method === 'PATCH') return response({ subscription: { ...item, ...JSON.parse(options.body!) } });
    return response({ ok: true });
  });
  await controller.initialize(); await controller.signIn(username, 'password');
  return { controller, calls };
}

test('billing dates preserve calendar days across zones and clamp next-month defaults', () => {
  assert.equal(defaultSubscriptionDate(new Date('2027-01-31T17:00:00Z'), 'America/New_York'), '2027-02-28');
  assert.equal(defaultSubscriptionDate(new Date('2028-01-31T17:00:00Z'), 'America/New_York'), '2028-02-29');
  assert.equal(defaultSubscriptionDate(new Date('2026-12-29T17:00:00Z'), 'America/New_York', 'weekly'), '2027-01-05');
  assert.equal(defaultSubscriptionDate(new Date('2028-02-29T17:00:00Z'), 'America/New_York', 'yearly'), '2029-02-28');
  assert.equal(todayInTimeZone(new Date('2027-01-01T01:00:00Z'), 'America/Los_Angeles'), '2026-12-31');
  assert.equal(defaultSubscriptionDate(new Date('2027-01-01T01:00:00Z'), 'America/Los_Angeles'), '2027-01-31');
  assert.match(subscriptionDateLabel('2027-01-01'), /2027/);
  assert.equal(validateSubscriptionDate('2028-02-29'), '2028-02-29');
  for (const value of ['2027-02-29', '2026-04-31', '2026-13-01', '2026-01-00', '2026-1-01', '1999-12-31', '2201-01-01', 'today']) assert.throws(() => validateSubscriptionDate(value));
  for (const value of ['Not/A_Zone', '+01:00', ' America/New_York', '']) assert.throws(() => validateSubscriptionTimeZone(value));
});

test('reminder sync parses actual charges, including removed schedules, and rejects invented or duplicate dates', async () => {
  assert.deepEqual(parseSubscriptionSync({ subscriptions: [], charges: [charge] }), { subscriptions: [], charges: [charge] });
  for (const changed of [{ periodDate: '2026-02-30' }, { transactionId: '' }, { childId: '' }, { createdAt: 'today' }]) assert.throws(() => parseSubscriptionSync({ subscriptions: [item], charges: [{ ...charge, ...changed }] }));
  assert.throws(() => parseSubscriptionSync({ subscriptions: [item], charges: [charge, charge] }));
  assert.throws(() => parseHealth({ ...health, capabilities: { subscriptionReminders: 'yes' } }));
  let captured!: FetchOptions;
  const api = new PocketAPI(serverURL, async (url, options) => {
    assert.equal(new URL(url).pathname, '/subscriptions/sync'); captured = options;
    return response({ subscriptions: [item], charges: [charge] });
  });
  assert.equal((await api.subscriptionSync(auths[1].token)).charges[0].transactionId, charge.transactionId);
  assert.equal(captured.method, 'GET');
  assert.equal(captured.headers.Authorization, `Bearer ${auths[1].token}`);
  const old = new PocketAPI(serverURL, async () => response({ error: 'Not found' }, 404));
  await assert.rejects(old.subscriptionSync(auths[1].token), error => error instanceof APIError && error.message === REMINDERS_UPDATE_MESSAGE);
});

test('reminder feeds cannot expose sibling charges or arrive after the account changes', async () => {
  const supported = { ...health, capabilities: { subscriptions: true, subscriptionReminders: true } };
  const wrong = await fixture(async path => path === '/health' ? response(supported) : path === '/subscriptions/sync' ? response({ subscriptions: [item], charges: [{ ...charge, childId: sibling.id }] }) : undefined);
  await assert.rejects(wrong.controller.subscriptionSync(), /cannot access/);
  const old = await fixture();
  await assert.rejects(old.controller.subscriptionSync(), /Update the Pocket server/);
  assert.equal(old.calls.some(call => call.path === '/subscriptions/sync'), false);
  const held = deferred<FetchResponse>(); const started = deferred<void>();
  const current = await fixture(async path => {
    if (path === '/health') return response(supported);
    if (path === '/subscriptions/sync') { started.resolve(); return held.promise; }
    return undefined;
  });
  const syncing = current.controller.subscriptionSync(); await started.promise;
  await current.controller.signIn('jordan', 'password');
  held.resolve(response({ subscriptions: [item], charges: [charge] }));
  await assert.rejects(syncing, /replaced/);
  assert.equal(current.controller.getSnapshot().state?.user.id, sibling.id);
});

test('subscription validation rejects malformed amounts, schedules and responses while balances can be negative', () => {
  assert.deepEqual(validateSubscriptionInput(input), input);
  assert.deepEqual(parseSubscriptions({ subscriptions: [item] }), [item]);
  assert.throws(() => parseSubscriptions({ subscriptions: [item, item] }), /duplicate/);
  for (const changed of [{ amountCents: 4.99 }, { amountCents: -499 }, { amountCents: 0 }, { amountCents: 1_000_001 }, { interval: 'daily' }, { paused: 'false' }, { nextChargeDate: '2027-02-30' }, { createdAt: 'not-a-date' }]) assert.throws(() => parseSubscription({ ...item, ...changed }));
  assert.throws(() => validateSubscriptionPatch({ childId: sibling.id } as never));
  assert.throws(() => validateSubscriptionPatch({ idempotencyKey: 'key-only' }));
  assert.equal(subscriptionPatchPayload({ paused: true, name: 'Music', idempotencyKey: 'original-key' }), subscriptionPatchPayload({ name: 'Music', paused: true, idempotencyKey: 'new-key' }));
  assert.equal(parseHealth(health).capabilities?.subscriptions, true);
  assert.throws(() => parseHealth({ ...health, capabilities: { subscriptions: 'true' } }));
  const negative = parseFamilyState({ user: child, familyName: 'Family', members: [child], transactions: [], notifications: [], pushConfigured: false });
  assert.equal(negative.members[0].balanceCents, -499);
  assert.match(money(-499), /-.*4\.99/);
});

test('subscription APIs use authenticated GET, POST, PATCH and DELETE without URL credentials', async () => {
  const calls: { path: string; options: FetchOptions }[] = [];
  const api = new PocketAPI(serverURL, async (url, options) => {
    calls.push({ path: new URL(url).pathname, options });
    return response(options.method === 'GET' ? { subscriptions: [item] } : options.method === 'DELETE' ? { ok: true } : { subscription: item });
  });
  await api.listSubscriptions(auths[1].token);
  await api.createSubscription(auths[1].token, input);
  await api.updateSubscription(auths[1].token, item.id, { paused: true, idempotencyKey: 'pause-key-1' });
  await api.deleteSubscription(auths[1].token, item.id);
  assert.deepEqual(calls.map(call => call.options.method), ['GET', 'POST', 'PATCH', 'DELETE']);
  assert.deepEqual(calls.map(call => call.path), ['/subscriptions', '/subscriptions', '/subscriptions/subscription-a', '/subscriptions/subscription-a']);
  assert.ok(calls.every(call => call.options.headers.Authorization === `Bearer ${auths[1].token}` && call.options.credentials === 'omit' && call.options.redirect === 'manual'));
  assert.deepEqual(JSON.parse(calls[1].options.body!), input);
  assert.equal(JSON.parse(calls[2].options.body!).paused, true);
  await assert.rejects(api.deleteSubscription(auths[1].token, '../family'), /valid subscription/);
  const old = new PocketAPI(serverURL, async () => response({ error: 'Not found' }, 404));
  await assert.rejects(old.listSubscriptions(auths[1].token), error => error instanceof APIError && error.message === SUBSCRIPTIONS_UPDATE_MESSAGE);
  await assert.rejects(old.updateSubscription(auths[1].token, item.id, { paused: true }), error => error instanceof APIError && error.status === 404);
});

test('older servers never receive mutation requests and a child cannot create for a sibling or receive sibling lists', async () => {
  const older = await fixture(async path => path === '/health' ? response({ setupRequired: false, pushConfigured: false }) : undefined);
  await assert.rejects(older.controller.listSubscriptions(), error => error instanceof Error && error.message === SUBSCRIPTIONS_UPDATE_MESSAGE);
  await assert.rejects(older.controller.createSubscription(input), /Update the Pocket server/);
  assert.equal(older.calls.some(call => call.path.startsWith('/subscriptions')), false);
  const normal = await fixture();
  await assert.rejects(normal.controller.createSubscription({ ...input, childId: sibling.id }), /cannot access/);
  assert.equal(normal.calls.some(call => call.path === '/subscriptions'), false);
  const wrongScope = await fixture(async path => path === '/subscriptions' ? response({ subscriptions: [{ ...item, childId: sibling.id }] }) : undefined);
  await assert.rejects(wrongScope.controller.listSubscriptions(), /cannot access/);
});

test('an uncertain creation keeps its exact key across screen changes and sign-in; a different request cannot duplicate it', async () => {
  let fail = true;
  const sent: SubscriptionInput[] = [];
  const { controller } = await fixture(async (path, options) => {
    if (path === '/subscriptions' && options.method === 'POST') {
      sent.push(JSON.parse(options.body!));
      if (fail) throw new Error('Lost response');
    }
    return undefined;
  });
  await assert.rejects(controller.createSubscription(input), /Could not reach/);
  assert.equal(controller.getSnapshot().pendingSubscription?.idempotencyKey, input.idempotencyKey);
  await assert.rejects(controller.createSubscription({ ...input, amountCents: 999, idempotencyKey: 'different-key' }), /still unconfirmed/);
  assert.equal(sent.length, 1);
  await controller.signOut(); await controller.signIn('parent', 'password');
  assert.equal(controller.getSnapshot().pendingSubscription, null);
  await controller.signIn('avery', 'password');
  assert.equal(controller.getSnapshot().pendingSubscription?.idempotencyKey, input.idempotencyKey);
  fail = false;
  const result = await controller.createSubscription({ ...input, idempotencyKey: 'replacement-key' });
  assert.equal(result.id, item.id);
  assert.deepEqual(sent[1], input);
  assert.equal(controller.getSnapshot().pendingSubscription, null);
});

test('an uncertain edit preserves its key and intended fields after a later 401, while other edits stay blocked', async () => {
  let outcome = 0;
  const sent: unknown[] = [];
  const { controller } = await fixture(async (path, options) => {
    if (path === `/subscriptions/${item.id}` && options.method === 'PATCH') {
      sent.push(JSON.parse(options.body!));
      if (!outcome) throw new Error('Lost response');
      if (outcome === 401) return response({ error: 'Session expired' }, 401);
    }
    return undefined;
  });
  const patch = { paused: true, idempotencyKey: 'pause-original' };
  await assert.rejects(controller.updateSubscription(item.id, patch));
  await assert.rejects(controller.updateSubscription(item.id, { paused: false, idempotencyKey: 'resume-other' }), /still unconfirmed/);
  outcome = 401;
  await assert.rejects(controller.updateSubscription(item.id, { ...patch, idempotencyKey: 'pause-retry' }));
  await controller.signIn('avery', 'password');
  assert.deepEqual(controller.getSnapshot().pendingSubscriptionUpdate, { id: item.id, patch });
  outcome = 200;
  const saved = await controller.updateSubscription(item.id, { ...patch, idempotencyKey: 'pause-retry-2' });
  assert.equal(saved.paused, true);
  assert.deepEqual(sent, [patch, patch, patch]);
  assert.equal(controller.getSnapshot().pendingSubscriptionUpdate, null);
});

test('definitive rejection allows a corrected subscription and confirmed writes stay successful if refresh fails', async () => {
  let rejected = true;
  let refreshFails = false;
  const { controller } = await fixture(async (path, options) => {
    if (path === '/subscriptions' && options.method === 'POST') {
      if (rejected) return response({ error: 'Invalid date' }, 400);
      refreshFails = true;
    }
    if (path === '/state' && refreshFails) return response({ error: 'Refresh unavailable' }, 503);
    return undefined;
  });
  await assert.rejects(controller.createSubscription(input), /Invalid date/);
  assert.equal(controller.getSnapshot().pendingSubscription, null);
  rejected = false;
  const saved = await controller.createSubscription({ ...input, name: 'Music plan', idempotencyKey: 'corrected-plan' });
  assert.equal(saved.name, 'Music plan');
  assert.equal(controller.getSnapshot().pendingSubscription, null);
  assert.equal(controller.getSnapshot().error, 'Refresh unavailable');
});

test('late subscription lists and mutations cannot cross account or server changes', async () => {
  for (const operation of ['list', 'create', 'update', 'delete'] as const) {
    const started = deferred<void>();
    const held = deferred<FetchResponse>();
    const { controller } = await fixture(async path => {
      if (path.startsWith('/subscriptions')) { started.resolve(); return held.promise; }
      return undefined;
    });
    const pending = operation === 'list' ? controller.listSubscriptions() : operation === 'create' ? controller.createSubscription(input) : operation === 'update' ? controller.updateSubscription(item.id, { paused: true, idempotencyKey: 'pause-key' }) : controller.deleteSubscription(item.id);
    await started.promise;
    await controller.changeServer('https://other.example');
    await controller.signIn('jordan', 'password');
    held.resolve(response(operation === 'list' ? { subscriptions: [item] } : operation === 'delete' ? { ok: true } : { subscription: item }));
    await assert.rejects(pending, /replaced/);
    assert.equal(controller.getSnapshot().state?.user.id, sibling.id);
    assert.equal(controller.getSnapshot().pendingSubscription, null);
    assert.equal(controller.getSnapshot().pendingSubscriptionUpdate, null);
    assert.equal(controller.getSnapshot().error, null);
  }
});

test('concurrent creation checks cannot post two different subscriptions before the first is confirmed', async () => {
  const held = deferred<FetchResponse>();
  const started = deferred<void>();
  let posts = 0;
  const { controller } = await fixture(async (path, options) => {
    if (path === '/subscriptions' && options.method === 'POST') { posts++; started.resolve(); return held.promise; }
    return undefined;
  });
  const first = controller.createSubscription(input);
  await started.promise;
  await assert.rejects(controller.createSubscription({ ...input, name: 'Another plan', idempotencyKey: 'other-plan' }), /still unconfirmed/);
  held.resolve(response({ subscription: item }));
  await first;
  assert.equal(posts, 1);
});

test('an older mutation response cannot erase a newer pending retry key for the same account', async () => {
  for (const operation of ['create', 'update'] as const) for (const oldStatus of [200, 400]) {
    const replies = [deferred<FetchResponse>(), deferred<FetchResponse>(), deferred<FetchResponse>()];
    const started = [deferred<void>(), deferred<void>(), deferred<void>()];
    let count = 0;
    const { controller } = await fixture(async (path, options) => {
      if (path.startsWith('/subscriptions') && ['POST', 'PATCH'].includes(options.method)) {
        const index = count++; started[index].resolve(); return replies[index].promise;
      }
      return undefined;
    });
    const send = (key: string, amountCents = 499) => operation === 'create'
      ? controller.createSubscription({ ...input, amountCents, idempotencyKey: key })
      : controller.updateSubscription(item.id, { amountCents, idempotencyKey: key });
    const original = send('original-request');
    await started[0].promise;
    await controller.signOut(); await controller.signIn('avery', 'password');
    const retry = send('retry-uses-original');
    await started[1].promise;
    replies[1].resolve(response({ subscription: item })); await retry;
    const newer = send('newer-request', 999);
    await started[2].promise;
    replies[0].resolve(response(oldStatus === 200 ? { subscription: item } : { error: 'Rejected' }, oldStatus));
    await assert.rejects(original);
    const pendingKey = operation === 'create' ? controller.getSnapshot().pendingSubscription?.idempotencyKey : controller.getSnapshot().pendingSubscriptionUpdate?.patch.idempotencyKey;
    assert.equal(pendingKey, 'newer-request');
    await controller.signOut(); await controller.signIn('avery', 'password');
    const restoredKey = operation === 'create' ? controller.getSnapshot().pendingSubscription?.idempotencyKey : controller.getSnapshot().pendingSubscriptionUpdate?.patch.idempotencyKey;
    assert.equal(restoredKey, 'newer-request', 'the newer key also survives in the scoped retry map');
    replies[2].resolve(response({ subscription: { ...item, amountCents: 999 } }));
    await assert.rejects(newer, /replaced/);
  }
});

test('removed subscriptions release only their terminal pending requests so other subscriptions remain editable', async () => {
  for (const terminal of ['create-410', 'update-404', 'list-removed', 'create-past-date', 'update-past-date'] as const) {
    let failed = false;
    const { controller } = await fixture(async (path, options) => {
      if (terminal === 'list-removed' && path === '/subscriptions' && options.method === 'GET') return response({ subscriptions: [] });
      if (path.startsWith('/subscriptions') && ['POST', 'PATCH'].includes(options.method)) {
        if (!failed) { failed = true; throw new Error('Lost response'); }
        if (terminal === 'create-410') return response({ error: 'The subscription was removed.' }, 410);
        if (terminal === 'update-404') return response({ error: 'Subscription not found.' }, 404);
        if (terminal.endsWith('past-date')) return response({ error: 'Choose today or a future charge date.' }, 400);
      }
      return undefined;
    });
    if (terminal.startsWith('create')) {
      await assert.rejects(controller.createSubscription(input));
      await assert.rejects(controller.createSubscription(input), /removed|future charge date/);
      assert.equal(controller.getSnapshot().pendingSubscription, null);
    } else {
      const patch = { paused: true, idempotencyKey: 'terminal-update' };
      await assert.rejects(controller.updateSubscription(item.id, patch));
      if (terminal.startsWith('update')) await assert.rejects(controller.updateSubscription(item.id, patch), /not found|future charge date/);
      else await controller.listSubscriptions();
      assert.equal(controller.getSnapshot().pendingSubscriptionUpdate, null);
    }
    await controller.signOut(); await controller.signIn('avery', 'password');
    assert.equal(controller.getSnapshot().pendingSubscription, null);
    assert.equal(controller.getSnapshot().pendingSubscriptionUpdate, null);
  }
});

test('real subscriptions can take a balance negative, notify only parents and that child, and stop future charges on deletion', async t => {
  const app = createFamilyServer({ dbPath: ':memory:' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = new PocketAPI(url, (target, options) => fetch(target, options));
  const owner = await api.createFamily({ familyName: 'Family', name: 'Parent', username: 'parent', password: 'parent-password' });
  for (const name of ['Avery', 'Jordan']) await api.addMember(owner.token, { name, username: name.toLowerCase(), password: 'child-password', role: 'child' });
  const a = await api.signIn('avery', 'child-password', owner.familyCode);
  const b = await api.signIn('jordan', 'child-password', owner.familyCode);
  const today = todayInTimeZone(new Date(), 'UTC');
  const subscription = await api.createSubscription(a.token, { ...input, childId: a.user.id, nextChargeDate: today, timeZone: 'UTC' });
  assert.equal((await api.state(a.token)).members.find(member => member.id === a.user.id)?.balanceCents, -499);
  assert.equal((await api.state(a.token)).notifications.length, 1);
  assert.equal((await api.subscriptionSync(a.token)).charges.length, 1);
  assert.equal((await api.subscriptionSync(b.token)).charges.length, 0);
  assert.equal((await api.state(owner.token)).notifications.length, 1);
  assert.equal((await api.state(b.token)).notifications.length, 0);
  assert.equal((await api.listSubscriptions(b.token)).length, 0);
  await assert.rejects(api.updateSubscription(b.token, subscription.id, { paused: true, idempotencyKey: 'sibling-pause' }), error => error instanceof APIError && error.status === 404);
  const paused = await api.updateSubscription(owner.token, subscription.id, { paused: true, idempotencyKey: 'parent-pause' });
  assert.equal(paused.paused, true);
  await api.deleteSubscription(a.token, subscription.id);
  assert.equal((await api.listSubscriptions(a.token)).length, 0);
  assert.equal((await api.subscriptionSync(a.token)).charges.length, 1, 'deleted schedules retain confirmed charge history for Reminders');
  assert.equal((await api.state(a.token)).transactions.length, 1, 'old charge history remains');
});
