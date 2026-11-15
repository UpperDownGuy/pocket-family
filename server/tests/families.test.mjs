import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createFamilyServer } from '../index.mjs';
import { FamilyStore } from '../store.mjs';
import { resetFamilies, RESET_CONFIRMATION } from '../reset-families.mjs';

const randomCode = () => randomBytes(32).toString('base64url');
const password = 'family-password-123';
const signup = familyName => ({ familyName, name: 'Parent', username: 'parent', password });

async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pocket-families-')));
  const dbPath = join(directory, 'pocket.sqlite');
  let app = createFamilyServer({ dbPath, setupCode: 'legacy-setup', ...options });
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(method, path, body, token) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  }
  async function create(name) {
    const auth = await request('POST', '/families', signup(name));
    assert.equal(auth.status, 200);
    return auth;
  }
  async function child(parent, username = 'child') {
    assert.equal((await request('POST', '/members', { name: username, username, password, role: 'child' }, parent.token)).status, 200);
    const auth = await request('POST', '/login', { username, password, familyCode: parent.familyCode });
    assert.equal(auth.status, 200);
    return auth;
  }
  async function issuer(auth) {
    const result = await request('POST', '/fts/issuers', { name: 'File tracker', priceCents: 15 }, auth.token);
    assert.equal(result.status, 200);
    return result;
  }
  const store = auth => app.registry.authenticated(`Bearer ${auth.token}`).store;
  const state = auth => request('GET', '/state', undefined, auth.token);
  const credit = (auth, recipient, key = randomUUID()) => request('POST', '/transactions', { childId: recipient.user.id, kind: 'addition', amountCents: 500, merchant: 'Allowance', note: '', idempotencyKey: key }, auth.token);
  return { directory, dbPath, request, create, child, issuer, store, state, credit, get app() { return app; },
    async reopen() { await app.close(); app = createFamilyServer({ dbPath, setupCode: 'different-legacy-setup', ...options }); await listen(); },
    async reset() {
      await app.close();
      const result = resetFamilies({ dbPath, confirm: RESET_CONFIRMATION });
      app = createFamilyServer({ dbPath, setupCode: 'after-reset', ...options });
      await listen();
      return result;
    } };
}

test('public registration creates separate stable family codes and supports reused usernames without guessing a family', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/health')).setupRequired, true);
  f.app.registry.generateFamilyCode = () => '00000007';
  const first = await f.create('First family');
  assert.equal(first.familyCode, '00000007');
  assert.equal(first.user.role, 'parent');
  assert.equal((await f.request('POST', '/login', { username: 'parent', password })).familyCode, first.familyCode);
  let calls = 0;
  f.app.registry.generateFamilyCode = () => ++calls === 1 ? '00000007' : '00000008';
  const second = await f.create('Second family');
  assert.equal(calls, 2);
  assert.equal(second.familyCode, '00000008');
  assert.notEqual(first.user.id, second.user.id);
  const health = await f.request('GET', '/health');
  assert.equal(health.setupRequired, false);
  assert.deepEqual(health.capabilities.families, { multiple: true, registration: true, deletion: true });
  assert.equal(JSON.stringify(health).includes(first.familyCode), false);
  assert.equal((await f.request('POST', '/setup', { ...signup('Forbidden legacy'), setupCode: 'legacy-setup' })).status, 409);
  assert.equal((await f.request('POST', '/login', { username: 'parent', password })).status, 400);
  assert.equal((await f.request('POST', '/login', { username: 'parent', password, familyCode: '99999999' })).status, 401);
  for (const auth of [first, second]) {
    const signedIn = await f.request('POST', '/login', { username: 'parent', password, familyCode: auth.familyCode });
    assert.equal(signedIn.user.id, auth.user.id);
    assert.equal((await f.state(auth)).familyCode, auth.familyCode);
  }
  assert.equal(f.app.store.setupRequired, true);
  assert.equal(f.app.registry.list().length, 2);
  const databases = (await readdir(f.dbPath + '.families')).filter(name => name.endsWith('.sqlite'));
  assert.equal(databases.length, 2);
  await f.reopen();
  assert.equal((await f.state(first)).familyName, 'First family');
  assert.equal((await f.state(second)).familyName, 'Second family');
  assert.equal((await f.state(first)).familyCode, '00000007');
});

test('family databases isolate members, receipts, notices, trackers, reports, and redemption across all actor tokens', async t => {
  const f = await fixture(t);
  const a = await f.create('Alpha');
  const b = await f.create('Beta');
  const ac = await f.child(a);
  const bc = await f.child(b);
  const asibling = await f.child(a, 'sibling');
  const bsibling = await f.child(b, 'sibling');
  const regular = await f.credit(a, ac);
  assert.equal(regular.status, 200);
  assert.equal((await f.credit(b, ac)).status, 404);
  assert.equal((await f.credit(a, bc)).status, 404);
  const ia = await f.issuer(ac);
  const ib = await f.issuer(bc);
  const tokenA = 'fts_' + randomCode();
  const tokenB = 'fts_' + randomCode();
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: ia.setupCode, credential: tokenA })).status, 200);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: ib.setupCode, credential: tokenA })).status, 409);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: ib.setupCode, credential: tokenB })).status, 200);
  const codeA = randomCode();
  const codeB = randomCode();
  const reports = [{ reportId: 'same-report-id-in-independent-families', movieCount: 1, priceCents: 15,
    items: [{ path: 'family-private.txt', status: 'modified' }] }];
  assert.equal((await f.request('POST', '/fts/vouchers', { code: codeA, reports }, tokenA)).status, 'issued');
  assert.equal((await f.request('POST', '/credits/preview', { code: codeA }, b.token)).status, 404);
  assert.equal((await f.request('POST', '/credits/redeem', { code: codeA, childId: bc.user.id }, b.token)).status, 404);
  assert.equal((await f.request('POST', '/fts/vouchers/status', { code: codeA }, tokenB)).status, 404);
  assert.equal((await f.request('POST', '/fts/vouchers', { code: codeB, reports }, tokenB)).status, 'issued');
  assert.equal((await f.request('POST', '/credits/redeem', { code: codeA }, ac.token)).status, 'redeemed');
  assert.equal((await f.request('POST', '/credits/redeem', { code: codeB }, bc.token)).status, 'redeemed');
  const ast = await f.state(a);
  const bst = await f.state(b);
  assert.equal(ast.transactions.length, 2);
  assert.equal(bst.transactions.length, 1);
  assert.equal(ast.notifications.length, 2);
  assert.equal(bst.notifications.length, 1);
  assert.ok(ast.members.every(member => !bst.members.some(other => other.id === member.id)));
  assert.deepEqual((await f.state(asibling)).transactions, []);
  assert.deepEqual((await f.state(bsibling)).notifications, []);
  const receipt = ast.transactions.find(item => item.merchant === 'File edits');
  assert.equal((await f.request('GET', `/transactions/${receipt.id}/items`, undefined, ac.token)).items[0].path, 'family-private.txt');
  for (const user of [b, bc, asibling]) assert.equal((await f.request('GET', `/transactions/${receipt.id}/items`, undefined, user.token)).status, 404);
  assert.equal((await f.request('GET', `/transactions/${receipt.id}/items`, undefined, tokenA)).status, 401);
  assert.equal((await f.request('POST', `/fts/issuers/${ia.issuer.id}/revoke`, {}, b.token)).status, 404);
  assert.deepEqual((await f.request('GET', '/fts/issuers', undefined, b.token)).issuers.map(item => item.id), [ib.issuer.id]);
  assert.ok(ast.computerNotifications.every(note => note.issuerId === ia.issuer.id));
  assert.ok(bst.computerNotifications.every(note => note.issuerId === ib.issuer.id));
  await f.request('POST', '/notifications/read', { ids: [...ast.notifications, ...ast.computerNotifications].map(note => note.id) }, b.token);
  assert.ok((await f.state(a)).notifications.every(note => note.readAt === null));
  assert.ok((await f.state(a)).computerNotifications.every(note => note.readAt === null));
  await f.request('POST', '/logout', {}, b.token);
  assert.equal((await f.state(a)).status, 200);
  assert.equal((await f.state(b)).status, 401);
  await f.reopen();
  assert.equal((await f.request('GET', '/fts/connection', undefined, tokenA)).issuer.id, ia.issuer.id);
  assert.equal((await f.request('POST', '/fts/vouchers/status', { code: codeB }, tokenB)).status, 'redeemed');
});

test('global eight-digit pairing collisions retry without altering existing deterministic store fixtures', async t => {
  const f = await fixture(t);
  const a = await f.create('Alpha');
  const b = await f.create('Beta');
  f.store(a).generateFTSSetupCode = () => '00000011';
  const first = await f.issuer(a);
  assert.equal(first.setupCode, '00000011');
  let calls = 0;
  f.store(b).generateFTSSetupCode = () => ++calls === 1 ? '00000011' : '00000012';
  const second = await f.issuer(b);
  assert.equal(second.setupCode, '00000012');
  assert.equal(calls, 2);
  f.store(b).generateFTSSetupCode = () => '00000011';
  assert.equal((await f.request('POST', '/fts/issuers', { name: 'Collision', priceCents: 15 }, b.token)).status, 503);
  assert.equal(f.store(b).db.prepare('SELECT COUNT(*) AS count FROM fts_issuers').get().count, 1);
});

test('an existing single-family database upgrades without losing sessions or old FTS credentials', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pocket-upgrade-')));
  const dbPath = join(directory, 'old.sqlite');
  const old = new FamilyStore(dbPath, { setupCode: 'original' });
  const auth = old.setup({ ...signup('Original family'), setupCode: 'original' });
  const child = old.addMember({ name: 'Child', username: 'child', password, role: 'child' });
  const actor = old.authenticate(`Bearer ${auth.token}`);
  old.createTransaction(actor, { childId: child.id, kind: 'addition', amountCents: 777, merchant: 'Before upgrade', note: '', idempotencyKey: randomUUID() });
  const credential = 'fts_' + randomCode();
  const issuerId = randomUUID();
  old.db.prepare('INSERT INTO fts_issuers VALUES (?,?,?,?,?,?,NULL)').run(issuerId, 'Legacy computer', createHash('sha256').update(credential).digest('hex'), 15, new Date().toISOString(), auth.user.id);
  old.close();
  let app = createFamilyServer({ dbPath, setupCode: 'changed' });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const family = app.registry.authenticated(`Bearer ${auth.token}`);
  assert.equal(family.store, app.store);
  assert.equal(family.store.state(family.actor).transactions[0].amountCents, 777);
  assert.match(family.family.family_code, /^[0-9]{8}$/);
  assert.equal(app.registry.authenticated(`Bearer ${credential}`, true).actor.id, issuerId);
  const additional = app.registry.create(signup('New family'));
  assert.notEqual(additional.familyCode, family.family.family_code);
  assert.equal(app.registry.login({ username: 'parent', password }).user.id, auth.user.id);
  const stableCode = family.family.family_code;
  await app.close();
  app = createFamilyServer({ dbPath });
  assert.equal(app.registry.authenticated(`Bearer ${auth.token}`).family.family_code, stableCode);
  assert.equal(app.registry.authenticated(`Bearer ${credential}`, true).actor.id, issuerId);
});

test('moving a device between families cancels old pending deliveries before the new registration', async t => {
  const sent = [];
  const f = await fixture(t, { pushProvider: { send: async token => { sent.push(token); return { ok: true }; } } });
  const a = await f.create('Alpha');
  const b = await f.create('Beta');
  const ac = await f.child(a);
  const bc = await f.child(b);
  const device = 'a'.repeat(64);
  const storeA = f.store(a);
  const storeB = f.store(b);
  await f.request('POST', '/devices', { token: device }, ac.token);
  storeA.draining = true;
  await f.credit(a, ac);
  assert.equal(storeA.db.prepare("SELECT status FROM outbox WHERE device_token=?").get(device).status, 'pending');
  assert.equal((await f.request('POST', '/devices', { token: device }, bc.token)).status, 200);
  assert.equal(storeA.db.prepare('SELECT token FROM devices WHERE token=?').get(device), undefined);
  assert.equal(storeA.db.prepare('SELECT status FROM outbox WHERE device_token=?').get(device).status, 'cancelled');
  assert.equal(storeB.db.prepare('SELECT user_id FROM devices WHERE token=?').get(device).user_id, bc.user.id);
  await f.request('DELETE', '/devices', { token: device }, ac.token);
  assert.equal(storeB.db.prepare('SELECT user_id FROM devices WHERE token=?').get(device).user_id, bc.user.id);
  storeA.draining = false;
  await f.app.registry.drainOutbox();
  assert.deepEqual(sent, []);
  await f.credit(b, bc);
  while (storeB.draining) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(sent, [device]);
});

test('public family signup is rate limited and invalid inputs do not allocate a family database', async t => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await f.request('POST', '/families', { ...signup('Invalid'), password: 'short' })).status, 400);
  assert.equal((await f.request('POST', '/families', signup('Blocked'))).status, 429);
  assert.deepEqual(f.app.registry.list(), []);
  assert.deepEqual((await readdir(f.directory)).filter(name => name.endsWith('.families')), []);
  assert.equal((await f.request('GET', '/health')).setupRequired, true);
});

test('in-memory servers keep independent families without filesystem paths', async t => {
  const app = createFamilyServer({ dbPath: ':memory:' });
  t.after(() => app.close());
  const a = app.registry.create(signup('Memory A'));
  const b = app.registry.create(signup('Memory B'));
  assert.notEqual(a.familyCode, b.familyCode);
  assert.equal(app.registry.authenticated(`Bearer ${a.token}`).store.familyName, 'Memory A');
  assert.equal(app.registry.authenticated(`Bearer ${b.token}`).store.familyName, 'Memory B');
  assert.equal(app.registry.setupRequired, false);
});

test('ambiguous tokens and database lookup failures fail closed instead of selecting another family', async t => {
  const f = await fixture(t);
  const a = await f.create('Alpha');
  const b = await f.create('Beta');
  const storeB = f.store(b);
  const tokenHash = createHash('sha256').update(a.token).digest('hex');
  storeB.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(tokenHash, b.user.id, Date.now() + 60000);
  assert.equal((await f.state(a)).status, 401);
  storeB.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash);
  assert.equal((await f.state(a)).user.id, a.user.id);
  const original = storeB.db.prepare;
  try {
    storeB.db.prepare = function (sql) {
      if (sql === 'SELECT 1 FROM sessions WHERE hash=?') throw new Error('Fixture database unavailable');
      return original.call(this, sql);
    };
    const response = await f.state(a);
    assert.equal(response.status, 500);
    assert.equal(Object.hasOwn(response, 'user'), false);
  } finally { storeB.db.prepare = original; }
  assert.equal((await f.state(a)).user.id, a.user.id);
});

test('offline reset of real API-created families invalidates every old session and computer, then permits a fresh family', async t => {
  const f = await fixture(t);
  const originals = [];
  for (const name of ['Reset Alpha', 'Reset Beta']) {
    const parent = await f.create(name);
    const child = await f.child(parent);
    const issuer = await f.issuer(child);
    const credential = 'fts_' + randomCode();
    assert.equal((await f.request('POST', '/fts/pair', { setupCode: issuer.setupCode, credential })).status, 200);
    const code = randomCode();
    assert.equal((await f.request('POST', '/fts/vouchers', { code,
      reports: [{ reportId: 'reset-report', movieCount: 2, priceCents: 15, items: [{ path: 'before-reset.txt', status: 'modified' }] }] }, credential)).status, 'issued');
    if (name === 'Reset Alpha') assert.equal((await f.request('POST', '/credits/redeem', { code }, child.token)).status, 'redeemed');
    originals.push({ parent, child, issuer, credential, code });
  }
  assert.equal((await f.request('GET', '/health')).setupRequired, false);
  const result = await f.reset();
  assert.equal(result.status, 'reset');
  assert.ok(result.backupPath);
  assert.equal((await f.request('GET', '/health')).setupRequired, true);
  assert.deepEqual(f.app.registry.list(), []);
  for (const original of originals) {
    for (const who of [original.parent, original.child]) assert.equal((await f.state(who)).status, 401);
    assert.equal((await f.request('GET', '/fts/connection', undefined, original.credential)).status, 401);
    assert.equal((await f.request('POST', '/fts/vouchers/status', { code: original.code }, original.credential)).status, 401);
    assert.equal((await f.request('POST', '/fts/pair', { setupCode: original.issuer.setupCode, credential: original.credential })).status, 400);
    assert.equal((await f.request('POST', '/login', { username: 'parent', password, familyCode: original.parent.familyCode })).status, 401);
  }
  const fresh = await f.create('Fresh family');
  const state = await f.state(fresh);
  assert.equal(state.familyName, 'Fresh family');
  assert.deepEqual(state.transactions, []);
  assert.deepEqual(state.notifications, []);
  assert.deepEqual(state.computerNotifications, []);
  assert.equal(state.members.length, 1);
  assert.equal(state.members[0].balanceCents, 0);
  assert.equal((await f.request('GET', '/health')).setupRequired, false);
  assert.equal((await f.request('POST', '/credits/preview', { code: originals[0].code }, fresh.token)).status, 404);
});

test('only a current-family parent with matching confirmation can delete its data; other families and files survive restart', async t => {
  const f = await fixture(t);
  const a = await f.create('Delete Alpha');
  const b = await f.create('Keep Beta');
  const ac = await f.child(a);
  const bc = await f.child(b);
  await f.credit(a, ac);
  await f.credit(b, bc);
  const issuer = await f.issuer(ac);
  const credential = 'fts_' + randomCode();
  await f.request('POST', '/fts/pair', { setupCode: issuer.setupCode, credential });
  const code = randomCode();
  await f.request('POST', '/fts/vouchers', { code, reports: [{ reportId: 'to-delete', movieCount: 1, priceCents: 15,
    items: [{ path: 'private.txt', status: 'modified' }] }] }, credential);
  await f.request('POST', '/credits/redeem', { code }, ac.token);
  const beforeB = await f.state(b);
  const store = f.store(a);
  const family = f.app.registry.authenticated(`Bearer ${a.token}`).family;
  const confirmation = { confirmation: 'DELETE-FAMILY', familyCode: a.familyCode };
  assert.equal((await f.request('DELETE', '/family', confirmation)).status, 401);
  assert.equal((await f.request('DELETE', '/family', confirmation, ac.token)).status, 403);
  for (const bad of [{}, { familyCode: a.familyCode }, { ...confirmation, confirmation: 'delete-family' }]) {
    assert.equal((await f.request('DELETE', '/family', bad, a.token)).status, 400);
  }
  for (const familyCode of [undefined, '', 12345678, b.familyCode]) {
    assert.equal((await f.request('DELETE', '/family', { ...confirmation, familyCode }, a.token)).status, 409);
  }
  const result = await f.request('DELETE', '/family', { ...confirmation, familyId: f.app.registry.authenticated(`Bearer ${b.token}`).family.id }, a.token);
  assert.deepEqual(result, { status: 200, ok: true });
  for (const table of ['members', 'sessions', 'transactions', 'notifications', 'devices', 'outbox', 'settings',
    'fts_issuers', 'fts_pairings', 'fts_vouchers', 'fts_reports', 'fts_report_items', 'fts_events', 'fts_event_notifications']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table);
  }
  assert.ok(store.deletedAt);
  assert.ok(f.app.registry.db.prepare('SELECT cleared_at FROM deleted_families WHERE family_id=?').get(family.id).cleared_at);
  assert.equal(f.app.registry.db.prepare('SELECT id FROM families WHERE id=?').get(family.id), undefined);
  assert.ok((await readdir(f.dbPath + '.families')).includes(family.id + '.sqlite'));
  assert.deepEqual(await f.state(b), beforeB);
  for (const who of [a, ac]) assert.equal((await f.state(who)).status, 401);
  assert.equal((await f.request('GET', '/fts/connection', undefined, credential)).status, 401);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: issuer.setupCode, credential })).status, 400);
  await f.reopen();
  assert.equal((await f.state(a)).status, 401);
  assert.deepEqual(await f.state(b), beforeB);
  assert.equal(f.app.registry.list().length, 1);
  assert.equal((await f.request('GET', '/health')).setupRequired, false);
});

test('deleting the legacy family never resurrects it, and an empty server can create another family', async t => {
  const f = await fixture(t);
  const legacy = await f.request('POST', '/setup', { ...signup('Legacy'), setupCode: 'legacy-setup' });
  assert.equal(legacy.status, 200);
  const child = await f.child(legacy);
  await f.credit(legacy, child);
  assert.equal((await f.request('DELETE', '/family', { confirmation: 'DELETE-FAMILY', familyCode: legacy.familyCode }, legacy.token)).status, 200);
  assert.equal(f.app.store.setupRequired, true);
  assert.ok(f.app.store.deletedAt);
  await f.reopen();
  assert.deepEqual(f.app.registry.list(), []);
  assert.equal((await f.request('GET', '/health')).setupRequired, true);
  assert.equal((await f.state(legacy)).status, 401);
  assert.equal((await f.request('POST', '/login', { username: 'parent', password, familyCode: legacy.familyCode })).status, 401);
  const fresh = await f.request('POST', '/setup', { ...signup('Fresh after deletion'), setupCode: 'different-legacy-setup' });
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.familyCode, legacy.familyCode);
  assert.deepEqual((await f.state(fresh)).transactions, []);
  assert.notEqual(f.app.registry.authenticated(`Bearer ${fresh.token}`).store, f.app.store);
  await f.reopen();
  assert.equal((await f.state(fresh)).familyName, 'Fresh after deletion');
  assert.equal((await f.state(legacy)).status, 401);
});

test('requests with bodies arriving after deletion reauthenticate and cannot recreate members or FTS data', async t => {
  const f = await fixture(t);
  const parent = await f.create('Delayed');
  const issuer = await f.issuer(parent);
  const credential = 'fts_' + randomCode();
  await f.request('POST', '/fts/pair', { setupCode: issuer.setupCode, credential });
  const store = f.store(parent);
  async function delayed(path, input, token) {
    const payload = Buffer.from(JSON.stringify(input));
    let sawAuthentication;
    const authenticated = new Promise(resolve => { sawAuthentication = resolve; });
    const original = f.app.registry.authenticated;
    f.app.registry.authenticated = function (header, ...args) {
      const result = original.call(this, header, ...args);
      if (header === `Bearer ${token}`) sawAuthentication();
      return result;
    };
    let pending;
    const response = new Promise((resolve, reject) => {
      pending = httpRequest({ hostname: '127.0.0.1', port: f.app.server.address().port, path, method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length } }, result => {
        const chunks = [];
        result.on('data', chunk => chunks.push(chunk));
        result.on('end', () => resolve({ status: result.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      pending.on('error', reject);
      pending.setTimeout(3000, () => pending.destroy(new Error('Delayed request timed out')));
      pending.write(payload.subarray(0, 1));
    });
    await authenticated;
    f.app.registry.authenticated = original;
    return { finish: () => pending.end(payload.subarray(1)), response };
  }
  const memberRequest = await delayed('/members', { name: 'Late child', username: 'latechild', password, role: 'child' }, parent.token);
  const voucherRequest = await delayed('/fts/vouchers', { code: randomCode(), reports: [{ reportId: 'late', movieCount: 1, priceCents: 15 }] }, credential);
  assert.equal((await f.request('DELETE', '/family', { confirmation: 'DELETE-FAMILY', familyCode: parent.familyCode }, parent.token)).status, 200);
  memberRequest.finish(); voucherRequest.finish();
  assert.equal((await memberRequest.response).status, 401);
  assert.equal((await voucherRequest.response).status, 401);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM members').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM fts_vouchers').get().count, 0);
});

test('deletion waits for one in-flight push and suppresses the rest of its captured batch', async t => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const sent = [];
  const f = await fixture(t, { pushProvider: { send: async token => { sent.push(token); started(); await held; return { ok: true }; } } });
  const parent = await f.create('Push deletion');
  const child = await f.child(parent);
  const store = f.store(parent);
  await f.request('POST', '/devices', { token: 'a'.repeat(64) }, parent.token);
  await f.request('POST', '/devices', { token: 'b'.repeat(64) }, child.token);
  await f.credit(parent, child);
  await ready;
  const deletion = f.request('DELETE', '/family', { confirmation: 'DELETE-FAMILY', familyCode: parent.familyCode }, parent.token);
  while (!store.deleting) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.state(parent)).status, 401);
  release();
  assert.equal((await deletion).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(store.draining, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 0);
  await f.app.registry.drainOutbox();
  assert.equal(sent.length, 1);
});

test('startup completes a durable deletion interrupted before clear and reconciles an old registry with a cleared family snapshot', async t => {
  const f = await fixture(t);
  const pending = await f.create('Interrupted');
  const overlap = await f.create('Backup overlap');
  const keep = await f.create('Keep');
  const pendingFamily = f.app.registry.authenticated(`Bearer ${pending.token}`).family;
  const overlapFamily = f.app.registry.authenticated(`Bearer ${overlap.token}`).family;
  const pendingStore = f.store(pending);
  const originalClear = pendingStore.clearFamily;
  pendingStore.clearFamily = () => { throw new Error('Fixture interrupted clear'); };
  assert.equal((await f.request('DELETE', '/family', { confirmation: 'DELETE-FAMILY', familyCode: pending.familyCode }, pending.token)).status, 500);
  pendingStore.clearFamily = originalClear;
  assert.equal((await f.state(pending)).status, 401);
  assert.equal(pendingStore.db.prepare('SELECT COUNT(*) AS count FROM members').get().count, 1);
  // This is the exact state a registry-first backup can restore: an active
  // registry row from before deletion, plus the later atomic cleared DB.
  f.store(overlap).clearFamily(new Date().toISOString());
  assert.equal(f.app.registry.db.prepare('SELECT family_id FROM deleted_families WHERE family_id=?').get(overlapFamily.id), undefined);
  await f.reopen();
  assert.deepEqual(f.app.registry.list().map(row => row.family_code), [keep.familyCode]);
  for (const auth of [pending, overlap]) assert.equal((await f.state(auth)).status, 401);
  for (const family of [pendingFamily, overlapFamily]) {
    const tombstone = f.app.registry.db.prepare('SELECT * FROM deleted_families WHERE family_id=?').get(family.id);
    assert.ok(tombstone.cleared_at);
    const database = new DatabaseSync(family.db_path, { readOnly: true });
    try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM members').get().count, 0); }
    finally { database.close(); }
  }
  assert.equal((await f.state(keep)).familyName, 'Keep');
});
