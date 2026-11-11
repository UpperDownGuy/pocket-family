import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFamilyServer } from '../index.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pocket-server-'));
  const dbPath = join(dir, 'family.sqlite');
  let app = createFamilyServer({ dbPath, setupCode: 'local-test-setup-code', ...options });
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  async function request(method, path, body, token) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, ...(await response.json()) };
  }
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const parent = await request('POST', '/setup', { familyName: 'Test Family', name: 'Parent One', username: 'parent1', password: 'parent-pass-123', setupCode: 'local-test-setup-code' });
  assert.equal(parent.status, 200);
  async function member(name, username, role) {
    const result = await request('POST', '/members', { name, username, role, password: 'member-pass-123' }, parent.token);
    assert.equal(result.status, 200);
    const login = await request('POST', '/login', { username, password: 'member-pass-123' });
    assert.equal(login.status, 200);
    return login;
  }
  const parent2 = await member('Parent Two', 'parent2', 'parent');
  const child1 = await member('Avery', 'avery', 'child');
  const child2 = await member('Jordan', 'jordan', 'child');
  const state = async who => await request('GET', '/state', undefined, who.token);
  const transaction = async (who, child, amountCents, kind = 'addition', key = crypto.randomUUID()) => await request('POST', '/transactions', {
    childId: child.user.id, kind, amountCents, merchant: kind === 'addition' ? 'Allowance' : 'Bookshop', note: '', idempotencyKey: key,
  }, who.token);
  return { request, parent, parent2, child1, child2, state, transaction, get app() { return app; },
    async reopen() { await app.close(); app = createFamilyServer({ dbPath, setupCode: 'different-code', ...options }); await listen(); } };
}

test('parents and affected child receive additions and purchases; siblings cannot read or modify them', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/state')).status, 401);
  const addition = await f.transaction(f.parent, f.child1, 2500);
  assert.equal(addition.status, 200);
  const purchase = await f.transaction(f.child1, f.child1, 700, 'purchase');
  assert.equal(purchase.status, 200);
  for (const recipient of [f.parent, f.parent2, f.child1]) {
    const state = await f.state(recipient);
    assert.equal(state.notifications.length, 2);
    assert.equal(state.transactions.length, 2);
    assert.equal(state.members.find(member => member.id === f.child1.user.id).balanceCents, 1800);
    assert.equal(Object.hasOwn(state.user, 'password_hash'), false);
  }
  const sibling = await f.state(f.child2);
  assert.equal(sibling.notifications.length, 0);
  assert.equal(sibling.transactions.length, 0);
  assert.equal(sibling.members.length, 1);
  assert.equal(sibling.members[0].id, f.child2.user.id);
  assert.equal((await f.transaction(f.child2, f.child1, 100, 'purchase')).status, 403);
  assert.equal((await f.transaction(f.child1, f.child1, 100, 'addition')).status, 403);
  assert.equal((await f.request('POST', '/members', { name: 'Intruder', username: 'intruder', password: 'pass-12345', role: 'parent' }, f.child1.token)).status, 403);
  const parentState = await f.state(f.parent);
  const otherAlert = parentState.notifications[0].id;
  assert.equal((await f.request('POST', '/notifications/read', { ids: [otherAlert] }, f.child2.token)).status, 200);
  assert.equal((await f.state(f.parent)).notifications[0].readAt, null);
  const ownAlert = (await f.state(f.child1)).notifications[0].id;
  await f.request('POST', '/notifications/read', { ids: [ownAlert] }, f.child1.token);
  assert.ok((await f.state(f.child1)).notifications[0].readAt);
  assert.equal((await f.state(f.parent)).notifications[0].readAt, null);
});

test('integer money, idempotent retries and concurrent purchases preserve a ledger that can go negative', async t => {
  const f = await fixture(t);
  const key = 'unique-allowance-request';
  const first = await f.transaction(f.parent, f.child1, 1000, 'addition', key);
  const replay = await f.transaction(f.parent, f.child1, 1000, 'addition', key);
  assert.equal(replay.transaction.id, first.transaction.id);
  assert.equal(replay.replayed, true);
  assert.equal((await f.transaction(f.parent, f.child1, 1001, 'addition', key)).status, 409);
  assert.equal((await f.state(f.parent)).notifications.length, 1);
  for (const amount of [0, -1, 1.2, '10', 1_000_001, Number.MAX_SAFE_INTEGER]) assert.equal((await f.transaction(f.parent, f.child1, amount)).status, 400);
  assert.equal((await f.transaction(f.child1, f.child1, 1001, 'purchase')).status, 200);
  assert.equal((await f.state(f.child1)).members[0].balanceCents, -1);
  const attempts = await Promise.all([f.transaction(f.child1, f.child1, 600, 'purchase'), f.transaction(f.child1, f.child1, 600, 'purchase')]);
  assert.deepEqual(attempts.map(attempt => attempt.status), [200, 200]);
  assert.notEqual(attempts[0].transaction.id, attempts[1].transaction.id);
  const state = await f.state(f.child1);
  assert.equal(state.members[0].balanceCents, -1201);
  assert.equal(state.transactions.length, 4);
  assert.equal(state.notifications.length, 4);
});

test('notification creation and ledger changes are one database transaction', async t => {
  const f = await fixture(t);
  f.app.store.db.exec("CREATE TRIGGER reject_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.equal((await f.transaction(f.parent, f.child1, 400)).status, 500);
  const state = await f.state(f.parent);
  assert.equal(state.transactions.length, 0);
  assert.equal(state.notifications.length, 0);
  assert.equal(state.members.find(member => member.id === f.child1.user.id).balanceCents, 0);
  f.app.store.db.exec('DROP TRIGGER reject_notification');
  assert.equal((await f.transaction(f.parent, f.child1, 400)).status, 200);
});

test('accounts, sessions, ledger, inbox and read state survive a restart', async t => {
  const f = await fixture(t);
  await f.transaction(f.parent2, f.child2, 4523);
  const before = await f.state(f.child2);
  await f.request('POST', '/notifications/read', { ids: [before.notifications[0].id] }, f.child2.token);
  await f.reopen();
  const health = await f.request('GET', '/health');
  assert.equal(health.setupRequired, false);
  const after = await f.state(f.child2);
  assert.equal(after.members[0].balanceCents, 4523);
  assert.ok(after.notifications[0].readAt);
  assert.equal(after.transactions[0].id, before.transactions[0].id);
  assert.equal((await f.request('POST', '/setup', {}, undefined)).status, 409);
  assert.equal((await f.request('POST', '/logout', undefined, f.child2.token)).status, 200);
  assert.equal((await f.state(f.child2)).status, 401);
});

test('browser capture requires the child, a valid USD receipt and an order reference; navigation cannot double-charge', async t => {
  const f = await fixture(t);
  await f.transaction(f.parent, f.child1, 5000);
  const receipt = { merchant: 'Bookshop', note: 'Paperback', amountCents: 1200, orderReference: 'ORDER-123', url: 'https://shop.example/confirmation?session=private', currency: 'USD' };
  const capture = (input, account = f.child1) => f.request('POST', '/browser/purchase', input, account.token);
  assert.equal((await capture(receipt, f.parent)).status, 403);
  const first = await capture(receipt);
  assert.equal(first.status, 200);
  const reload = await capture({ ...receipt, url: 'https://shop.example/orders/ORDER-123' });
  assert.equal(reload.transaction.id, first.transaction.id);
  assert.equal((await capture({ ...receipt, amountCents: 1300 })).status, 409);
  for (const change of [{ currency: 'CAD' }, { url: 'http://shop.example/thanks' }, { url: 'javascript:alert(1)' }, { url: 'https://name:password@shop.example/' }, { orderReference: '' }, { orderReference: '<script>' }, { merchant: '' }, { amountCents: 12.5 }]) {
    assert.equal((await capture({ ...receipt, ...change })).status, 400);
  }
  const state = await f.state(f.child1);
  assert.equal(state.members[0].balanceCents, 3800);
  assert.equal(state.notifications.length, 2);
  assert.equal(state.transactions.length, 2);
  assert.equal((await f.state(f.child2)).notifications.length, 0);
  assert.equal(JSON.stringify(state).includes('session=private'), false);
});

test('a completed browser purchase without an opening balance is recorded and alerts only its child and parents', async t => {
  const f = await fixture(t);
  const receipt = { merchant: 'Bookshop', note: 'Online purchase', amountCents: 1299, orderReference: 'PAID-123', url: 'https://shop.example', currency: 'USD' };
  const result = await f.request('POST', '/browser/purchase', receipt, f.child2.token);
  assert.equal(result.status, 200);
  assert.equal(result.replayed, false);
  for (const recipient of [f.parent, f.parent2, f.child2]) {
    const state = await f.state(recipient);
    assert.equal(state.members.find(member => member.id === f.child2.user.id).balanceCents, -1299);
    assert.equal(state.transactions.length, 1);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.notifications[0].transactionId, result.transaction.id);
  }
  const sibling = await f.state(f.child1);
  assert.equal(sibling.notifications.length, 0);
  assert.equal(sibling.transactions.length, 0);
  const replay = await f.request('POST', '/browser/purchase', receipt, f.child2.token);
  assert.equal(replay.transaction.id, result.transaction.id);
  assert.equal((await f.state(f.child2)).members[0].balanceCents, -1299);
  assert.equal((await f.state(f.parent)).notifications.length, 1);
});

test('sandbox push outbox selects only recipient devices and cancels obsolete account bindings', async t => {
  const sent = [];
  const f = await fixture(t, { pushProvider: { send: async token => { sent.push(token); return { ok: true }; } } });
  const tokens = ['a', 'b', 'c', 'd'].map(character => character.repeat(64));
  for (const [index, who] of [f.parent, f.parent2, f.child1, f.child2].entries()) {
    assert.equal((await f.request('POST', '/devices', { token: tokens[index] }, who.token)).status, 200);
  }
  await f.transaction(f.parent, f.child1, 1000);
  while (f.app.store.draining) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(sent.sort(), tokens.slice(0, 3).sort());
  assert.equal((await f.request('POST', '/logout', undefined, f.child1.token)).status, 200);
  sent.length = 0;
  await f.transaction(f.parent, f.child1, 1000);
  while (f.app.store.draining) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(sent.sort(), tokens.slice(0, 2).sort());
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='delivered'").get().count, 5);
});

test('login failures are rate limited, bearer sessions expire, and browser origins are rejected', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) assert.equal((await f.request('POST', '/login', { username: 'unknown', password: 'wrong-pass-123' })).status, 401);
  assert.equal((await f.request('POST', '/login', { username: 'unknown', password: 'wrong-pass-123' })).status, 429);
  f.app.store.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(f.child1.user.id);
  assert.equal((await f.state(f.child1)).status, 401);
  const response = await fetch(`http://127.0.0.1:${f.app.server.address().port}/health`, { headers: { Origin: 'https://example.com' } });
  assert.equal(response.status, 403);
});

test('account switching cancels old pending pushes; logout only unregisters its own session devices', async t => {
  const sent = [];
  const f = await fixture(t, { pushProvider: { send: async token => { sent.push(token); return { ok: true }; } } });
  const sharedPhone = 'e'.repeat(64);
  const secondPhone = 'f'.repeat(64);
  await f.request('POST', '/devices', { token: sharedPhone }, f.child1.token);
  const secondSession = await f.request('POST', '/login', { username: 'avery', password: 'member-pass-123' });
  await f.request('POST', '/devices', { token: secondPhone }, secondSession.token);
  f.app.store.draining = true;
  await f.transaction(f.parent, f.child1, 500);
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status='pending'").get().count, 2);
  await f.request('POST', '/devices', { token: sharedPhone }, f.child2.token);
  assert.equal(f.app.store.db.prepare("SELECT status FROM outbox WHERE device_token=?").get(sharedPhone).status, 'cancelled');
  await f.request('POST', '/logout', undefined, f.child1.token);
  assert.equal(f.app.store.db.prepare('SELECT user_id FROM devices WHERE token=?').get(sharedPhone).user_id, f.child2.user.id);
  assert.equal(f.app.store.db.prepare('SELECT user_id FROM devices WHERE token=?').get(secondPhone).user_id, f.child1.user.id);
  f.app.store.draining = false;
  await f.app.store.drainOutbox();
  assert.deepEqual(sent, [secondPhone]);
  assert.equal((await f.state(f.child2)).notifications.length, 0);
  assert.equal((await f.state(secondSession)).notifications.length, 1);
});

test('transient push errors retry durably without creating duplicate ledger or inbox entries', async t => {
  let sends = 0;
  const f = await fixture(t, { pushProvider: { send: async () => ++sends === 1 ? { ok: false, retry: true, reason: 'Temporary error' } : { ok: true } } });
  await f.request('POST', '/devices', { token: '9'.repeat(64) }, f.child1.token);
  await f.transaction(f.parent, f.child1, 500);
  while (f.app.store.draining) await new Promise(resolve => setTimeout(resolve, 5));
  const pending = f.app.store.db.prepare('SELECT * FROM outbox').get();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attempts, 1);
  assert.equal(pending.last_error, 'Temporary error');
  f.app.store.db.prepare('UPDATE outbox SET next_attempt=0').run();
  await f.reopen();
  await f.app.store.drainOutbox();
  assert.equal(f.app.store.db.prepare('SELECT status FROM outbox').get().status, 'delivered');
  assert.equal((await f.state(f.child1)).transactions.length, 1);
  assert.equal((await f.state(f.child1)).notifications.length, 1);
});
