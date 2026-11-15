/// <reference types="node" />
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createFamilyServer } from '../../server/index.mjs';
import { PocketAPI } from '../src/data/api';
import type { FetchOptions, FetchResponse, FetchTransport } from '../src/data/api';
import { PocketController } from '../src/data/controller';
import type { SessionStorage } from '../src/data/controller';
import type { FamilyState } from '../src/data/models';
import { centsFromInput, DEFAULT_SERVER_URL, money, parseFamilyState, validateServerURL } from '../src/data/validation';

const tokenA = 'A'.repeat(43);
const tokenB = 'B'.repeat(43);
const parent = { id: 'parent-1', name: 'Parent', username: 'parent', role: 'parent' as const };
const child = { id: 'child-1', name: 'Child', username: 'child', role: 'child' as const, balanceCents: 1000 };
function state(balanceCents = 1000): FamilyState {
  return { user: parent, familyName: 'Family', members: [parent, { ...child, balanceCents }], transactions: [], notifications: [], computerNotifications: [], pushConfigured: false };
}
function response(payload: unknown, status = 200): FetchResponse { return { status, async json() { return payload; } }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Expected async operation did not start.');
}

class MemoryStorage implements SessionStorage {
  serverURL: string | null = null;
  tokens = new Map<string, string>();
  beforeSetToken: (() => Promise<void>) | null = null;
  async getServerURL() { return this.serverURL; }
  async setServerURL(url: string) { this.serverURL = url; }
  async getToken(server: string) { return this.tokens.get(server) ?? null; }
  async setToken(server: string, token: string) {
    await this.beforeSetToken?.();
    this.tokens.set(server, token);
  }
  async removeToken(server: string) { this.tokens.delete(server); }
}

function fixture() {
  const storage = new MemoryStorage();
  const calls: { url: string; options: FetchOptions }[] = [];
  const handlers: {
    state?: (url: string, options: FetchOptions) => Promise<FetchResponse>;
    login?: () => Promise<FetchResponse>;
  } = {};
  const transport: FetchTransport = async (url, options) => {
    calls.push({ url, options });
    switch (new URL(url).pathname) {
      case '/health': return response({ setupRequired: false, pushConfigured: false });
      case '/login': return handlers.login ? handlers.login() : response({ token: tokenA, user: parent, familyName: 'Family' });
      case '/state': return handlers.state ? handlers.state(url, options) : response(state());
      default: return response({ ok: true });
    }
  };
  return { storage, calls, handlers, controller: new PocketController(storage, transport) };
}

test('server validation accepts local development addresses and rejects disguised public HTTP addresses', () => {
  for (const url of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://192.168.1.2:8787', 'http://10.0.0.2',
    'http://172.16.1.4', 'http://172.31.255.254', 'http://family.local:8787', 'http://[::1]:8787', 'http://[fd00::1]', 'https://family.example']) {
    assert.ok(validateServerURL(url), url);
  }
  for (const url of ['http://192.foo.168.1.1', 'http://192..168.1.1', 'http://172.32.0.1', 'http://8.8.8.8',
    'http://localhost.evil.example', 'http://2130706433', 'http://127.1', 'http://0177.0.0.1', 'http://127.0.0.01',
    'https://user:password@example.com', 'https://example.com/private', 'https://example.com?token=secret',
    'https://example.com/#fragment', 'https://example.com\\@localhost', 'file:///tmp', 'https://%65xample.com']) {
    assert.throws(() => validateServerURL(url), /Use an HTTPS server address/, url);
  }
  assert.equal(validateServerURL(' HTTPS://EXAMPLE.COM:443/ '), 'https://example.com');
});

test('money parsing preserves cents and rejects overflow, extra decimals, and negative amounts', () => {
  const examples: [string, number | null][] = [
    ['0.01', 1], ['0.29', 29], ['7.5', 750], ['7,50', 750], [' 12.34 ', 1234],
    ['9999.99', 999999], ['10000.00', 1000000], ['10000.01', null], ['0', null],
    ['-1.00', null], ['1.001', null], ['1e3', null], ['1,000', null], ['Infinity', null],
    ['9'.repeat(1000), null], ['', null], ['0.001', null], ['.50', null],
  ];
  for (const [input, expected] of examples) assert.equal(centsFromInput(input), expected, input);
  assert.equal(money(123456), '$1,234.56');
});

test('family response validation rejects missing privacy-scoped arrays and fractional balances', () => {
  assert.deepEqual(parseFamilyState(state()), state());
  assert.throws(() => parseFamilyState({ ...state(), notifications: null }));
  assert.throws(() => parseFamilyState({ ...state(), members: [{ ...child, balanceCents: 12.5 }] }));
});

test('API omits cookies, refuses redirects, and surfaces server errors without exposing credentials', async () => {
  let observed: FetchOptions | undefined;
  const api = new PocketAPI(DEFAULT_SERVER_URL, async (_url, options) => {
    observed = options;
    return response({ error: 'Incorrect username or password.' }, 401);
  });
  await assert.rejects(api.signIn('parent', 'test-password'), /Incorrect username or password/);
  assert.equal(observed?.credentials, 'omit');
  assert.equal(observed?.redirect, 'manual');
  assert.equal(observed?.headers.Authorization, undefined);
  const redirected = new PocketAPI(DEFAULT_SERVER_URL, async () => response({}, 307));
  await assert.rejects(redirected.state(tokenA), /direct address/);
});

test('real HTTP redirect never forwards the bearer token to another endpoint', async () => {
  let targetRequests = 0;
  const target = createServer((_req, res) => { targetRequests++; res.end('{}'); });
  const source = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/stolen` }); res.end(); });
  const listen = (server: Server) => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await listen(target);
  await listen(source);
  try {
    const api = new PocketAPI(`http://127.0.0.1:${(source.address() as AddressInfo).port}`, (url, options) => fetch(url, options));
    await assert.rejects(api.state(tokenA), /direct address/);
    assert.equal(targetRequests, 0);
  } finally { await Promise.all([close(source), close(target)]); }
});

test('newer refresh wins over an older response or unauthorized error', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.controller.signIn('parent', 'test-password');
  const pending: ReturnType<typeof deferred<FetchResponse>>[] = [];
  f.handlers.state = async () => { const next = deferred<FetchResponse>(); pending.push(next); return next.promise; };
  const first = f.controller.refresh();
  const second = f.controller.refresh();
  await until(() => pending.length === 2);
  pending[1].resolve(response(state(2222)));
  await second;
  pending[0].resolve(response({ error: 'Expired old response.' }, 401));
  await first;
  assert.equal(f.controller.getSnapshot().state?.members[1].balanceCents, 2222);
  assert.equal(f.controller.getSnapshot().signedIn, true);
  assert.equal(f.controller.getSnapshot().error, null);
});

test('sign-out clears storage immediately and a late state response cannot restore the account', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.controller.signIn('parent', 'test-password');
  const late = deferred<FetchResponse>();
  f.handlers.state = () => late.promise;
  const refresh = f.controller.refresh();
  await f.controller.signOut();
  late.resolve(response(state(9999)));
  await refresh;
  assert.equal(f.controller.getSnapshot().signedIn, false);
  assert.equal(f.controller.getSnapshot().state, null);
  assert.equal(f.storage.tokens.size, 0);
});

test('late sign-in is revoked after sign-out and never persists a token', async () => {
  const f = fixture();
  await f.controller.initialize();
  const late = deferred<FetchResponse>();
  f.handlers.login = () => late.promise;
  const login = assert.rejects(f.controller.signIn('parent', 'test-password'), /replaced/);
  await until(() => f.calls.some(call => call.url.endsWith('/login')));
  await f.controller.signOut();
  late.resolve(response({ token: tokenA, user: parent, familyName: 'Family' }));
  await login;
  assert.equal(f.controller.getSnapshot().signedIn, false);
  assert.equal(f.storage.tokens.size, 0);
  assert.ok(f.calls.some(call => call.url.endsWith('/logout') && call.options.headers.Authorization === `Bearer ${tokenA}`));
});

test('sign-out during secure token write cannot leave a saved session behind', async () => {
  const f = fixture();
  await f.controller.initialize();
  const write = deferred<void>();
  let writing = false;
  f.storage.beforeSetToken = async () => { writing = true; await write.promise; };
  const login = assert.rejects(f.controller.signIn('parent', 'test-password'), /replaced/);
  await until(() => writing);
  const logout = f.controller.signOut();
  write.resolve();
  await Promise.all([login, logout]);
  assert.equal(f.storage.tokens.size, 0);
  assert.equal(f.controller.getSnapshot().signedIn, false);
  assert.ok(f.calls.some(call => call.url.endsWith('/logout') && call.options.headers.Authorization === `Bearer ${tokenA}`));
});

test('expired current sessions clear the local sign-in and report the server error', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.controller.signIn('parent', 'test-password');
  f.handlers.state = async () => response({ error: 'Your session has expired.' }, 401);
  await f.controller.refresh();
  assert.equal(f.controller.getSnapshot().signedIn, false);
  assert.equal(f.controller.getSnapshot().state, null);
  assert.equal(f.controller.getSnapshot().error, 'Your session has expired.');
  assert.equal(f.storage.tokens.size, 0);
});

test('server switching scopes tokens to each origin and removes the previous session', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.controller.signIn('parent', 'test-password');
  const otherServer = 'http://192.168.1.20:8787';
  f.storage.tokens.set(otherServer, tokenB);
  await f.controller.changeServer(otherServer);
  assert.equal(f.storage.serverURL, otherServer);
  assert.equal(f.storage.tokens.has(DEFAULT_SERVER_URL), false);
  assert.equal(f.controller.getSnapshot().serverURL, otherServer);
  assert.ok(f.calls.some(call => call.url === `${otherServer}/state` && call.options.headers.Authorization === `Bearer ${tokenB}`));
  assert.ok(!f.calls.some(call => call.url.startsWith(otherServer) && call.options.headers.Authorization === `Bearer ${tokenA}`));
});

test('read-all batches remain below the server JSON size limit', async () => {
  const f = fixture();
  await f.controller.initialize();
  await f.controller.signIn('parent', 'test-password');
  const ids = Array.from({ length: 250 }, (_, i) => String(i).padEnd(80, 'x'));
  await f.controller.markRead(ids);
  const requests = f.calls.filter(call => call.url.endsWith('/notifications/read'));
  assert.deepEqual(requests.map(call => JSON.parse(call.options.body!).ids.length), [100, 100, 50]);
  requests.forEach(call => assert.ok(Buffer.byteLength(call.options.body!) < 16384));
});

test('Expo controller works against the real family API with isolated child inboxes', async () => {
  const options = { dbPath: ':memory:', setupCode: 'client-integration-test' };
  const app = createFamilyServer(options);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const serverURL = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const storage = new MemoryStorage();
  storage.serverURL = serverURL;
  const transport: FetchTransport = (url, options) => fetch(url, options);
  const controller = new PocketController(storage, transport);
  const api = new PocketAPI(serverURL, transport);
  try {
    await controller.initialize();
    assert.equal(controller.getSnapshot().setupRequired, true);
    await controller.setup({ familyName: 'Test family', name: 'Parent One', username: 'parent-one', password: 'parent-password-1', setupCode: 'client-integration-test' });
    await controller.addMember({ name: 'Parent Two', username: 'parent-two', password: 'parent-password-2', role: 'parent' });
    await controller.addMember({ name: 'Child One', username: 'child-one', password: 'child-password-1', role: 'child' });
    await controller.addMember({ name: 'Child Two', username: 'child-two', password: 'child-password-2', role: 'child' });
    const childID = controller.getSnapshot().state!.members.find(member => member.username === 'child-one')!.id;
    await controller.recordTransaction({ childId: childID, kind: 'addition', amountCents: 10000, merchant: 'Allowance', note: '', idempotencyKey: 'client-test-addition' });
    await controller.signOut();
    await controller.signIn('child-one', 'child-password-1');
    assert.equal(controller.getSnapshot().state!.members.length, 1);
    const purchase = { childId: childID, kind: 'purchase' as const, amountCents: 700, merchant: 'Bookshop', note: 'Notebook', idempotencyKey: 'client-test-purchase' };
    await controller.recordTransaction(purchase);
    await controller.recordTransaction(purchase);
    assert.equal(controller.getSnapshot().state!.members[0].balanceCents, 9300);
    assert.equal(controller.getSnapshot().state!.transactions.length, 2);
    assert.equal(controller.getSnapshot().state!.notifications.length, 2);
    await assert.rejects(controller.recordTransaction({ ...purchase, kind: 'addition', idempotencyKey: 'not-allowed-addition' }), /own purchases/);
    await controller.markRead(controller.getSnapshot().state!.notifications.map(note => note.id));
    assert.ok(controller.getSnapshot().state!.notifications.every(note => note.readAt !== null));
    const secondParent = await api.signIn('parent-two', 'parent-password-2');
    assert.equal((await api.state(secondParent.token)).notifications.filter(note => note.readAt === null).length, 2);
    const sibling = await api.signIn('child-two', 'child-password-2');
    const siblingState = await api.state(sibling.token);
    assert.equal(siblingState.notifications.length, 0);
    assert.equal(siblingState.transactions.length, 0);
    assert.equal(siblingState.members.length, 1);
  } finally { await app.close(); }
});

test('committed setup with a lost response restores sign-in mode and preserves the original error', async () => {
  const options = { dbPath: ':memory:', setupCode: 'setup-recovery-test' };
  const app = createFamilyServer(options);
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const serverURL = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const storage = new MemoryStorage();
  storage.serverURL = serverURL;
  const transport: FetchTransport = async (url, request) => {
    const result = await fetch(url, request);
    if (new URL(url).pathname === '/setup') {
      // The real server has committed the family. Simulate losing its response
      // before the client receives the new session token.
      await result.json();
      throw new DOMException('Setup response timed out.', 'TimeoutError');
    }
    return result;
  };
  const controller = new PocketController(storage, transport);
  try {
    await controller.initialize();
    assert.equal(controller.getSnapshot().setupRequired, true);
    await assert.rejects(controller.setup({ familyName: 'Recovered family', name: 'Parent', username: 'parent', password: 'parent-password-1', setupCode: 'setup-recovery-test' }), /Could not reach the family server/);
    assert.equal(controller.getSnapshot().setupRequired, false);
    assert.equal(controller.getSnapshot().signedIn, false);
    assert.equal(controller.getSnapshot().error, 'Could not reach the family server. Check its address and your connection.');
    assert.equal(storage.tokens.size, 0);
    await controller.signIn('parent', 'parent-password-1');
    assert.equal(controller.getSnapshot().state?.familyName, 'Recovered family');
  } finally { await app.close(); }
});
