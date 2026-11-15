/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { APIError, PocketAPI } from '../src/data/api';
import { FTS_SERVER_UPDATE_MESSAGE, parseIssuer } from '../src/data/credits';
import { inboxDestination, inboxItems } from '../src/data/inbox';
import { parseFamilyState, parseHealth } from '../src/data/validation';
import type { ComputerNotification, FamilyState, InboxNotification } from '../src/data/models';

const parent = { id: 'parent-1', name: 'Parent', username: 'parent', role: 'parent' as const };
const child = { id: 'child-1', name: 'Avery', username: 'avery', role: 'child' as const };
const computer: ComputerNotification = { id: 'computer-note-1', issuerId: 'issuer-1', eventType: 'paired', title: 'Computer connected',
  body: 'Avery connected Desktop.', createdAt: '2026-11-15T12:05:00.000Z', readAt: null };
const balance: InboxNotification = { id: 'ledger-note-1', transactionId: 'tx-1', title: 'Earnings added', body: 'Avery earned $0.45.',
  createdAt: '2026-11-15T12:00:00.000Z', readAt: null };
const state: FamilyState = { user: parent, familyName: 'Test', members: [parent, child], transactions: [],
  notifications: [balance], computerNotifications: [computer], pushConfigured: false };
const issuer = { id: 'issuer-1', name: 'Desktop', priceCents: 15, createdAt: '2026-11-15T12:00:00.000Z', revokedAt: null };
const supported = { setupRequired: false, pushConfigured: false,
  capabilities: { fts: { setupCodeDigits: 8, childCanConnect: true, parentComputerLog: true } } };

test('computer notifications validate separately, default to empty for older servers, and never enter a child state', () => {
  assert.deepEqual(parseFamilyState(state), state);
  const older = { ...state, computerNotifications: undefined };
  assert.deepEqual(parseFamilyState(older).computerNotifications, []);
  for (const computerNotifications of [null, {}, [{ ...computer, eventType: 'unknown' }], [{ ...computer, issuerId: null }], [{ ...computer, readAt: 7 }]]) {
    assert.throws(() => parseFamilyState({ ...state, computerNotifications }));
  }
  assert.throws(() => parseFamilyState({ ...state, user: child, members: [child] }));
  assert.deepEqual(parseFamilyState({ ...older, user: child, members: [child] }).computerNotifications, []);
});

test('combined inbox sorts both event types, counts both unread types and routes computer activity to management', () => {
  const combined = inboxItems(state);
  assert.deepEqual(combined.map(item => item.id), [computer.id, balance.id]);
  assert.equal(combined.filter(item => !item.readAt).length, 2);
  assert.deepEqual(inboxDestination(combined[0]), { pathname: '/file-tracker' });
  assert.deepEqual(inboxDestination(combined[1]), { pathname: '/receipt/[id]', params: { id: balance.transactionId } });
  assert.deepEqual(state.computerNotifications, [computer]);
  assert.deepEqual(inboxItems(null), []);
});

test('computer owner and paired state are retained when available and older issuer responses stay readable', () => {
  assert.deepEqual(parseIssuer(issuer), issuer);
  const pending = { ...issuer, ownerId: child.id, ownerName: child.name, pairedAt: null };
  assert.deepEqual(parseIssuer(pending), pending);
  assert.equal(parseIssuer({ ...pending, pairedAt: computer.createdAt }).pairedAt, computer.createdAt);
  for (const patch of [{ ownerId: null }, { ownerName: '' }, { pairedAt: false }, { pairedAt: 'bad-date' }]) {
    assert.throws(() => parseIssuer({ ...pending, ...patch }));
  }
});

test('capability detection reports older servers without restricting a child based on their role', async () => {
  assert.deepEqual(parseHealth(supported), supported);
  assert.throws(() => parseHealth({ ...supported, capabilities: { fts: { setupCodeDigits: 8, childCanConnect: 'yes', parentComputerLog: true } } }));
  const make = (payload: unknown) => new PocketAPI('http://localhost:8787', async () => ({ status: 200, json: async () => payload }));
  assert.equal(await make({ setupRequired: false, pushConfigured: false }).checkFTSSupport(), false);
  assert.equal(await make(supported).checkFTSSupport(), true);
});

test('old FTS-only parent gates report a server update while unrelated authorization failures stay intact', async () => {
  const api = new PocketAPI('http://localhost:8787', async url => ({ status: url.endsWith('/revoke') ? 404 : 403,
    json: async () => ({ error: url.endsWith('/revoke') ? 'Computer not found.' : 'Only a parent can connect a file tracker.' }) }));
  await assert.rejects(api.createFTSIssuer('child-token', 'Desktop', 15), error => error instanceof APIError && error.status === 409 && error.message === FTS_SERVER_UPDATE_MESSAGE);
  await assert.rejects(api.listFTSIssuers('child-token'), error => error instanceof APIError && error.status === 409);
  await assert.rejects(api.revokeFTSIssuer('child-token', 'someone-else'), error => error instanceof APIError && error.status === 404);
  await assert.rejects(api.recordTransaction('child-token', { childId: child.id, kind: 'addition', amountCents: 15, merchant: 'Test', note: '', idempotencyKey: 'test-key' }),
    error => error instanceof APIError && error.status === 403);
  const expired = new PocketAPI('http://localhost:8787', async () => ({ status: 401, json: async () => ({ error: 'Sign in again.' }) }));
  await assert.rejects(expired.listFTSIssuers('expired'), error => error instanceof APIError && error.status === 401);
});

test('legacy long credential creation responses explain the update without exposing the credential', async () => {
  const api = new PocketAPI('http://localhost:8787', async () => ({ status: 200, json: async () => ({ issuer, token: 'secret-long-credential' }) }));
  await assert.rejects(api.createFTSIssuer('child-token', 'Desktop', 15), error => error instanceof APIError &&
    error.message === FTS_SERVER_UPDATE_MESSAGE && !error.message.includes('secret-long-credential'));
});
