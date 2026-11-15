/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('an integration key arriving after sign-out is rejected instead of being exposed to the next account', async () => {
  const pending = deferred<FetchResponse>();
  const started = deferred<void>();
  const current: FamilyState = { user: parent, members: [parent, child], familyName: 'Test', transactions: [], notifications: [], pushConfigured: false };
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
  pending.resolve(response({ issuer, token: `fts_${'A'.repeat(43)}` }));
  await rejection;
  assert.equal(controller.getSnapshot().state, null);
});

test('a child cannot create integration credentials or target a sibling through controller actions', async () => {
  let creditCalls = 0;
  const current: FamilyState = { user: child, members: [child], familyName: 'Test', transactions: [], notifications: [], pushConfigured: false };
  const controller = new PocketController(new Storage(), async url => {
    const path = new URL(url).pathname;
    if (path === '/health') return response({ setupRequired: false, pushConfigured: false });
    if (path === '/login') return response({ token: 'A'.repeat(43), user: child, familyName: 'Test' });
    if (path === '/state') return response(current);
    creditCalls++;
    return response({});
  });
  await controller.initialize(); await controller.signIn('child', 'child-password');
  await assert.rejects(controller.createFTSIssuer('Desktop', 15), /Only a parent/);
  await assert.rejects(controller.listFTSIssuers(), /Only a parent/);
  await assert.rejects(controller.revokeFTSIssuer('issuer-1'), /Only a parent/);
  await assert.rejects(controller.redeemCredit(code, 'sibling-1'), /only redeem earnings for yourself/);
  assert.equal(creditCalls, 0);
});

test('real API credits one recipient and parents, deduplicates repeated redemption and supports issuer revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-mobile-credit-'));
  const app = createFamilyServer({ dbPath: join(directory, 'test.sqlite') });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = new PocketAPI(url, (value, options) => fetch(value, options));
  const owner = await api.setup({ familyName: 'Test', name: 'Parent', username: 'parent', password: 'parent-password', setupCode: app.store.setupCode });
  await api.addMember(owner.token, { name: 'Avery', username: 'avery', role: 'child', password: 'child-password' });
  await api.addMember(owner.token, { name: 'Jordan', username: 'jordan', role: 'child', password: 'child-password' });
  const avery = await api.signIn('avery', 'child-password');
  const jordan = await api.signIn('jordan', 'child-password');
  const created = await api.createFTSIssuer(owner.token, 'FTS Desktop', 15);
  assert.equal((await api.listFTSIssuers(owner.token))[0].id, created.issuer.id);
  async function issue(value: string, id: string) {
    const result = await fetch(`${url}/fts/vouchers`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` },
      body: JSON.stringify({ code: value, reports: [{ reportId: id, movieCount: 3, priceCents: 15 }] }) });
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
