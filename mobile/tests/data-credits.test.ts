/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createFamilyServer } from '../../server/index.mjs';
import { APIError, PocketAPI } from '../src/data/api';
import type { FetchResponse, FetchTransport } from '../src/data/api';
import { PocketController, type SessionStorage } from '../src/data/controller';
import { parseCreditCode, parseIssuedKey, parseIssuers, parseRedemption, parseVoucher } from '../src/data/credits';
import type { FamilyState } from '../src/data/models';

const code = 'C'.repeat(43);
const parent = { id: 'parent-1', name: 'Parent', username: 'parent', role: 'parent' as const };
const child = { id: 'child-1', name: 'Child', username: 'child', role: 'child' as const, balanceCents: 0 };
const issuer = { id: 'issuer-1', name: 'Desktop', priceCents: 15, createdAt: '2026-11-15T12:00:00.000Z', revokedAt: null };
const setupKey = { issuer, setupCode: '01234567', expiresAt: '2026-11-15T12:10:00.000Z' };
const voucher = { status: 'issued', amountCents: 45, reportCount: 1, editCount: 3, createdAt: '2026-11-15T12:00:00.000Z', redeemedAt: null };
function response(value: unknown, status = 200): FetchResponse { return { status, json: async () => value }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Storage implements SessionStorage {
  url: string | null = null;
  token: string | null = null;
  async getServerURL() { return this.url; }
  async setServerURL(value: string) { this.url = value; }
  async getToken() { return this.token; }
  async setToken(_server: string, value: string) { this.token = value; }
  async removeToken() { this.token = null; }
}

test('QR parser accepts only a raw code or the exact Pocket redeem link; it never accepts a server override', () => {
  assert.equal(parseCreditCode(code), code);
  assert.equal(parseCreditCode(`pocket://redeem?code=${code}`), code);
  for (const invalid of [undefined, null, [code], `https://server.example/credits?code=${code}`, `pocket://redeem?code=${code}&server=https://evil.example`,
    `pocket://redeem?code=${code}&code=${code}`, `pocket://redeem?token=${code}`, `pocket://redeem?code=${code}#extra`,
    `pocket://user@redeem?code=${code}`, `pocket://redeem/?code=${code}`, `pocket://redeem?code=${'%43'.repeat(43)}`, code.slice(1), `${code}x`]) {
    assert.throws(() => parseCreditCode(invalid), /not a Pocket earnings code/);
  }
});

test('earnings payload validators reject invented amounts, inconsistent redemption state and exposed issuer credentials', () => {
  assert.deepEqual(parseVoucher(voucher), voucher);
  for (const patch of [{ amountCents: 0 }, { amountCents: 1.5 }, { amountCents: 1_000_001 }, { reportCount: -1 }, { editCount: null },
    { status: 'redeemed' }, { redeemedAt: '2026-11-15T12:05:00Z' }, { createdAt: 'invalid' }]) {
    assert.throws(() => parseVoucher({ ...voucher, ...patch }));
  }
  assert.throws(() => parseRedemption({ ...voucher, replayed: false }));
  const added = { ...voucher, status: 'redeemed', redeemedAt: '2026-11-15T12:05:00Z', replayed: false };
  assert.deepEqual(parseRedemption(added), added);
  assert.deepEqual(parseIssuers({ issuers: [{ ...issuer, token: 'do-not-forward' }] }), [issuer]);
  assert.throws(() => parseIssuedKey({ issuer, token: 'bad-key' }));
});

test('setup keys keep all eight ASCII digits, including leading zeros, and require an expiry', () => {
  assert.deepEqual(parseIssuedKey(setupKey), setupKey);
  assert.equal(parseIssuedKey({ ...setupKey, setupCode: '00000000' }).setupCode, '00000000');
  assert.deepEqual(parseIssuedKey({ ...setupKey, token: 'do-not-forward' }), setupKey);
  for (const value of [1234567, 12345678, null, '1234567', '012345678', '1234abcd', '１２３４５６７８', '١٢٣٤٥٦٧٨', ' 01234567', '01234567 ']) {
    assert.throws(() => parseIssuedKey({ ...setupKey, setupCode: value }));
  }
  for (const expiresAt of [undefined, null, 1_000_000, 'not-a-date']) {
    assert.throws(() => parseIssuedKey({ ...setupKey, expiresAt }));
  }
});

test('credit APIs keep redemption codes out of URLs and use only the configured server with existing session authentication', async () => {
  const calls: { url: string; options: Parameters<FetchTransport>[1] }[] = [];
  const api = new PocketAPI('https://family.example', async (url, options) => { calls.push({ url, options }); return response(voucher); });
  await api.previewCredit('parent-session', `pocket://redeem?code=${code}`);
  assert.equal(calls[0].url, 'https://family.example/credits/preview');
  assert.deepEqual(JSON.parse(calls[0].options.body!), { code });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer parent-session');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.credentials, 'omit');
  await assert.rejects(api.previewCredit('parent-session', `${code}&server=https://evil.example`));
  await assert.rejects(api.revokeFTSIssuer('parent-session', '../login'));
  assert.equal(calls.length, 1);
});

test('a setup key arriving after sign-out is rejected instead of being exposed to the next account', async () => {
  const pending = deferred<FetchResponse>();
  const started = deferred<void>();
  const current: FamilyState = { user: parent, members: [parent, child], familyName: 'Test', transactions: [], notifications: [], computerNotifications: [], pushConfigured: false };
  const transport: FetchTransport = async (url, options) => {
    switch (new URL(url).pathname) {
      case '/health': return response({ setupRequired: false, pushConfigured: false });
      case '/login': return response({ token: 'A'.repeat(43), user: parent, familyName: 'Test' });
      case '/state': return response(current);
      case '/fts/issuers': if (options.method === 'POST') { started.resolve(); return pending.promise; } return response({ issuers: [] });
      default: return response({ ok: true });
    }
  };
  const controller = new PocketController(new Storage(), transport);
  await controller.initialize(); await controller.signIn('parent', 'parent-password');
  const result = controller.createFTSIssuer('Desktop', 15);
  const rejection = assert.rejects(result, /replaced by another sign-in/);
  await started.promise;
  await controller.signOut();
  pending.resolve(response(setupKey));
  await rejection;
  assert.equal(controller.getSnapshot().state, null);
});

test('a child can manage their File Tracker connection while sibling redemption and invalid rates remain blocked', async () => {
  let creditCalls = 0;
  const current: FamilyState = { user: child, members: [child], familyName: 'Test', transactions: [], notifications: [], computerNotifications: [], pushConfigured: false };
  const controller = new PocketController(new Storage(), async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return response({ setupRequired: false, pushConfigured: false });
    if (path === '/login') return response({ token: 'A'.repeat(43), user: child, familyName: 'Test' });
    if (path === '/state') return response(current);
    creditCalls++;
    if (path === '/fts/issuers') return options.method === 'POST'
      ? response(setupKey) : response({ issuers: [issuer] });
    if (path === '/fts/issuers/issuer-1/revoke') return response({ issuer: { ...issuer, revokedAt: '2026-11-15T12:05:00Z' } });
    return response({});
  });
  await controller.initialize(); await controller.signIn('child', 'child-password');
  assert.equal((await controller.createFTSIssuer('Desktop', 15)).issuer.id, issuer.id);
  assert.deepEqual(await controller.listFTSIssuers(), [issuer]);
  assert.ok((await controller.revokeFTSIssuer('issuer-1')).revokedAt);
  await assert.rejects(controller.createFTSIssuer('Desktop', 0), /Enter a name and a price/);
  await assert.rejects(controller.createFTSIssuer('Desktop', 1.5), /Enter a name and a price/);
  await assert.rejects(controller.redeemCredit(code, 'sibling-1'), /only redeem earnings for yourself/);
  assert.equal(creditCalls, 3);
});

test('real API credits one recipient and parents, deduplicates repeated redemption and supports issuer revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-mobile-credit-'));
  const app = createFamilyServer({ dbPath: join(directory, 'test.sqlite') });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = new PocketAPI(url, (value, options) => fetch(value, options));
  assert.equal(await api.checkFTSSupport(), true);
  const owner = await api.setup({ familyName: 'Test', name: 'Parent', username: 'parent', password: 'parent-password', setupCode: app.store.setupCode });
  await api.addMember(owner.token, { name: 'Avery', username: 'avery', role: 'child', password: 'child-password' });
  await api.addMember(owner.token, { name: 'Jordan', username: 'jordan', role: 'child', password: 'child-password' });
  const avery = await api.signIn('avery', 'child-password');
  const jordan = await api.signIn('jordan', 'child-password');
  const created = await api.createFTSIssuer(owner.token, 'FTS Desktop', 15);
  assert.match(created.setupCode, /^[0-9]{8}$/);
  assert.equal(created.issuer.ownerId, owner.user.id);
  assert.equal(created.issuer.ownerName, 'Parent');
  assert.equal(created.issuer.pairedAt, null);
  const credential = `fts_${randomBytes(32).toString('base64url')}`;
  const pairing = await fetch(`${url}/fts/pair`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupCode: created.setupCode, credential }) });
  assert.equal(pairing.status, 200);
  assert.equal((await pairing.json()).issuer.id, created.issuer.id);
  const connected = (await api.listFTSIssuers(owner.token))[0];
  assert.equal(connected.id, created.issuer.id);
  assert.ok(connected.pairedAt);
  const childConnection = await api.createFTSIssuer(avery.token, 'Avery Desktop', 25);
  assert.deepEqual((await api.listFTSIssuers(avery.token)).map(value => value.id), [childConnection.issuer.id]);
  assert.deepEqual(await api.listFTSIssuers(jordan.token), []);
  assert.equal((await api.listFTSIssuers(owner.token)).length, 2);
  await assert.rejects(api.revokeFTSIssuer(jordan.token, childConnection.issuer.id), error => error instanceof APIError && error.status === 404);
  await assert.rejects(api.revokeFTSIssuer(avery.token, created.issuer.id), error => error instanceof APIError && error.status === 404);
  assert.ok((await api.revokeFTSIssuer(avery.token, childConnection.issuer.id)).revokedAt);
  const computerLog = (await api.state(owner.token)).computerNotifications;
  assert.ok(computerLog.some(item => item.issuerId === childConnection.issuer.id && item.eventType === 'created'));
  assert.ok(computerLog.some(item => item.issuerId === childConnection.issuer.id && item.eventType === 'removed'));
  assert.ok(computerLog.some(item => item.issuerId === created.issuer.id && item.eventType === 'paired'));
  assert.deepEqual((await api.state(avery.token)).computerNotifications, []);
  assert.deepEqual((await api.state(jordan.token)).computerNotifications, []);
  await api.markRead(avery.token, computerLog.map(item => item.id));
  assert.ok((await api.state(owner.token)).computerNotifications.every(item => item.readAt === null));
  async function issue(value: string, id: string) {
    const result = await fetch(`${url}/fts/vouchers`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body: JSON.stringify({ code: value, reports: [{ reportId: id, movieCount: 3, priceCents: 15,
        items: [{ path: 'Movies/Edited.iso', status: 'modified' }, { path: 'Movies/New.iso', oldPath: 'Movies/Old.iso', status: 'renamed' }] }] }) });
    assert.equal(result.status, 200);
  }
  await issue(code, 'report-1');
  assert.equal((await api.previewCredit(avery.token, code)).amountCents, 45);
  const redeemed = await api.redeemCredit(avery.token, code);
  assert.equal(redeemed.replayed, false);
  assert.equal((await api.redeemCredit(avery.token, code)).replayed, true);
  assert.equal((await api.state(owner.token)).notifications.length, 1);
  assert.equal((await api.state(avery.token)).notifications.length, 1);
  assert.equal((await api.state(jordan.token)).notifications.length, 0);
  const credited = await api.state(avery.token);
  const receiptId = credited.transactions[0].id;
  const receipt = await api.transactionItems(avery.token, receiptId);
  assert.equal(receipt?.totalCount, 3);
  assert.equal(receipt?.omittedCount, 1);
  assert.deepEqual(receipt?.items.map(item => item.status), ['modified', 'renamed']);
  assert.equal(receipt?.items[1].oldPath, 'Movies/Old.iso');
  assert.deepEqual(await api.transactionItems(owner.token, receiptId), receipt);
  assert.equal(await api.transactionItems(jordan.token, receiptId), null);
  await api.markRead(avery.token, credited.notifications.map(item => item.id));
  assert.ok((await api.state(avery.token)).notifications.every(item => item.readAt !== null));
  const allInbox = await api.state(owner.token);
  await api.markRead(owner.token, [...allInbox.notifications, ...allInbox.computerNotifications].map(item => item.id));
  const readInbox = await api.state(owner.token);
  assert.ok([...readInbox.notifications, ...readInbox.computerNotifications].every(item => item.readAt !== null));
  await assert.rejects(api.redeemCredit(jordan.token, code), /already.*redeemed/i);
  const second = 'D'.repeat(43);
  await issue(second, 'report-2');
  await api.redeemCredit(owner.token, second, jordan.user.id);
  assert.equal((await api.state(jordan.token)).members[0].balanceCents, 45);
  const third = 'E'.repeat(43);
  await issue(third, 'report-3');
  assert.ok((await api.revokeFTSIssuer(owner.token, created.issuer.id)).revokedAt);
  assert.equal((await api.previewCredit(avery.token, third)).status, 'revoked');
  await assert.rejects(api.redeemCredit(avery.token, third), error => error instanceof APIError && error.status === 403);
});
