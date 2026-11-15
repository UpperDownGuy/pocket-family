/// <reference types="node" />
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createFamilyServer } from '../../server/index.mjs';
import { APIError, PocketAPI, type FetchOptions, type FetchResponse } from '../src/data/api';
import { PocketController, type SessionStorage } from '../src/data/controller';
import type { FamilyState } from '../src/data/models';
import { FAMILY_UPDATE_MESSAGE, parseAuth, parseFamilyCode, parseFamilyState, parseHealth } from '../src/data/validation';

const parent = { id: 'parent-one', name: 'Parent', username: 'parent', role: 'parent' as const };
const input = { familyName: 'Our family', name: 'Parent', username: 'parent', password: 'parent-password' };
const auth = { token: 'A'.repeat(43), user: parent, familyName: 'Our family', familyCode: '00123456' };
const health = { setupRequired: false, pushConfigured: false, capabilities: { families: { multiple: true, registration: true } } };
const family: FamilyState = { user: parent, familyName: auth.familyName, familyCode: auth.familyCode, members: [parent], transactions: [], notifications: [], computerNotifications: [], pushConfigured: false };
function response(value: unknown, status = 200): FetchResponse { return { status, async json() { return value; } }; }
class Storage implements SessionStorage {
  serverURL = 'http://127.0.0.1:8787';
  token: string | null = null;
  async getServerURL() { return this.serverURL; }
  async setServerURL(value: string) { this.serverURL = value; }
  async getToken() { return this.token; }
  async setToken(_server: string, value: string) { this.token = value; }
  async removeToken() { this.token = null; }
}

test('family codes are eight ASCII digits with leading zeros, while old responses stay compatible', () => {
  assert.equal(parseFamilyCode('00123456'), '00123456');
  for (const value of [12345678, null, '', '1234567', '123456789', 'abcdefgh', '１２３４５６７８', ' 00123456']) assert.throws(() => parseFamilyCode(value));
  assert.equal(parseAuth(auth).familyCode, '00123456');
  assert.equal(parseFamilyState(family).familyCode, '00123456');
  assert.throws(() => parseAuth({ ...auth, familyCode: 12345678 }));
  assert.throws(() => parseFamilyState({ ...family, familyCode: 'short' }));
  assert.equal(parseAuth({ ...auth, familyCode: undefined }).familyCode, undefined);
  assert.equal(parseFamilyState({ ...family, familyCode: undefined }).familyCode, undefined);
  assert.deepEqual(parseHealth(health).capabilities?.families, { multiple: true, registration: true });
  assert.throws(() => parseHealth({ ...health, capabilities: { families: { multiple: true, registration: 'yes' } } }));
});

test('registration and family-code login use their exact public endpoints without setup fallback', async () => {
  const calls: { path: string; options: FetchOptions }[] = [];
  const api = new PocketAPI('http://127.0.0.1:8787', async (url, options) => { calls.push({ path: new URL(url).pathname, options }); return response(auth); });
  assert.equal((await api.createFamily(input)).familyCode, auth.familyCode);
  await api.signIn('parent', 'password', '00123456');
  await api.signIn('parent', 'password');
  assert.deepEqual(calls.map(item => item.path), ['/families', '/login', '/login']);
  assert.deepEqual(JSON.parse(calls[0].options.body!), input);
  assert.equal(JSON.parse(calls[1].options.body!).familyCode, '00123456');
  assert.equal('familyCode' in JSON.parse(calls[2].options.body!), false);
  assert.ok(calls.every(item => !item.options.headers.Authorization));
  await assert.rejects(api.signIn('parent', 'password', '123'), /eight-digit/);
  assert.equal(calls.length, 3);
  const missing = new PocketAPI('http://127.0.0.1:8787', async () => response({ error: 'Not found' }, 404));
  await assert.rejects(missing.createFamily(input), error => error instanceof APIError && error.message === FAMILY_UPDATE_MESSAGE);
});

test('an older server permits its initial setup and legacy login but additional-family creation never posts', async () => {
  const paths: string[] = [];
  const controller = new PocketController(new Storage(), async url => {
    const path = new URL(url).pathname; paths.push(path);
    if (path === '/health') return response({ setupRequired: true, pushConfigured: false });
    if (path === '/setup' || path === '/login') return response({ ...auth, familyCode: undefined });
    if (path === '/state') return response({ ...family, familyCode: undefined });
    return response({ ok: true });
  });
  await controller.initialize();
  assert.equal(controller.getSnapshot().familyRegistrationAvailable, false);
  await assert.rejects(controller.createFamily(input), error => error instanceof Error && error.message === FAMILY_UPDATE_MESSAGE);
  assert.equal(paths.includes('/families'), false);
  assert.equal(paths.includes('/setup'), false);
  await controller.setup({ ...input, setupCode: 'legacy-code' });
  assert.equal(controller.getSnapshot().state?.familyName, input.familyName);
  await controller.signOut(); await controller.signIn('parent', 'parent-password');
  assert.equal(controller.getSnapshot().familyCodeHint, '');
});

test('registration arriving after sign-out is revoked and never restores family state or its code hint', async () => {
  let release!: (result: FetchResponse) => void;
  let started = false;
  let revoked = false;
  const pending = new Promise<FetchResponse>(resolve => { release = resolve; });
  const controller = new PocketController(new Storage(), async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return response(health);
    if (path === '/families') { started = true; return pending; }
    if (path === '/logout' && options.headers.Authorization) revoked = true;
    return response({ ok: true });
  });
  await controller.initialize();
  const registering = controller.createFamily(input);
  for (let i = 0; i < 100 && !started; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(started, true);
  await controller.signOut();
  release(response(auth));
  await assert.rejects(registering, /replaced/);
  assert.equal(revoked, true);
  assert.equal(controller.getSnapshot().state, null);
  assert.equal(controller.getSnapshot().familyCodeHint, '');
});

test('a registration capability check cannot continue after a server or session change', async () => {
  let hold = false;
  let release!: (result: FetchResponse) => void;
  const pending = new Promise<FetchResponse>(resolve => { release = resolve; });
  let registrations = 0;
  const controller = new PocketController(new Storage(), async url => {
    const path = new URL(url).pathname;
    if (path === '/health') return hold ? pending : response(health);
    if (path === '/families') registrations++;
    return response({ ok: true });
  });
  await controller.initialize(); hold = true;
  const registering = controller.createFamily(input);
  await controller.signOut(); release(response(health));
  await assert.rejects(registering, /replaced/);
  assert.equal(registrations, 0);
});

test('two real families can use identical usernames without sharing members, payments, inboxes or cached state', async t => {
  const app = createFamilyServer({ dbPath: ':memory:' });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = new PocketAPI(url, (target, options) => fetch(target, options));
  const alpha = await api.createFamily({ ...input, familyName: 'Alpha' });
  const beta = await api.createFamily({ ...input, familyName: 'Beta' });
  assert.match(alpha.familyCode!, /^[0-9]{8}$/);
  assert.notEqual(alpha.familyCode, beta.familyCode);
  await api.addMember(alpha.token, { name: 'Avery', username: 'kid', password: 'kid-password', role: 'child' });
  await api.addMember(beta.token, { name: 'Jordan', username: 'kid', password: 'kid-password', role: 'child' });
  const childA = await api.signIn('kid', 'kid-password', alpha.familyCode);
  const childB = await api.signIn('kid', 'kid-password', beta.familyCode);
  await api.recordTransaction(alpha.token, { childId: childA.user.id, kind: 'addition', amountCents: 30, merchant: 'Allowance', note: '', idempotencyKey: 'alpha-payment' });
  assert.equal((await api.state(childA.token)).transactions.length, 1);
  assert.equal((await api.state(childB.token)).transactions.length, 0);
  assert.equal((await api.state(childB.token)).notifications.length, 0);
  const storage = new Storage(); storage.serverURL = url;
  const controller = new PocketController(storage, (target, options) => fetch(target, options));
  await controller.initialize();
  await controller.signIn('parent', 'parent-password', alpha.familyCode);
  assert.equal(controller.getSnapshot().state?.familyName, 'Alpha');
  const next = controller.signIn('parent', 'parent-password', beta.familyCode);
  assert.equal(controller.getSnapshot().state, null);
  await next;
  assert.equal(controller.getSnapshot().state?.familyName, 'Beta');
  assert.equal(controller.getSnapshot().state?.transactions.length, 0);
  assert.equal(controller.getSnapshot().familyCodeHint, beta.familyCode);
  assert.ok(controller.getSnapshot().state?.members.every(member => member.id !== childA.user.id));
  await controller.signOut();
  assert.equal(controller.getSnapshot().state, null);
});
