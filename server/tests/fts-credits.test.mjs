import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFamilyServer } from '../index.mjs';

const code = () => randomBytes(32).toString('base64url');
const reports = (id = 'report-one', count = 4, price = 15) => [{ reportId: id, movieCount: count, priceCents: price }];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-fts-'));
  const dbPath = join(directory, 'family.sqlite');
  let app = createFamilyServer({ dbPath, setupCode: 'setup-code' });
  async function listen() { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); }
  await listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function request(method, path, body, token) {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, {
      method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { httpStatus: response.status, ...(await response.json()) };
  }
  const parent = await request('POST', '/setup', { familyName: 'Family', name: 'Parent One', username: 'parent1', password: 'parent-pass-123', setupCode: 'setup-code' });
  async function member(name, username, role) {
    assert.equal((await request('POST', '/members', { name, username, role, password: 'member-pass-123' }, parent.token)).httpStatus, 200);
    return request('POST', '/login', { username, password: 'member-pass-123' });
  }
  const parent2 = await member('Parent Two', 'parent2', 'parent');
  const child = await member('Child One', 'child1', 'child');
  const sibling = await member('Child Two', 'child2', 'child');
  const issuer = await request('POST', '/fts/issuers', { name: 'Desktop tracker', priceCents: 15 }, parent.token);
  assert.equal(issuer.httpStatus, 200);
  const mint = (creditCode, reportList = reports(), token = issuer.token) => request('POST', '/fts/vouchers', { code: creditCode, reports: reportList }, token);
  const state = who => request('GET', '/state', undefined, who.token);
  const preview = (creditCode, who = child) => request('POST', '/credits/preview', { code: creditCode }, who.token);
  const redeem = (creditCode, who = child, childId) => request('POST', '/credits/redeem', { code: creditCode, ...(childId === undefined ? {} : { childId }) }, who.token);
  const status = (creditCode, token = issuer.token) => request('POST', '/fts/vouchers/status', { code: creditCode }, token);
  return { request, parent, parent2, child, sibling, issuer, mint, state, preview, redeem, status,
    get app() { return app; },
    async reopen() { await app.close(); app = createFamilyServer({ dbPath, setupCode: 'different-code' }); await listen(); } };
}

test('only parents connect FTS, and scoped tracker keys cannot access family sessions or ledger routes', async t => {
  const f = await fixture(t);
  assert.match(f.issuer.token, /^fts_[A-Za-z0-9_-]{43}$/);
  const connected = await f.request('GET', '/fts/connection', undefined, f.issuer.token);
  assert.deepEqual(connected.issuer, f.issuer.issuer);
  for (const [method, path, body] of [
    ['POST', '/fts/issuers', { name: 'Unapproved', priceCents: 15 }],
    ['GET', '/fts/issuers', undefined],
    ['POST', `/fts/issuers/${f.issuer.issuer.id}/revoke`, {}],
  ]) assert.equal((await f.request(method, path, body, f.child.token)).httpStatus, 403);
  for (const [method, path, body] of [
    ['GET', '/state', undefined], ['POST', '/transactions', {}],
    ['POST', '/members', {}], ['POST', '/credits/redeem', { code: code() }],
    ['POST', '/fts/issuers', { name: 'Other', priceCents: 15 }],
  ]) assert.equal((await f.request(method, path, body, f.issuer.token)).httpStatus, 401);
  assert.equal((await f.mint(code(), reports(), f.child.token)).httpStatus, 401);
  assert.equal((await f.mint(code(), reports(), f.parent.token)).httpStatus, 401);
  assert.equal((await f.preview(code(), { token: undefined })).httpStatus, 401);
  const listed = await f.request('GET', '/fts/issuers', undefined, f.parent2.token);
  assert.equal(listed.issuers.length, 1);
  assert.equal(JSON.stringify(listed).includes(f.issuer.token), false);
  assert.equal(Object.hasOwn(listed.issuers[0], 'tokenHash'), false);
  assert.notEqual(f.app.store.db.prepare('SELECT token_hash FROM fts_issuers').get().token_hash, f.issuer.token);
});

test('a child claims immutable earnings once; only that child and parents receive ledger entries and alerts', async t => {
  const f = await fixture(t);
  const creditCode = code();
  assert.equal((await f.mint(creditCode)).amountCents, 60);
  const before = await f.preview(creditCode);
  assert.equal(before.status, 'issued');
  assert.equal(before.editCount, 4);
  assert.equal(before.reportCount, 1);
  assert.equal((await f.state(f.child)).transactions.length, 0);
  assert.equal((await f.redeem(creditCode, f.child, f.sibling.user.id)).httpStatus, 403);
  const claimed = await f.request('POST', '/credits/redeem', { code: creditCode, amountCents: 999999, reports: reports('fake', 99) }, f.child.token);
  assert.equal(claimed.httpStatus, 200);
  assert.equal(claimed.status, 'redeemed');
  assert.equal(claimed.amountCents, 60);
  assert.equal(claimed.replayed, false);
  assert.equal((await f.redeem(creditCode)).replayed, true);
  assert.equal((await f.redeem(creditCode, f.sibling)).httpStatus, 409);
  for (const who of [f.parent, f.parent2, f.child]) {
    const state = await f.state(who);
    assert.equal(state.transactions.length, 1);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.transactions[0].amountCents, 60);
    assert.equal(state.transactions[0].merchant, 'File edits');
    assert.equal(state.members.find(member => member.id === f.child.user.id).balanceCents, 60);
  }
  const siblingState = await f.state(f.sibling);
  assert.equal(siblingState.transactions.length, 0);
  assert.equal(siblingState.notifications.length, 0);
  const polled = await f.status(creditCode);
  assert.equal(polled.status, 'redeemed');
  assert.ok(polled.redeemedAt);
  for (const key of ['childId', 'childName', 'transaction', 'transactionId', 'members', 'reports']) assert.equal(Object.hasOwn(polled, key), false);
  assert.equal(JSON.stringify(polled).includes(f.child.user.id), false);
  const row = f.app.store.db.prepare('SELECT * FROM fts_vouchers').get();
  assert.notEqual(row.code_hash, creditCode);
  assert.equal(JSON.stringify(row).includes(creditCode), false);
});

test('parents must choose a child; competing scanners cannot redirect or duplicate a redemption', async t => {
  const f = await fixture(t);
  const creditCode = code();
  await f.mint(creditCode);
  assert.equal((await f.redeem(creditCode, f.parent)).httpStatus, 400);
  assert.equal((await f.redeem(creditCode, f.parent, f.parent.user.id)).httpStatus, 404);
  const competing = await Promise.all([
    f.redeem(creditCode, f.parent, f.child.user.id),
    f.redeem(creditCode, f.parent2, f.sibling.user.id),
    f.redeem(creditCode, f.sibling),
  ]);
  assert.equal(competing.filter(result => result.httpStatus === 200 && !result.replayed).length, 1);
  assert.equal(competing.filter(result => result.httpStatus === 409).length >= 1, true);
  const state = await f.state(f.parent);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.members.filter(member => member.role === 'child').reduce((total, member) => total + member.balanceCents, 0), 60);
  const winner = state.transactions[0].childId;
  assert.equal((await f.redeem(creditCode, f.parent2, winner)).replayed, true);
  assert.equal((await f.state(f.parent2)).notifications.length, 1);
});

test('report and code replay protection survives restart and spans parents and replacement tracker keys', async t => {
  const f = await fixture(t);
  const creditCode = code();
  const batch = [...reports('two', 2), ...reports('one', 1)];
  const issued = await f.mint(creditCode, batch);
  assert.equal(issued.amountCents, 45);
  assert.deepEqual(await f.mint(creditCode, [...batch].reverse()), issued);
  assert.equal((await f.mint(creditCode, reports('changed', 2))).httpStatus, 409);
  assert.equal((await f.mint(code(), reports('one', 1))).httpStatus, 409);
  assert.equal((await f.status(creditCode, f.parent.token)).httpStatus, 401);
  const secondIssuer = await f.request('POST', '/fts/issuers', { name: 'Another PC', priceCents: 15 }, f.parent2.token);
  assert.equal((await f.mint(code(), reports('two', 2), secondIssuer.token)).httpStatus, 409);
  assert.equal((await f.mint(creditCode, batch, secondIssuer.token)).httpStatus, 409);
  assert.equal((await f.status(creditCode, secondIssuer.token)).httpStatus, 404);
  await f.redeem(creditCode);
  await f.reopen();
  assert.equal((await f.mint(creditCode, batch)).status, 'redeemed');
  assert.equal((await f.redeem(creditCode)).replayed, true);
  assert.equal((await f.mint(code(), reports('one', 1), secondIssuer.token)).httpStatus, 409);
  assert.equal((await f.state(f.child)).members[0].balanceCents, 45);
});

test('invalid earnings, duplicate report IDs, price changes, and oversized credits never issue a code', async t => {
  const f = await fixture(t);
  for (const priceCents of [0, -1, 1.5, '15', true, 1_000_001]) {
    assert.equal((await f.request('POST', '/fts/issuers', { name: 'Invalid', priceCents }, f.parent.token)).httpStatus, 400);
  }
  for (const batch of [[], Array(101).fill(reports()[0]), [null], [reports()[0], reports()[0]],
    reports('wrong-price', 1, 16), reports('zero-edits', 0), reports('fractional', 0.5),
    reports('string', '4'), reports('bool', true), reports('too-many', 1_000_001),
    reports('too-much-money', 100000), reports('x'.repeat(201)), reports('   ')]) {
    assert.equal((await f.mint(code(), batch)).httpStatus, 400);
  }
  for (const invalid of ['', 'a'.repeat(42), 'a'.repeat(44), 'https://example.com', 43, ' '.repeat(43)]) {
    assert.equal((await f.mint(invalid)).httpStatus, 400);
    assert.equal((await f.preview(invalid)).httpStatus, 400);
  }
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_vouchers').get().count, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_reports').get().count, 0);
});

test('revocation stops issuance and unused redemption but allows FTS to clear codes and detect completed claims', async t => {
  const f = await fixture(t);
  const unused = code();
  const used = code();
  await f.mint(unused);
  await f.mint(used, reports('other'));
  await f.redeem(used);
  const revoked = await f.request('POST', `/fts/issuers/${f.issuer.issuer.id}/revoke`, {}, f.parent2.token);
  assert.equal(revoked.httpStatus, 200);
  assert.ok(revoked.issuer.revokedAt);
  assert.equal((await f.request('GET', '/fts/connection', undefined, f.issuer.token)).httpStatus, 403);
  assert.equal((await f.mint(code(), reports('new'))).httpStatus, 403);
  assert.equal((await f.preview(unused)).status, 'revoked');
  assert.equal((await f.status(unused)).status, 'revoked');
  assert.equal((await f.redeem(unused)).httpStatus, 403);
  assert.equal((await f.status(used)).status, 'redeemed');
  assert.equal((await f.redeem(used)).replayed, true);
  assert.equal((await f.state(f.child)).members[0].balanceCents, 60);
});

test('failed notification creation rolls back consumption, ledger, alerts, and preserves a redeemable code', async t => {
  const f = await fixture(t);
  const creditCode = code();
  await f.mint(creditCode);
  f.app.store.db.exec("CREATE TRIGGER reject_fts_alert BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  assert.equal((await f.redeem(creditCode)).httpStatus, 500);
  assert.equal((await f.status(creditCode)).status, 'issued');
  assert.equal((await f.state(f.child)).transactions.length, 0);
  assert.equal((await f.state(f.parent)).notifications.length, 0);
  assert.equal((await f.state(f.child)).members[0].balanceCents, 0);
  f.app.store.db.exec('DROP TRIGGER reject_fts_alert');
  assert.equal((await f.redeem(creditCode)).status, 'redeemed');
  assert.equal((await f.state(f.child)).members[0].balanceCents, 60);
});
