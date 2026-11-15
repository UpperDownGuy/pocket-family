import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFamilyServer, createFTSPairingLimiter } from '../index.mjs';
import { APIError } from '../store.mjs';

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
  async function pairIssuer(created) {
    assert.equal(created.httpStatus, 200);
    assert.match(created.setupCode, /^[0-9]{8}$/);
    assert.equal(Object.hasOwn(created, 'token'), false);
    const token = 'fts_' + code();
    const paired = await request('POST', '/fts/pair', { setupCode: created.setupCode, credential: token });
    assert.equal(paired.httpStatus, 200);
    assert.ok(paired.issuer.pairedAt);
    assert.deepEqual({ ...paired.issuer, pairedAt: null }, created.issuer);
    return { ...created, issuer: paired.issuer, token };
  }
  const issuer = await pairIssuer(await request('POST', '/fts/issuers', { name: 'Desktop tracker', priceCents: 15 }, parent.token));
  const mint = (creditCode, reportList = reports(), token = issuer.token) => request('POST', '/fts/vouchers', { code: creditCode, reports: reportList }, token);
  const state = who => request('GET', '/state', undefined, who.token);
  const preview = (creditCode, who = child) => request('POST', '/credits/preview', { code: creditCode }, who.token);
  const redeem = (creditCode, who = child, childId) => request('POST', '/credits/redeem', { code: creditCode, ...(childId === undefined ? {} : { childId }) }, who.token);
  const status = (creditCode, token = issuer.token) => request('POST', '/fts/vouchers/status', { code: creditCode }, token);
  return { request, parent, parent2, child, sibling, issuer, mint, state, preview, redeem, status, pairIssuer,
    get app() { return app; },
    async reopen() { await app.close(); app = createFamilyServer({ dbPath, setupCode: 'different-code' }); await listen(); } };
}

test('scoped tracker keys cannot access family sessions or ledger routes, and children cannot inspect another account\'s keys', async t => {
  const f = await fixture(t);
  assert.match(f.issuer.token, /^fts_[A-Za-z0-9_-]{43}$/);
  const connected = await f.request('GET', '/fts/connection', undefined, f.issuer.token);
  assert.deepEqual(connected.issuer, f.issuer.issuer);
  assert.deepEqual((await f.request('GET', '/fts/issuers', undefined, f.child.token)).issuers, []);
  assert.equal((await f.request('POST', `/fts/issuers/${f.issuer.issuer.id}/revoke`, {}, f.child.token)).httpStatus, 404);
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

test('children create their own connection keys and edit rates, manage only their keys, and earn credits with normal family privacy', async t => {
  const f = await fixture(t);
  const own = await f.pairIssuer(await f.request('POST', '/fts/issuers', { name: 'My file tracker', priceCents: 23 }, f.child.token));
  assert.equal(own.httpStatus, 200);
  assert.match(own.token, /^fts_[A-Za-z0-9_-]{43}$/);
  assert.equal(own.issuer.priceCents, 23);
  const siblingIssuer = await f.pairIssuer(await f.request('POST', '/fts/issuers', { name: 'Sibling tracker', priceCents: 31 }, f.sibling.token));
  assert.equal(siblingIssuer.httpStatus, 200);
  assert.deepEqual((await f.request('GET', '/fts/issuers', undefined, f.child.token)).issuers.map(issuer => issuer.id), [own.issuer.id]);
  assert.deepEqual((await f.request('GET', '/fts/issuers', undefined, f.sibling.token)).issuers.map(issuer => issuer.id), [siblingIssuer.issuer.id]);
  assert.equal((await f.request('GET', '/fts/issuers', undefined, f.parent2.token)).issuers.length, 3);
  assert.equal((await f.request('POST', `/fts/issuers/${own.issuer.id}/revoke`, {}, f.sibling.token)).httpStatus, 404);
  assert.equal((await f.request('POST', `/fts/issuers/${siblingIssuer.issuer.id}/revoke`, {}, f.child.token)).httpStatus, 404);
  for (const priceCents of [0, -1, 1.5, '23', true, 1_000_001]) {
    assert.equal((await f.request('POST', '/fts/issuers', { name: 'Invalid rate', priceCents }, f.child.token)).httpStatus, 400);
  }
  const creditCode = code();
  const issued = await f.mint(creditCode, reports('child-created-key-report', 5, 23), own.token);
  assert.equal(issued.httpStatus, 200);
  assert.equal(issued.amountCents, 115);
  assert.equal((await f.redeem(creditCode, f.child)).status, 'redeemed');
  assert.equal((await f.status(creditCode, own.token)).status, 'redeemed');
  for (const who of [f.parent, f.parent2, f.child]) {
    const state = await f.state(who);
    assert.equal(state.transactions.length, 1);
    assert.equal(state.notifications.length, 1);
    assert.equal(state.transactions[0].amountCents, 115);
  }
  assert.equal((await f.state(f.sibling)).transactions.length, 0);
  assert.equal((await f.state(f.sibling)).notifications.length, 0);
  // Creating the connection as a child does not bind its QR codes to that child:
  // the existing parent scanner still chooses the intended recipient.
  const anotherCode = code();
  assert.equal((await f.mint(anotherCode, reports('child-key-parent-selection', 1, 23), own.token)).httpStatus, 200);
  assert.equal((await f.redeem(anotherCode, f.parent, f.sibling.user.id)).status, 'redeemed');
  assert.equal((await f.state(f.child)).members[0].balanceCents, 115);
  assert.equal((await f.state(f.sibling)).members[0].balanceCents, 23);
  const ownRevoked = await f.request('POST', `/fts/issuers/${own.issuer.id}/revoke`, {}, f.child.token);
  assert.equal(ownRevoked.httpStatus, 200);
  assert.ok(ownRevoked.issuer.revokedAt);
  const parentRevoked = await f.request('POST', `/fts/issuers/${siblingIssuer.issuer.id}/revoke`, {}, f.parent2.token);
  assert.equal(parentRevoked.httpStatus, 200);
  assert.ok(parentRevoked.issuer.revokedAt);
  assert.equal((await f.request('GET', '/fts/connection', undefined, siblingIssuer.token)).httpStatus, 403);
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
  const secondIssuer = await f.pairIssuer(await f.request('POST', '/fts/issuers', { name: 'Another PC', priceCents: 15 }, f.parent2.token));
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

test('setup codes preserve leading zeroes, expire after ten minutes, and safely retry collisions without exposing credentials', async t => {
  const f = await fixture(t);
  const originalGenerator = f.app.store.generateFTSSetupCode;
  t.after(() => { f.app.store.generateFTSSetupCode = originalGenerator; });
  f.app.store.generateFTSSetupCode = () => '00000007';
  const before = Date.now();
  const first = await f.request('POST', '/fts/issuers', { name: 'Leading zero', priceCents: 15 }, f.child.token);
  assert.equal(first.httpStatus, 200);
  assert.equal(first.setupCode, '00000007');
  assert.equal(Object.hasOwn(first, 'token'), false);
  assert.ok(Date.parse(first.expiresAt) >= before + 600000);
  assert.ok(Date.parse(first.expiresAt) <= Date.now() + 600000);
  let calls = 0;
  f.app.store.generateFTSSetupCode = () => ++calls === 1 ? '00000007' : '00000008';
  const next = await f.request('POST', '/fts/issuers', { name: 'Collision retry', priceCents: 15 }, f.parent.token);
  assert.equal(next.setupCode, '00000008');
  assert.equal(calls, 2);
  const row = f.app.store.db.prepare('SELECT * FROM fts_pairings WHERE issuer_id=?').get(first.issuer.id);
  assert.equal(row.code_hash, createHash('sha256').update('00000007').digest('hex'));
  assert.notEqual(row.code_hash, first.setupCode);
  const listed = await f.request('GET', '/fts/issuers', undefined, f.child.token);
  assert.equal(Object.hasOwn(listed.issuers[0], 'setupCode'), false);
  for (const path of ['/fts/connection', '/state']) {
    assert.equal((await f.request('GET', path, undefined, first.setupCode)).httpStatus, 401);
  }
  const paired = await f.pairIssuer(first);
  assert.equal((await f.request('GET', '/fts/connection', undefined, paired.token)).issuer.id, first.issuer.id);
  const issuerCount = f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_issuers').get().count;
  f.app.store.generateFTSSetupCode = () => '00000007';
  assert.equal((await f.request('POST', '/fts/issuers', { name: 'Exhausted collisions', priceCents: 15 }, f.parent.token)).httpStatus, 503);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_issuers').get().count, issuerCount);
});

test('pairing retries recover lost responses after expiry and restart; other credentials cannot reuse a consumed code', async t => {
  const f = await fixture(t);
  const created = await f.request('POST', '/fts/issuers', { name: 'Retrying desktop', priceCents: 15 }, f.child.token);
  // A credential already used by another tracker cannot alias both accounts.
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: created.setupCode, credential: f.issuer.token })).httpStatus, 409);
  const paired = await f.pairIssuer(created);
  f.app.store.db.prepare('UPDATE fts_pairings SET expires_at=? WHERE issuer_id=?').run(Date.now() - 1, created.issuer.id);
  await f.reopen();
  const retry = await f.request('POST', '/fts/pair', { setupCode: created.setupCode, credential: paired.token });
  assert.equal(retry.httpStatus, 200);
  assert.deepEqual(retry.issuer, paired.issuer);
  const otherCredential = 'fts_' + code();
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: created.setupCode, credential: otherCredential })).httpStatus, 409);
  assert.equal((await f.request('GET', '/fts/connection', undefined, otherCredential)).httpStatus, 401);
  const voucher = code();
  assert.equal((await f.mint(voucher, reports('paired-restart'), paired.token)).httpStatus, 200);
  assert.equal((await f.redeem(voucher, f.child)).status, 'redeemed');
  assert.equal((await f.status(voucher, paired.token)).status, 'redeemed');
  assert.equal((await f.state(f.sibling)).notifications.length, 0);
});

test('unused expired codes, revoked trackers, and malformed setup fields cannot establish a credential', async t => {
  const f = await fixture(t);
  const credential = 'fts_' + code();
  const expired = await f.request('POST', '/fts/issuers', { name: 'Expired setup', priceCents: 15 }, f.parent.token);
  f.app.store.db.prepare('UPDATE fts_pairings SET expires_at=? WHERE issuer_id=?').run(Date.now() - 1, expired.issuer.id);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: expired.setupCode, credential })).httpStatus, 410);
  assert.equal((await f.request('GET', '/fts/connection', undefined, credential)).httpStatus, 401);
  const revoked = await f.request('POST', '/fts/issuers', { name: 'Revoked setup', priceCents: 15 }, f.child.token);
  assert.equal((await f.request('POST', `/fts/issuers/${revoked.issuer.id}/revoke`, {}, f.child.token)).httpStatus, 200);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: revoked.setupCode, credential })).httpStatus, 403);
  assert.equal((await f.request('GET', '/fts/connection', undefined, credential)).httpStatus, 401);
  for (const setupCode of [12345678, true, null, '', '1234567', '123456789', '１２３４５６７８', ' 12345678', '1234 678']) {
    assert.throws(() => f.app.store.pairFTSIssuer({ setupCode, credential }), error => error instanceof APIError && error.status === 400);
  }
  for (const invalid of [undefined, '12345678', 'fts_' + 'a'.repeat(42), true]) {
    assert.throws(() => f.app.store.pairFTSIssuer({ setupCode: expired.setupCode, credential: invalid }), error => error instanceof APIError && error.status === 400);
  }
  // Revocation also blocks an otherwise valid replay of a completed pairing.
  await f.request('POST', `/fts/issuers/${f.issuer.issuer.id}/revoke`, {}, f.parent.token);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: f.issuer.setupCode, credential: f.issuer.token })).httpStatus, 403);
});

test('previous long-lived tracker credentials remain valid without any pairing record', async t => {
  const f = await fixture(t);
  // This models a pre-pairing issuer: same existing issuer schema and hash,
  // with no entry in the newly added, optional setup-code table.
  f.app.store.db.prepare('DELETE FROM fts_pairings WHERE issuer_id=?').run(f.issuer.issuer.id);
  await f.reopen();
  const connection = await f.request('GET', '/fts/connection', undefined, f.issuer.token);
  assert.equal(connection.httpStatus, 200);
  assert.equal(connection.issuer.ownerId, f.parent.user.id);
  assert.equal(connection.issuer.ownerName, f.parent.user.name);
  assert.equal(connection.issuer.pairedAt, connection.issuer.createdAt);
  const voucher = code();
  assert.equal((await f.mint(voucher)).httpStatus, 200);
  assert.equal((await f.redeem(voucher)).status, 'redeemed');
});

test('pairing attempts are limited by connection IP and server-wide windows', async t => {
  let now = 100000;
  const perIP = createFTSPairingLimiter(() => now);
  for (let i = 0; i < 10; i += 1) perIP('one');
  assert.throws(() => perIP('one'), error => error instanceof APIError && error.status === 429);
  perIP('two');
  now += 60000;
  perIP('one');
  const global = createFTSPairingLimiter(() => now);
  for (const ip of ['one', 'two', 'three']) for (let i = 0; i < 10; i += 1) global(ip);
  assert.throws(() => global('four'), error => error instanceof APIError && error.status === 429);
  now += 60000;
  global('four');
  const f = await fixture(t); // One pairing attempt was used by the fixture.
  for (let i = 0; i < 9; i += 1) {
    assert.equal((await f.request('POST', '/fts/pair', { setupCode: 'bad', credential: 'fts_' + code() })).httpStatus, 400);
  }
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: f.issuer.setupCode, credential: f.issuer.token })).httpStatus, 429);
});

test('computer setup, connection, and removal are logged once for all parents without restricting child setup or changing balances', async t => {
  const f = await fixture(t);
  const created = await f.request('POST', '/fts/issuers', { name: 'Avery desktop', priceCents: 15 }, f.child.token);
  assert.equal(created.httpStatus, 200);
  assert.equal(created.issuer.ownerId, f.child.user.id);
  assert.equal(created.issuer.ownerName, f.child.user.name);
  assert.equal(created.issuer.pairedAt, null);
  const forComputer = state => state.computerNotifications.filter(note => note.issuerId === created.issuer.id);
  for (const parent of [f.parent, f.parent2]) {
    const state = await f.state(parent);
    assert.equal(forComputer(state).length, 1);
    assert.equal(forComputer(state)[0].eventType, 'created');
    assert.ok(forComputer(state)[0].body.includes(f.child.user.name));
    assert.ok(forComputer(state)[0].body.includes('Avery desktop'));
    assert.equal(state.transactions.length, 0);
    assert.equal(state.notifications.length, 0);
    assert.equal(state.members.filter(member => member.role === 'child').reduce((sum, member) => sum + member.balanceCents, 0), 0);
  }
  assert.deepEqual((await f.state(f.child)).computerNotifications, []);
  assert.deepEqual((await f.state(f.sibling)).computerNotifications, []);
  assert.equal((await f.request('GET', '/fts/issuers', undefined, f.parent.token)).issuers.find(issuer => issuer.id === created.issuer.id).ownerName, f.child.user.name);
  const paired = await f.pairIssuer(created);
  assert.ok(paired.issuer.pairedAt);
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: created.setupCode, credential: paired.token })).httpStatus, 200);
  assert.deepEqual(forComputer(await f.state(f.parent)).map(note => note.eventType), ['paired', 'created']);
  const creditCode = code();
  assert.equal((await f.mint(creditCode, reports('computer-log-unclaimed'), paired.token)).httpStatus, 200);
  assert.equal((await f.request('POST', `/fts/issuers/${created.issuer.id}/revoke`, {}, f.sibling.token)).httpStatus, 404);
  const removed = await f.request('POST', `/fts/issuers/${created.issuer.id}/revoke`, {}, f.parent2.token);
  assert.equal(removed.httpStatus, 200);
  assert.ok(removed.issuer.revokedAt);
  assert.equal((await f.request('POST', `/fts/issuers/${created.issuer.id}/revoke`, {}, f.parent.token)).issuer.revokedAt, removed.issuer.revokedAt);
  assert.equal((await f.request('GET', '/fts/connection', undefined, paired.token)).httpStatus, 403);
  assert.equal((await f.redeem(creditCode, f.child)).httpStatus, 403);
  for (const parent of [f.parent, f.parent2]) {
    const state = await f.state(parent);
    const notes = forComputer(state);
    assert.deepEqual(notes.map(note => note.eventType), ['removed', 'paired', 'created']);
    assert.ok(notes[0].body.includes(f.parent2.user.name));
    assert.ok(notes[0].body.includes(f.child.user.name));
    assert.ok(notes.every(note => note.body.includes('Avery desktop')));
    assert.equal(JSON.stringify(notes).includes(paired.token), false);
    assert.equal(JSON.stringify(notes).includes(created.setupCode), false);
    assert.equal(state.transactions.length, 0);
    assert.equal(state.notifications.length, 0);
  }
  const firstParentNote = forComputer(await f.state(f.parent))[0];
  const otherParentNote = forComputer(await f.state(f.parent2))[0];
  await f.request('POST', '/notifications/read', { ids: [firstParentNote.id, otherParentNote.id] }, f.sibling.token);
  assert.equal(forComputer(await f.state(f.parent))[0].readAt, null);
  assert.equal(forComputer(await f.state(f.parent2))[0].readAt, null);
  // Reading a mixed inbox batch updates owned computer and ledger alerts only.
  const regularCredit = code();
  await f.mint(regularCredit, reports('regular-credit-after-computer-log'));
  await f.redeem(regularCredit, f.child);
  const ledgerNote = (await f.state(f.parent)).notifications[0];
  await f.request('POST', '/notifications/read', { ids: [firstParentNote.id, ledgerNote.id, otherParentNote.id] }, f.parent.token);
  assert.ok(forComputer(await f.state(f.parent))[0].readAt);
  assert.ok((await f.state(f.parent)).notifications[0].readAt);
  assert.equal(forComputer(await f.state(f.parent2))[0].readAt, null);
  assert.equal((await f.state(f.parent2)).notifications[0].readAt, null);
  assert.deepEqual((await f.state(f.child)).computerNotifications, []);
  assert.deepEqual((await f.state(f.sibling)).computerNotifications, []);
});

test('computer event failures roll back setup, pairing, and removal with their parent alerts', async t => {
  const f = await fixture(t);
  const counts = () => Object.fromEntries(['fts_issuers', 'fts_pairings', 'fts_events', 'fts_event_notifications']
    .map(table => [table, f.app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  const before = counts();
  f.app.store.db.exec("CREATE TRIGGER reject_computer_notice BEFORE INSERT ON fts_event_notifications BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  assert.equal((await f.request('POST', '/fts/issuers', { name: 'Must roll back', priceCents: 15 }, f.child.token)).httpStatus, 500);
  assert.deepEqual(counts(), before);
  f.app.store.db.exec('DROP TRIGGER reject_computer_notice');
  const created = await f.request('POST', '/fts/issuers', { name: 'Atomic desktop', priceCents: 15 }, f.child.token);
  const credential = 'fts_' + code();
  const beforePair = counts();
  f.app.store.db.exec("CREATE TRIGGER reject_computer_pair BEFORE INSERT ON fts_events WHEN NEW.event_type='paired' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: created.setupCode, credential })).httpStatus, 500);
  assert.deepEqual(counts(), beforePair);
  assert.equal(f.app.store.db.prepare('SELECT paired_at FROM fts_pairings WHERE issuer_id=?').get(created.issuer.id).paired_at, null);
  assert.equal((await f.request('GET', '/fts/connection', undefined, credential)).httpStatus, 401);
  f.app.store.db.exec('DROP TRIGGER reject_computer_pair');
  assert.equal((await f.request('POST', '/fts/pair', { setupCode: created.setupCode, credential })).httpStatus, 200);
  const beforeRemoval = counts();
  f.app.store.db.exec("CREATE TRIGGER reject_computer_removal BEFORE INSERT ON fts_events WHEN NEW.event_type='removed' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  assert.equal((await f.request('POST', `/fts/issuers/${created.issuer.id}/revoke`, {}, f.parent.token)).httpStatus, 500);
  assert.deepEqual(counts(), beforeRemoval);
  assert.equal(f.app.store.db.prepare('SELECT revoked_at FROM fts_issuers WHERE id=?').get(created.issuer.id).revoked_at, null);
  assert.equal((await f.request('GET', '/fts/connection', undefined, credential)).httpStatus, 200);
  f.app.store.db.exec('DROP TRIGGER reject_computer_removal');
  assert.equal((await f.request('POST', `/fts/issuers/${created.issuer.id}/revoke`, {}, f.parent.token)).httpStatus, 200);
  assert.equal((await f.request('GET', '/fts/connection', undefined, credential)).httpStatus, 403);
  assert.equal((await f.state(f.parent)).transactions.length, 0);
  assert.deepEqual((await f.state(f.child)).computerNotifications, []);
});

test('health reports supported computer setup and parent logging capabilities without account data', async t => {
  const f = await fixture(t);
  const health = await f.request('GET', '/health');
  assert.equal(health.httpStatus, 200);
  assert.deepEqual(health.capabilities, { fts: { setupCodeDigits: 8, childCanConnect: true, parentComputerLog: true, itemLists: true } });
  assert.deepEqual(Object.keys(health).sort(), ['capabilities', 'httpStatus', 'pushConfigured', 'setupRequired']);
});

test('FTS receipts expose normalized item details only to parents and the payment recipient, including after restart', async t => {
  const f = await fixture(t);
  const creditCode = code();
  const reportList = [{ reportId: 'items-report', movieCount: 6, priceCents: 15, items: [
    { path: 'Movies\\renamed.iso', status: 'renamed', oldPath: 'Movies\\before.iso' },
    { path: 'Movies/added.iso', status: 'added' }, { path: 'Movies/deleted.iso', status: 'removed' },
    { path: 'Movies/edited.iso', status: 'modified' },
  ] }, ...reports('older-count-only', 3)];
  assert.equal((await f.mint(creditCode, reportList)).httpStatus, 200);
  assert.equal((await f.redeem(creditCode)).status, 'redeemed');
  const transactionId = (await f.state(f.child)).transactions[0].id;
  const path = `/transactions/${transactionId}/items`;
  const expected = { httpStatus: 200, items: [
    { reportId: 'items-report', path: 'Movies/added.iso', status: 'added' },
    { reportId: 'items-report', path: 'Movies/deleted.iso', status: 'removed' },
    { reportId: 'items-report', path: 'Movies/edited.iso', status: 'modified' },
    { reportId: 'items-report', path: 'Movies/renamed.iso', status: 'renamed', oldPath: 'Movies/before.iso' },
  ], totalCount: 9, omittedCount: 5 };
  for (const who of [f.parent, f.parent2, f.child]) {
    assert.deepEqual(await f.request('GET', path, undefined, who.token), expected);
    const state = await f.state(who);
    assert.equal(JSON.stringify(state).includes('Movies/'), false);
    assert.equal(state.transactions[0].amountCents, 135);
    assert.equal(state.notifications.length, 1);
  }
  const unknown = '/transactions/00000000-0000-0000-0000-000000000000/items';
  assert.deepEqual(await f.request('GET', path, undefined, f.sibling.token), await f.request('GET', unknown, undefined, f.sibling.token));
  assert.equal((await f.request('GET', path)).httpStatus, 401);
  assert.equal((await f.request('GET', path, undefined, f.issuer.token)).httpStatus, 401);
  assert.deepEqual((await f.state(f.sibling)).transactions, []);
  await f.reopen();
  assert.deepEqual(await f.request('GET', path, undefined, f.child.token), expected);
  assert.equal((await f.mint(creditCode, reportList)).status, 'redeemed');
});

test('receipt items are immutable normalized voucher payloads and cannot be added or changed on replay', async t => {
  const f = await fixture(t);
  const creditCode = code();
  const report = { reportId: 'immutable-items', movieCount: 3, priceCents: 15, items: [
    { path: 'folder\\z.txt', status: 'renamed', oldPath: 'folder\\before.txt' },
    { path: 'folder\\a.txt', status: 'modified' },
  ] };
  assert.equal((await f.mint(creditCode, [report])).httpStatus, 200);
  const normalized = { ...report, items: [
    { path: 'folder/a.txt', status: 'modified' },
    { path: 'folder/z.txt', status: 'renamed', oldPath: 'folder/before.txt' },
  ] };
  assert.equal((await f.mint(creditCode, [normalized])).httpStatus, 200);
  const altered = [
    { ...normalized, items: undefined }, { ...normalized, items: [] },
    { ...normalized, items: [{ ...normalized.items[0], path: 'folder/different.txt' }, normalized.items[1]] },
    { ...normalized, items: [{ ...normalized.items[0], status: 'added' }, normalized.items[1]] },
    { ...normalized, items: [normalized.items[0], { ...normalized.items[1], oldPath: 'folder/other.txt' }] },
  ];
  for (const mutation of altered) assert.equal((await f.mint(creditCode, [mutation])).httpStatus, 409);
  assert.equal((await f.redeem(creditCode)).status, 'redeemed');
  assert.equal((await f.mint(creditCode, [normalized])).status, 'redeemed');
  for (const mutation of altered) assert.equal((await f.mint(creditCode, [mutation])).httpStatus, 409);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_report_items').get().count, 2);
  assert.equal((await f.state(f.child)).transactions.length, 1);
});

test('legacy count-only vouchers retain fingerprints and migrate additively without inventing item details', async t => {
  const f = await fixture(t);
  const creditCode = code();
  const reportList = reports('legacy-pending', 7);
  assert.equal((await f.mint(creditCode, reportList)).httpStatus, 200);
  const original = f.app.store.db.prepare('SELECT * FROM fts_vouchers').get();
  assert.equal(original.fingerprint, createHash('sha256').update(JSON.stringify(reportList)).digest('hex'));
  f.app.store.db.exec('DROP TABLE fts_report_items');
  await f.reopen();
  assert.equal((await f.mint(creditCode, reportList)).httpStatus, 200);
  assert.equal((await f.mint(creditCode, [{ ...reportList[0], items: [] }])).httpStatus, 200);
  const retryWithDetails = [{ ...reportList[0], items: [{ path: 'new-detail.txt', status: 'added' }] }];
  assert.equal((await f.mint(creditCode, retryWithDetails)).httpStatus, 200);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_report_items').get().count, 0);
  assert.equal(f.app.store.db.prepare('SELECT fingerprint FROM fts_vouchers').get().fingerprint, original.fingerprint);
  assert.equal((await f.redeem(creditCode)).status, 'redeemed');
  const transactionId = (await f.state(f.child)).transactions[0].id;
  assert.deepEqual(await f.request('GET', `/transactions/${transactionId}/items`, undefined, f.child.token),
    { httpStatus: 200, items: [], totalCount: 7, omittedCount: 7 });
  assert.equal((await f.mint(creditCode, retryWithDetails)).status, 'redeemed');
  assert.equal((await f.mint(creditCode, [{ ...retryWithDetails[0], movieCount: 8 }])).httpStatus, 409);
  const manual = await f.request('POST', '/transactions', { childId: f.child.user.id, kind: 'addition', amountCents: 15,
    merchant: 'Allowance', note: '', idempotencyKey: 'manual-receipt-fixture' }, f.parent.token);
  assert.deepEqual(await f.request('GET', `/transactions/${manual.transaction.id}/items`, undefined, f.child.token),
    { httpStatus: 200, items: [], totalCount: 0, omittedCount: 0 });
});

test('receipt items reject invalid status, excessive counts, duplicate paths, and absolute or unsafe paths', async t => {
  const f = await fixture(t);
  const invalidItems = [null, {}, 'file.txt', [null], [{}], [{ path: 'file.txt', status: 'unchanged' }],
    [{ path: 'file.txt', status: 'modified', oldPath: 'old.txt' }],
    [{ path: 'file.txt', status: 'renamed', oldPath: 'file.txt' }],
    [{ path: 'same\\file.txt', status: 'modified' }, { path: 'same/file.txt', status: 'added' }],
    Array.from({ length: 501 }, (_, index) => ({ path: `${index}.txt`, status: 'added' })),
  ];
  for (const path of ['', ' ', '/etc/private', 'C:\\Users\\name\\file', 'C:file.txt', '\\\\server\\file', '../file',
    'a/../file', './file', 'a//file', 'a\nfile', 'a\u0000file', 'a\u0085file', 'a\ud800file', ' file.txt', 'file.txt ', 'file.txt/', 'x'.repeat(501), 42]) {
    invalidItems.push([{ path, status: 'modified' }]);
    invalidItems.push([{ path: 'valid.txt', status: 'renamed', oldPath: path }]);
  }
  for (const items of invalidItems) {
    assert.equal((await f.mint(code(), [{ reportId: 'invalid-items', movieCount: 600, priceCents: 15, items }])).httpStatus, 400);
  }
  assert.equal((await f.mint(code(), [{ reportId: 'more-items-than-edits', movieCount: 1, priceCents: 15,
    items: [{ path: 'one', status: 'added' }, { path: 'two', status: 'modified' }] }])).httpStatus, 400);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_vouchers').get().count, 0);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_report_items').get().count, 0);
});

test('only voucher issuance accepts bodies over 16 KiB and it enforces the 512 KiB maximum', async t => {
  const f = await fixture(t);
  const items = Array.from({ length: 500 }, (_, index) => ({ path: `${index}-` + 'x'.repeat(350), status: 'modified' }));
  const accepted = [{ reportId: 'large-receipt', movieCount: 500, priceCents: 15, items }];
  assert.ok(Buffer.byteLength(JSON.stringify({ code: code(), reports: accepted })) > 16 * 1024);
  assert.equal((await f.mint(code(), accepted)).httpStatus, 200);
  const oversized = Array.from({ length: 3 }, (_, index) => ({ ...accepted[0], reportId: `oversized-${index}` }));
  assert.ok(Buffer.byteLength(JSON.stringify({ code: code(), reports: oversized })) > 512 * 1024);
  assert.equal((await f.mint(code(), oversized)).httpStatus, 413);
  assert.equal((await f.request('POST', '/fts/vouchers/status', { code: code(), padding: 'x'.repeat(17000) }, f.issuer.token)).httpStatus, 413);
  assert.equal((await f.request('POST', '/credits/preview', { code: code(), padding: 'x'.repeat(17000) }, f.child.token)).httpStatus, 413);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM fts_vouchers').get().count, 1);
});

test('item persistence failure rolls back the entire voucher and report reservation', async t => {
  const f = await fixture(t);
  f.app.store.db.exec("CREATE TRIGGER reject_receipt_item BEFORE INSERT ON fts_report_items BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;");
  const creditCode = code();
  const reportList = [{ reportId: 'atomic-items', movieCount: 1, priceCents: 15, items: [{ path: 'file.txt', status: 'modified' }] }];
  assert.equal((await f.mint(creditCode, reportList)).httpStatus, 500);
  for (const table of ['fts_vouchers', 'fts_reports', 'fts_report_items', 'transactions']) {
    assert.equal(f.app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
  }
  f.app.store.db.exec('DROP TRIGGER reject_receipt_item');
  assert.equal((await f.mint(creditCode, reportList)).httpStatus, 200);
  assert.equal((await f.redeem(creditCode)).status, 'redeemed');
});
