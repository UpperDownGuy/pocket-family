/// <reference types="node" />
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createFamilyServer } from '../../server/index.mjs';
import { APIError, PocketAPI, type FetchOptions, type FetchResponse } from '../src/data/api';
import { PocketController, type SessionStorage } from '../src/data/controller';
import type { FamilyState, ServerHealth } from '../src/data/models';
import { FAMILY_DELETE_UPDATE_MESSAGE, parseHealth } from '../src/data/validation';

const serverURL = 'http://127.0.0.1:8787';
const alpha = { id: 'alpha-parent', name: 'Parent A', username: 'alpha', role: 'parent' as const };
const beta = { id: 'beta-parent', name: 'Parent B', username: 'beta', role: 'parent' as const };
const child = { id: 'alpha-child', name: 'Child', username: 'child', role: 'child' as const };
const alphaAuth = { token: 'A'.repeat(43), user: alpha, familyName: 'Alpha', familyCode: '00123456' };
const betaAuth = { token: 'B'.repeat(43), user: beta, familyName: 'Beta', familyCode: '00223456' };
const childAuth = { ...alphaAuth, token: 'C'.repeat(43), user: child };
const auths = [alphaAuth, betaAuth, childAuth];
const health: ServerHealth = { setupRequired: false, pushConfigured: false, capabilities: { families: { multiple: true, registration: true, deletion: true } } };
const context = { serverURL, userId: alpha.id, familyCode: alphaAuth.familyCode };
const payment = { childId: child.id, kind: 'addition' as const, amountCents: 30, merchant: 'Allowance', note: '', idempotencyKey: 'unconfirmed-payment' };
function response(value: unknown, status = 200): FetchResponse { return { status, async json() { return value; } }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
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
async function fixture(hook: Hook = async () => undefined, username = 'alpha') {
  const storage = new Storage();
  const calls: { path: string; options: FetchOptions }[] = [];
  const controller = new PocketController(storage, async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, options });
    const override = await hook(path, options);
    if (override) return override;
    if (path === '/health') return response(health);
    if (path === '/login') return response(auths.find(auth => auth.user.username === JSON.parse(options.body!).username)!);
    if (path === '/state') {
      const auth = auths.find(auth => `Bearer ${auth.token}` === options.headers.Authorization)!;
      const state: FamilyState = { user: auth.user, familyName: auth.familyName, familyCode: auth.familyCode,
        members: auth.familyCode === alphaAuth.familyCode ? [alpha, child] : [beta],
        transactions: [], notifications: [], computerNotifications: [], pushConfigured: false };
      return response(state);
    }
    return response({ ok: true });
  });
  await controller.initialize();
  await controller.signIn(username, 'password');
  return { controller, storage, calls };
}

test('deletion capability is optional for older servers but must be boolean when supplied', () => {
  assert.equal(parseHealth(health).capabilities?.families?.deletion, true);
  assert.equal(parseHealth({ ...health, capabilities: { families: { multiple: true, registration: true } } }).capabilities?.families?.deletion, undefined);
  assert.throws(() => parseHealth({ ...health, capabilities: { families: { multiple: true, registration: true, deletion: 'yes' } } }));
});

test('delete API sends authenticated DELETE with exact confirmation and preserves leading zeros', async () => {
  const calls: { url: string; options: FetchOptions }[] = [];
  const api = new PocketAPI(serverURL, async (url, options) => { calls.push({ url, options }); return response({ ok: true }); });
  await api.deleteFamily(alphaAuth.token, alphaAuth.familyCode);
  assert.equal(calls[0].url, `${serverURL}/family`);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${alphaAuth.token}`);
  assert.deepEqual(JSON.parse(calls[0].options.body!), { confirmation: 'DELETE-FAMILY', familyCode: '00123456' });
  await assert.rejects(api.deleteFamily(alphaAuth.token, '123'), /eight-digit/);
  assert.equal(calls.length, 1);
  for (const status of [404, 405]) {
    const old = new PocketAPI(serverURL, async () => response({ error: 'Not found' }, status));
    await assert.rejects(old.deleteFamily(alphaAuth.token, alphaAuth.familyCode), error => error instanceof APIError && error.message === FAMILY_DELETE_UPDATE_MESSAGE);
  }
  const unconfirmed = new PocketAPI(serverURL, async () => response({ ok: false }));
  await assert.rejects(unconfirmed.deleteFamily(alphaAuth.token, alphaAuth.familyCode), /did not confirm/);
});

test('children, stale confirmation contexts and older servers cannot send a deletion request', async () => {
  const childFixture = await fixture(undefined, 'child');
  await assert.rejects(childFixture.controller.deleteFamily({ ...context, userId: child.id }), /Only a parent/);
  assert.equal(childFixture.calls.some(call => call.path === '/family'), false);
  const current = await fixture();
  for (const stale of [{ ...context, userId: beta.id }, { ...context, familyCode: betaAuth.familyCode }, { ...context, serverURL: 'https://other.example' }]) {
    await assert.rejects(current.controller.deleteFamily(stale), /account changed/);
  }
  assert.equal(current.calls.some(call => call.path === '/family'), false);
  const older = await fixture(async path => path === '/health' ? response({ setupRequired: false, pushConfigured: false }) : undefined);
  await assert.rejects(older.controller.deleteFamily(context), error => error instanceof Error && error.message === FAMILY_DELETE_UPDATE_MESSAGE);
  assert.equal(older.calls.some(call => call.path === '/family'), false);
  assert.equal(older.controller.getSnapshot().signedIn, true);
  assert.equal(older.storage.tokens.get(serverURL), alphaAuth.token);
});

test('confirmed deletion clears the session, family hint, and only the deleted family retry state', async () => {
  const { controller, storage } = await fixture(async path => {
    if (path === '/transactions') throw new Error('Lost reply');
    return undefined;
  });
  await assert.rejects(controller.recordTransaction(payment), /Could not reach/);
  assert.equal(controller.getSnapshot().pendingTransaction?.idempotencyKey, payment.idempotencyKey);
  await controller.deleteFamily(context);
  assert.equal(controller.getSnapshot().signedIn, false);
  assert.equal(controller.getSnapshot().state, null);
  assert.equal(controller.getSnapshot().familyCodeHint, '');
  assert.equal(controller.getSnapshot().pendingTransaction, null);
  assert.equal(storage.tokens.has(serverURL), false);
  // Reusing the fixture identity exposes any forgotten per-account retry cache.
  await controller.signIn('alpha', 'password');
  assert.equal(controller.getSnapshot().pendingTransaction, null);
  await controller.deleteFamily(context);
  await controller.changeServer('https://other.example');
  await controller.changeServer(serverURL);
  assert.equal(controller.getSnapshot().familyCodeHint, '');
});

test('failed deletion retains the session, family hint and retry state; normal 401 still signs out', async () => {
  for (const status of [403, 409, 500, 0, 401]) {
    const { controller, storage } = await fixture(async path => {
      if (path === '/transactions') throw new Error('Lost payment reply');
      if (path === '/family') {
        if (!status) throw new Error('Connection lost');
        return response({ error: 'Deletion rejected' }, status);
      }
      return undefined;
    });
    await assert.rejects(controller.recordTransaction(payment));
    await assert.rejects(controller.deleteFamily(context));
    assert.equal(controller.getSnapshot().familyCodeHint, alphaAuth.familyCode);
    assert.equal(controller.getSnapshot().signedIn, status !== 401);
    assert.equal(storage.tokens.has(serverURL), status !== 401);
    if (status !== 401) {
      assert.equal(controller.getSnapshot().state?.familyName, 'Alpha');
      assert.equal(controller.getSnapshot().pendingTransaction?.idempotencyKey, payment.idempotencyKey);
    }
  }
});

test('a capability response after account switch cannot start deletion', async () => {
  const held = deferred<FetchResponse>();
  const started = deferred<void>();
  let hold = false;
  const { controller, calls } = await fixture(async path => {
    if (hold && path === '/health') { started.resolve(); return held.promise; }
    return undefined;
  });
  hold = true;
  const deleting = controller.deleteFamily(context);
  await started.promise;
  await controller.signIn('beta', 'password');
  held.resolve(response(health));
  await assert.rejects(deleting, /replaced/);
  assert.equal(calls.some(call => call.path === '/family'), false);
  assert.equal(controller.getSnapshot().state?.familyName, 'Beta');
});

test('late deletion success or rejection cannot clear another account or server session', async () => {
  for (const target of ['account', 'server'] as const) for (const status of [200, 401, 500]) {
    const held = deferred<FetchResponse>();
    const started = deferred<void>();
    const { controller, storage } = await fixture(async path => {
      if (path === '/family') { started.resolve(); return held.promise; }
      return undefined;
    });
    const deleting = controller.deleteFamily(context);
    await started.promise;
    const nextServer = target === 'server' ? 'https://other.example' : serverURL;
    if (target === 'server') await controller.changeServer(nextServer);
    await controller.signIn('beta', 'password');
    held.resolve(response(status === 200 ? { ok: true } : { error: 'Rejected' }, status));
    await assert.rejects(deleting);
    assert.equal(controller.getSnapshot().serverURL, nextServer);
    assert.equal(controller.getSnapshot().state?.familyName, 'Beta');
    assert.equal(controller.getSnapshot().familyCodeHint, betaAuth.familyCode);
    assert.equal(controller.getSnapshot().signedIn, true);
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(storage.tokens.get(nextServer), betaAuth.token);
  }
});

test('a refresh discovering the deleted session before DELETE replies cannot retain its family hint', async () => {
  const held = deferred<FetchResponse>();
  const started = deferred<void>();
  let deleted = false;
  const { controller, storage } = await fixture(async path => {
    if (path === '/family') { deleted = true; started.resolve(); return held.promise; }
    if (path === '/state' && deleted) return response({ error: 'Session expired' }, 401);
    return undefined;
  });
  const deleting = controller.deleteFamily(context);
  await started.promise;
  await controller.refresh();
  assert.equal(controller.getSnapshot().signedIn, false);
  held.resolve(response({ ok: true }));
  await assert.rejects(deleting, /replaced/);
  assert.equal(controller.getSnapshot().familyCodeHint, '');
  assert.equal(storage.tokens.has(serverURL), false);
});

test('real API deletion signs out its parent and leaves another family usable', async t => {
  const app = createFamilyServer({ dbPath: ':memory:' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = new PocketAPI(url, (target, options) => fetch(target, options));
  const input = { name: 'Parent', username: 'parent', password: 'parent-password' };
  const a = await api.createFamily({ ...input, familyName: 'Alpha' });
  const b = await api.createFamily({ ...input, familyName: 'Beta' });
  const storage = new Storage(); storage.server = url;
  const controller = new PocketController(storage, (target, options) => fetch(target, options));
  await controller.initialize();
  await controller.signIn(input.username, input.password, a.familyCode);
  await controller.deleteFamily({ serverURL: url, userId: a.user.id, familyCode: a.familyCode! });
  assert.equal(controller.getSnapshot().state, null);
  assert.equal(controller.getSnapshot().familyCodeHint, '');
  assert.equal(storage.tokens.has(url), false);
  await assert.rejects(api.state(a.token), error => error instanceof APIError && error.status === 401);
  assert.equal((await api.state(b.token)).familyName, 'Beta');
  await controller.signIn(input.username, input.password, b.familyCode);
  assert.equal(controller.getSnapshot().state?.familyName, 'Beta');
});
