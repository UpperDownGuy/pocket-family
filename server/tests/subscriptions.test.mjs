import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFamilyServer } from '../index.mjs';

async function fixture(t, initial = '2026-01-01T12:00:00Z') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pocket-subscriptions-')));
  const dbPath = join(directory, 'family.sqlite');
  let now = new Date(initial);
  let app = createFamilyServer({ dbPath, clock: () => now });
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(method, path, input, token) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method,
      headers: { ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: input === undefined ? undefined : JSON.stringify(input) });
    return { httpStatus: response.status, ...await response.json() };
  }
  const password = 'family-password-123';
  const parent = await request('POST', '/families', { familyName: 'Subscription family', name: 'Parent', username: 'parent', password });
  async function member(name, role = 'child', family = parent) {
    assert.equal((await request('POST', '/members', { name, username: name, password, role }, family.token)).httpStatus, 200);
    return request('POST', '/login', { username: name, password, familyCode: family.familyCode });
  }
  const parent2 = await member('parent2', 'parent');
  const child = await member('child');
  const sibling = await member('sibling');
  const state = who => request('GET', '/state', undefined, who.token);
  const input = (changes = {}) => ({ childId: child.user.id, name: 'Music', amountCents: 500, interval: 'monthly',
    nextChargeDate: '2026-01-02', timeZone: 'UTC', idempotencyKey: randomUUID(), ...changes });
  const create = (values = input(), who = parent) => request('POST', '/subscriptions', values, who.token);
  const list = (who = parent) => request('GET', '/subscriptions', undefined, who.token);
  const patch = (id, values, who = parent) => request('PATCH', `/subscriptions/${id}`, values, who.token);
  const remove = (id, who = parent) => request('DELETE', `/subscriptions/${id}`, undefined, who.token);
  const tick = (limit = 25) => app.registry.processSubscriptions({ now, limit });
  const store = () => app.registry.authenticated(`Bearer ${parent.token}`).store;
  return { request, parent, parent2, child, sibling, member, state, input, create, list, patch, remove, tick, store,
    setNow(value) { now = new Date(value); }, get app() { return app; },
    async reopen() { await app.close(); app = createFamilyServer({ dbPath, clock: () => now }); await listen(); } };
}

test('today charges immediately once, permits negative balances, and notifies only parents and its child', async t => {
  const f = await fixture(t);
  const payload = f.input({ nextChargeDate: '2026-01-01' });
  const first = await f.create(payload, f.child);
  assert.equal(first.httpStatus, 200);
  assert.equal(first.subscription.nextChargeDate, '2026-02-01');
  assert.equal((await f.create(payload, f.child)).replayed, true);
  assert.equal((await f.create({ ...payload, amountCents: 501 }, f.child)).httpStatus, 409);
  assert.equal(f.tick().processed, 0);
  for (const who of [f.parent, f.parent2, f.child]) {
    const state = await f.state(who);
    assert.equal(state.transactions.length, 1);
    assert.equal(state.transactions[0].kind, 'purchase');
    assert.equal(state.transactions[0].amountCents, 500);
    assert.equal(state.transactions[0].note, 'Subscription · 2026-01-01');
    assert.equal(state.notifications.length, 1);
  }
  assert.equal((await f.state(f.child)).members[0].balanceCents, -500);
  assert.deepEqual((await f.state(f.sibling)).transactions, []);
  assert.deepEqual((await f.state(f.sibling)).notifications, []);
  f.setNow('2026-01-03T12:00:00Z');
  assert.equal((await f.create(payload, f.child)).replayed, true);
  assert.equal((await f.state(f.child)).transactions.length, 1);
});

test('missed weekly periods catch up in bounded oldest-first batches and remain exactly once after restart', async t => {
  const f = await fixture(t);
  const created = await f.create(f.input({ interval: 'weekly' }));
  assert.equal(created.httpStatus, 200);
  f.setNow('2026-02-01T12:00:00Z');
  assert.deepEqual(f.tick(2), { processed: 2, failed: 0, dueRemaining: true });
  assert.equal((await f.list()).subscriptions[0].nextChargeDate, '2026-01-16');
  assert.deepEqual(f.store().db.prepare('SELECT period_date FROM subscription_charges ORDER BY period_date').all().map(row => row.period_date), ['2026-01-02', '2026-01-09']);
  await f.reopen();
  assert.equal((await f.state(f.child)).transactions.length, 5);
  assert.equal((await f.state(f.child)).members[0].balanceCents, -2500);
  assert.equal((await f.list()).subscriptions[0].nextChargeDate, '2026-02-06');
  assert.equal(f.tick().processed, 0);
  await f.reopen();
  assert.equal((await f.state(f.child)).transactions.length, 5);
});

test('month-end and leap-day anchors recover after short months and non-leap years', async t => {
  const f = await fixture(t, '2024-01-31T12:00:00Z');
  const monthly = await f.create(f.input({ nextChargeDate: '2024-01-31' }));
  assert.equal(monthly.subscription.nextChargeDate, '2024-02-29');
  // A form round trip of the clamped next date must not replace the 31st anchor.
  assert.equal((await f.patch(monthly.subscription.id, { name: 'Music edited', amountCents: 500, interval: 'monthly',
    nextChargeDate: '2024-02-29', timeZone: 'UTC', idempotencyKey: randomUUID() })).httpStatus, 200);
  f.setNow('2024-02-29T12:00:00Z');
  f.tick();
  assert.equal((await f.list()).subscriptions[0].nextChargeDate, '2024-03-31');
  const yearly = await f.create(f.input({ name: 'Annual', interval: 'yearly', nextChargeDate: '2024-02-29' }));
  assert.equal(yearly.subscription.nextChargeDate, '2025-02-28');
  await f.patch(monthly.subscription.id, { paused: true });
  f.setNow('2027-02-28T12:00:00Z');
  f.tick();
  const annual = (await f.list()).subscriptions.find(row => row.id === yearly.subscription.id);
  assert.equal(annual.nextChargeDate, '2028-02-29');
  assert.deepEqual(f.store().db.prepare('SELECT period_date FROM subscription_charges WHERE subscription_id=? ORDER BY period_date').all(yearly.subscription.id).map(row => row.period_date),
    ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
});

test('local calendar midnight follows daylight saving transitions and never assumes a fixed UTC day', async t => {
  const f = await fixture(t, '2026-03-07T12:00:00Z');
  const created = await f.create(f.input({ interval: 'weekly', nextChargeDate: '2026-03-08', timeZone: 'America/New_York' }));
  assert.equal(created.httpStatus, 200);
  f.setNow('2026-03-08T04:59:59Z'); assert.equal(f.tick().processed, 0);
  f.setNow('2026-03-08T05:00:00Z'); assert.equal(f.tick().processed, 1);
  f.setNow('2026-03-15T03:59:59Z'); assert.equal(f.tick().processed, 0);
  f.setNow('2026-03-15T04:00:00Z'); assert.equal(f.tick().processed, 1);
  await f.patch(created.subscription.id, { paused: true });
  f.setNow('2026-10-31T12:00:00Z');
  const autumn = await f.create(f.input({ interval: 'weekly', nextChargeDate: '2026-11-01', timeZone: 'America/New_York' }));
  assert.equal(autumn.httpStatus, 200);
  f.setNow('2026-11-01T04:00:00Z'); assert.equal(f.tick().processed, 1);
  f.setNow('2026-11-08T04:59:59Z'); assert.equal(f.tick().processed, 0);
  f.setNow('2026-11-08T05:00:00Z'); assert.equal(f.tick().processed, 1);
});

test('pause and resume skip paused periods, explicit today resumes charge once, and editing never rewrites receipts', async t => {
  const f = await fixture(t);
  const created = await f.create(f.input({ nextChargeDate: '2026-01-01' }));
  const id = created.subscription.id;
  const originalTransaction = (await f.state(f.child)).transactions[0];
  assert.equal((await f.patch(id, { paused: true })).subscription.paused, true);
  f.setNow('2026-04-01T12:00:00Z');
  assert.equal(f.tick().processed, 0);
  const resumeKey = randomUUID();
  const resumed = await f.patch(id, { paused: false, idempotencyKey: resumeKey });
  assert.equal(resumed.subscription.nextChargeDate, '2026-05-01');
  assert.equal((await f.state(f.child)).transactions.length, 1);
  assert.equal((await f.patch(id, { paused: false, idempotencyKey: resumeKey })).replayed, true);
  assert.equal((await f.patch(id, { paused: true, idempotencyKey: resumeKey })).httpStatus, 409);
  const edit = { name: 'Music updated', amountCents: 900, nextChargeDate: '2026-04-01', idempotencyKey: randomUUID() };
  assert.equal((await f.patch(id, edit)).subscription.nextChargeDate, '2026-05-01');
  assert.equal((await f.patch(id, edit)).replayed, true);
  f.setNow('2026-04-02T12:00:00Z');
  assert.equal((await f.patch(id, edit)).replayed, true);
  const state = await f.state(f.child);
  assert.equal(state.transactions.length, 2);
  assert.deepEqual(state.transactions.find(row => row.id === originalTransaction.id), originalTransaction);
  assert.equal(state.transactions[0].amountCents, 900);
  assert.equal((await f.remove(id)).httpStatus, 200);
  assert.equal((await f.remove(id)).httpStatus, 200);
  f.setNow('2027-01-01T12:00:00Z');
  assert.equal(f.tick().processed, 0);
  assert.deepEqual((await f.list()).subscriptions, []);
  assert.equal((await f.state(f.child)).transactions.length, 2);
});

test('children manage only themselves and family sessions or tracker keys cannot cross subscription boundaries', async t => {
  const f = await fixture(t);
  const own = await f.create(f.input(), f.child);
  assert.equal(own.httpStatus, 200);
  assert.equal((await f.create(f.input({ childId: f.sibling.user.id }), f.child)).httpStatus, 403);
  assert.deepEqual((await f.list(f.sibling)).subscriptions, []);
  assert.equal((await f.patch(own.subscription.id, { paused: true }, f.sibling)).httpStatus, 404);
  assert.equal((await f.remove(own.subscription.id, f.sibling)).httpStatus, 404);
  assert.equal((await f.patch(own.subscription.id, { childId: f.sibling.user.id })).httpStatus, 400);
  const other = await f.request('POST', '/families', { familyName: 'Other', name: 'Other', username: 'parent', password: 'family-password-123' });
  assert.deepEqual((await f.list(other)).subscriptions, []);
  assert.equal((await f.patch(own.subscription.id, { paused: true }, other)).httpStatus, 404);
  assert.equal((await f.remove(own.subscription.id, other)).httpStatus, 404);
  assert.equal((await f.create(f.input(), other)).httpStatus, 404);
  const setup = await f.request('POST', '/fts/issuers', { name: 'Tracker', priceCents: 15 }, f.parent.token);
  const credential = 'fts_' + randomBytes(32).toString('base64url');
  await f.request('POST', '/fts/pair', { setupCode: setup.setupCode, credential });
  assert.equal((await f.request('GET', '/subscriptions', undefined, credential)).httpStatus, 401);
  assert.equal((await f.request('GET', '/subscriptions/sync', undefined, credential)).httpStatus, 401);
  assert.equal((await f.request('POST', '/subscriptions', f.input(), credential)).httpStatus, 401);
});

test('invalid schedules and subscription caps reject requests without creating ledger entries', async t => {
  const f = await fixture(t);
  for (const values of [{ amountCents: 0 }, { amountCents: 1.5 }, { amountCents: '500' }, { amountCents: 1_000_001 },
    { name: '' }, { interval: 'daily' }, { nextChargeDate: '2026-02-30' }, { nextChargeDate: '2025-12-31' },
    { nextChargeDate: '2026-1-02' }, { timeZone: 'Not/A_Zone' }, { timeZone: '+01:00' }, { idempotencyKey: 'short' }]) {
    assert.equal((await f.create(f.input(values))).httpStatus, 400);
  }
  for (let i = 0; i < 20; i++) assert.equal((await f.create(f.input({ name: `Subscription ${i}` }))).httpStatus, 200);
  assert.equal((await f.create()).httpStatus, 409);
  assert.equal((await f.state(f.child)).transactions.length, 0);
  assert.equal((await f.list()).subscriptions.length, 20);
});

test('a failed notification rolls back each charge and next date, and one failing subscription cannot starve others', async t => {
  const f = await fixture(t);
  const first = await f.create(f.input({ name: 'Failure' }));
  const second = await f.create(f.input({ name: 'Success', childId: f.sibling.user.id }));
  const store = f.store();
  store.db.exec(`CREATE TRIGGER fail_subscription_notice BEFORE INSERT ON notifications WHEN NEW.recipient_id='${f.child.user.id}' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;`);
  f.setNow('2026-01-02T12:00:00Z');
  const pass = f.tick();
  assert.equal(pass.failed, 1);
  assert.equal(pass.processed, 1);
  assert.equal((await f.list()).subscriptions.find(row => row.id === first.subscription.id).nextChargeDate, '2026-01-02');
  assert.equal((await f.state(f.child)).transactions.length, 0);
  assert.equal((await f.state(f.sibling)).transactions.length, 1);
  store.db.exec('DROP TRIGGER fail_subscription_notice');
  assert.equal(f.tick().processed, 1);
  assert.equal(f.tick().processed, 0);
  assert.equal((await f.state(f.child)).transactions.length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM subscription_charges').get().count, 2);
});

test('family deletion clears schedules, charge links, and mutation keys so restart cannot resume deductions', async t => {
  const f = await fixture(t);
  const created = await f.create(f.input({ nextChargeDate: '2026-01-01' }));
  await f.patch(created.subscription.id, { name: 'Renamed', idempotencyKey: randomUUID() });
  const store = f.store();
  assert.equal((await f.request('DELETE', '/family', { confirmation: 'DELETE-FAMILY', familyCode: f.parent.familyCode }, f.parent.token)).httpStatus, 200);
  for (const table of ['subscriptions', 'subscription_charges', 'subscription_mutations', 'transactions', 'notifications']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
  f.setNow('2027-01-01T12:00:00Z');
  assert.equal(f.tick().processed, 0);
  await f.reopen();
  assert.equal(f.tick().processed, 0);
  assert.equal((await f.state(f.parent)).httpStatus, 401);
});

test('the running server charges due subscriptions without an app request or a manual scheduler call', async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).httpStatus, 200);
  const store = f.store();
  f.setNow('2026-01-02T12:00:00Z');
  const deadline = Date.now() + 6500;
  while (store.db.prepare('SELECT COUNT(*) AS count FROM subscription_charges').get().count === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM subscription_charges').get().count, 1);
  assert.equal(store.balance(f.child.user.id), -500);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 3);
});

test('reminder sync exposes only committed charges with correct receipt links, preserves deleted history, and scopes every family member', async t => {
  const f = await fixture(t);
  const own = await f.create(f.input({ nextChargeDate: '2026-01-01' }));
  const otherChild = await f.create(f.input({ childId: f.sibling.user.id, nextChargeDate: '2026-01-01' }));
  const future = await f.create(f.input({ name: 'Not charged', nextChargeDate: '2026-01-02' }));
  const receipt = (await f.state(f.child)).transactions[0];
  await f.remove(own.subscription.id);
  const sync = who => f.request('GET', '/subscriptions/sync', undefined, who?.token);
  const childSync = await sync(f.child);
  assert.equal(childSync.httpStatus, 200);
  assert.deepEqual(childSync.subscriptions.map(row => row.id), [future.subscription.id]);
  assert.deepEqual(childSync.charges, [{ subscriptionId: own.subscription.id, periodDate: '2026-01-01',
    transactionId: receipt.id, childId: f.child.user.id, createdAt: receipt.createdAt }]);
  const siblingSync = await sync(f.sibling);
  assert.deepEqual(siblingSync.charges.map(row => row.subscriptionId), [otherChild.subscription.id]);
  assert.deepEqual(siblingSync.subscriptions.map(row => row.id), [otherChild.subscription.id]);
  for (const parent of [f.parent, f.parent2]) {
    const result = await sync(parent);
    assert.equal(result.charges.length, 2);
    assert.equal(result.subscriptions.length, 2);
    assert.ok(result.charges.every(row => row.subscriptionId !== future.subscription.id));
  }
  const another = await f.request('POST', '/families', { familyName: 'Other', name: 'Other', username: 'parent', password: 'family-password-123' });
  assert.deepEqual((await sync(another)).charges, []);
  assert.deepEqual((await sync(another)).subscriptions, []);
  assert.equal((await sync()).httpStatus, 401);
  // A past due date is not proof of a charge until its atomic period row exists.
  f.setNow('2026-01-03T12:00:00Z');
  assert.ok((await sync(f.child)).charges.every(row => row.subscriptionId !== future.subscription.id));
  f.tick();
  assert.equal((await sync(f.child)).charges.find(row => row.subscriptionId === future.subscription.id).periodDate, '2026-01-02');
  await f.reopen();
  const persisted = await sync(f.child);
  assert.equal(persisted.charges.length, 2);
  assert.ok(persisted.charges.some(row => row.transactionId === receipt.id));
  const health = await f.request('GET', '/health');
  assert.equal(health.capabilities.subscriptionReminders, true);
});

test('creation retry checks its original key before rejecting an aged date and returns 410 for a removed schedule', async t => {
  const f = await fixture(t);
  const payload = f.input({ nextChargeDate: '2026-01-01' });
  const created = await f.create(payload);
  f.setNow('2026-01-02T12:00:00Z');
  assert.equal((await f.create(payload)).replayed, true);
  assert.equal((await f.create({ ...payload, idempotencyKey: randomUUID() })).httpStatus, 400);
  await f.remove(created.subscription.id);
  assert.equal((await f.create(payload)).httpStatus, 410);
  assert.equal(f.store().db.prepare('SELECT COUNT(*) AS count FROM subscriptions').get().count, 1);
  assert.equal((await f.state(f.child)).transactions.length, 1);
});
