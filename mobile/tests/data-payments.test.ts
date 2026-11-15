/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { APIError, PocketAPI, type FetchResponse } from '../src/data/api';
import { PocketController, type SessionStorage } from '../src/data/controller';
import type { FamilyState, LedgerTransaction } from '../src/data/models';
import { parseReceiptItems, paymentAttempt, receivedPayments } from '../src/data/payments';

const child = { id: 'kid-a', name: 'Avery', username: 'avery', role: 'child' as const };
const parent = { id: 'parent-a', name: 'Parent', username: 'parent', role: 'parent' as const };
const payment: LedgerTransaction = { id: 'payment-a', childId: child.id, childName: child.name, kind: 'addition', amountCents: 30, merchant: 'File edits', note: '', createdAt: '2026-11-12T12:00:00Z' };
const note = { id: 'note-a', transactionId: payment.id, title: 'Payment received', body: '', createdAt: payment.createdAt, readAt: null };
function state(): FamilyState { return { user: child, members: [child], familyName: 'Family', transactions: [payment], notifications: [note], computerNotifications: [], pushConfigured: false }; }
function response(payload: unknown, status = 200): FetchResponse { return { status, async json() { return payload; } }; }
class Storage implements SessionStorage {
  async getServerURL() { return 'http://127.0.0.1:8787'; }
  async setServerURL() {}
  async getToken() { return null; }
  async setToken() {}
  async removeToken() {}
}

test('a child gets one group of unread additions, including weekend payments, without sibling or purchase data', () => {
  const value = state();
  value.transactions.push({ ...payment, id: 'purchase', kind: 'purchase' }, { ...payment, id: 'sibling', childId: 'kid-b' }, { ...payment, id: 'second', amountCents: 45 });
  value.notifications.push({ ...note, id: 'buy-note', transactionId: 'purchase' }, { ...note, id: 'other-note', transactionId: 'sibling' }, { ...note, id: 'second-note', transactionId: 'second' }, { ...note, id: 'duplicate-note' });
  const group = receivedPayments(value)!;
  assert.equal(group.amountCents, 75);
  assert.deepEqual(group.transactions.map(item => item.id), ['payment-a', 'second']);
  assert.deepEqual(group.notificationIds, ['note-a', 'second-note', 'duplicate-note']);
  assert.deepEqual(receivedPayments(value), group, 'polling does not make separate historical popups');
  assert.equal(receivedPayments({ ...value, user: parent }), null);
  assert.equal(receivedPayments({ ...value, user: { ...child, id: 'kid-c' } }), null);
  assert.equal(receivedPayments(null), null);
});

test('dismissal consumes exactly captured IDs and read notifications do not replay after reopening', () => {
  const before = state();
  const captured = receivedPayments(before)!;
  const later = { ...payment, id: 'later', amountCents: 60 };
  before.transactions.push(later);
  before.notifications.push({ ...note, id: 'later-note', transactionId: later.id });
  assert.deepEqual(receivedPayments(before, new Set(captured.notificationIds))?.notificationIds, ['later-note']);
  before.notifications = before.notifications.map(item => ({ ...item, readAt: '2026-11-15T12:00:00Z' }));
  assert.equal(receivedPayments(before), null);
});

test('the same failed payment retry keeps its request ID while a different payment gets a new ID', () => {
  const input = { childId: child.id, kind: 'addition' as const, amountCents: 30, merchant: 'Allowance', note: '' };
  let generated = 0;
  const key = () => `key-${++generated}`;
  const first = paymentAttempt(input, null, key);
  assert.equal(paymentAttempt({ ...input }, first, key), first);
  assert.equal(generated, 1);
  assert.equal(paymentAttempt({ ...input, amountCents: 45 }, first, key).key, 'key-2');
});

test('receipt file parsing preserves statuses and omitted legacy items, rejecting malformed totals', () => {
  const payload = { items: [{ reportId: 'report', path: 'Movies/New.iso', oldPath: 'Movies/Old.iso', status: 'renamed' }], totalCount: 2, omittedCount: 1 };
  assert.deepEqual(parseReceiptItems(payload), payload);
  assert.deepEqual(parseReceiptItems({ items: [], totalCount: 338, omittedCount: 338 }), { items: [], totalCount: 338, omittedCount: 338 });
  for (const invalid of [{ ...payload, omittedCount: 0 }, { ...payload, totalCount: 1.5 }, { ...payload, items: [{ ...payload.items[0], status: 'unchanged' }] }, { ...payload, items: [{ ...payload.items[0], path: 5 }] }]) assert.throws(() => parseReceiptItems(invalid));
});

test('receipt API validates IDs, falls back only for unavailable lists, and retains authentication errors', async () => {
  let calls = 0;
  const api = new PocketAPI('http://127.0.0.1:8787', async () => { calls++; return response({ error: 'Not found.' }, 404); });
  assert.equal(await api.transactionItems('token', 'receipt-1'), null);
  await assert.rejects(api.transactionItems('token', '../state'), /valid receipt/);
  assert.equal(calls, 1);
  const expired = new PocketAPI('http://127.0.0.1:8787', async () => response({ error: 'Expired.' }, 401));
  await assert.rejects(expired.transactionItems('token', 'receipt-1'), error => error instanceof APIError && error.status === 401);
});

test('server-confirmed payment remains successful if only the following balance refresh fails', async () => {
  let posted = 0;
  const controller = new PocketController(new Storage(), async (url) => {
    const path = new URL(url).pathname;
    if (path === '/health') return response({ setupRequired: false, pushConfigured: false });
    if (path === '/login') return response({ token: 'A'.repeat(43), user: parent, familyName: 'Family' });
    if (path === '/transactions') { posted++; return response({ ok: true }); }
    if (path === '/state') {
      if (posted) throw new Error('offline after commit');
      return response({ ...state(), user: parent });
    }
    return response({ ok: true });
  });
  await controller.initialize(); await controller.signIn('parent', 'password');
  await controller.recordTransaction({ childId: child.id, kind: 'addition', amountCents: 30, merchant: 'Allowance', note: '', idempotencyKey: 'same-payment' });
  assert.equal(posted, 1);
  assert.match(controller.getSnapshot().error ?? '', /Could not reach/);
});

test('a late receipt response cannot cross sign-out into another account', async () => {
  let release!: (value: FetchResponse) => void;
  const pending = new Promise<FetchResponse>(resolve => { release = resolve; });
  const controller = new PocketController(new Storage(), async url => {
    const path = new URL(url).pathname;
    if (path === '/health') return response({ setupRequired: false, pushConfigured: false });
    if (path === '/login') return response({ token: 'A'.repeat(43), user: child, familyName: 'Family' });
    if (path === '/state') return response(state());
    if (path.endsWith('/items')) return pending;
    return response({ ok: true });
  });
  await controller.initialize(); await controller.signIn('avery', 'password');
  const request = controller.transactionItems('payment-a');
  await controller.signOut();
  release(response({ items: [{ reportId: 'private', path: 'Private.iso', status: 'modified' }], totalCount: 1, omittedCount: 0 }));
  await assert.rejects(request, /replaced/);
  assert.equal(controller.getSnapshot().state, null);
});

test('an ambiguous payment survives form remount and reuses its key; a changed request cannot duplicate it', async () => {
  const posted: { idempotencyKey: string; amountCents: number }[] = [];
  let fail = true;
  let expiredRetry = false;
  let loginUser = parent;
  const controller = new PocketController(new Storage(), async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return response({ setupRequired: false, pushConfigured: false });
    if (path === '/login') return response({ token: 'A'.repeat(43), user: loginUser, familyName: 'Family' });
    if (path === '/state') return response({ ...state(), user: loginUser });
    if (path === '/transactions') {
      posted.push(JSON.parse(options.body!));
      if (expiredRetry) return response({ error: 'Session expired.' }, 401);
      if (fail) throw new Error('response lost after commit');
    }
    return response({ ok: true });
  });
  await controller.initialize(); await controller.signIn('parent', 'password');
  const input = { childId: child.id, kind: 'addition' as const, amountCents: 30, merchant: 'Allowance', note: '', idempotencyKey: 'original-key' };
  await assert.rejects(controller.recordTransaction(input), /Could not reach/);
  assert.deepEqual(controller.getSnapshot().pendingTransaction, input);
  await assert.rejects(controller.recordTransaction({ ...input, amountCents: 45, idempotencyKey: 'new-key' }), /unconfirmed/);
  assert.equal(posted.length, 1);
  expiredRetry = true;
  await assert.rejects(controller.recordTransaction({ ...input, idempotencyKey: 'expired-retry-key' }), /Session expired/);
  assert.equal(controller.getSnapshot().signedIn, false);
  expiredRetry = false;
  await controller.signIn('parent', 'password');
  assert.equal(controller.getSnapshot().pendingTransaction?.idempotencyKey, 'original-key', 'a rejected retry cannot disprove the earlier ambiguous commit');
  await controller.signOut();
  loginUser = { ...parent, id: 'different-parent' };
  await controller.signIn('other', 'password');
  assert.equal(controller.getSnapshot().pendingTransaction, null);
  await controller.signOut();
  loginUser = parent;
  await controller.signIn('parent', 'password');
  assert.equal(controller.getSnapshot().pendingTransaction?.idempotencyKey, 'original-key');
  fail = false;
  // A remounted form creates a fresh local key; the controller retains the unresolved one.
  await controller.recordTransaction({ ...input, idempotencyKey: 'remounted-key' });
  assert.equal(posted.at(-1)?.idempotencyKey, 'original-key');
  assert.equal(controller.getSnapshot().pendingTransaction, null);
});

test('a definitive rejected payment permits a corrected new request and key', async () => {
  let reject = true;
  const posted: string[] = [];
  const controller = new PocketController(new Storage(), async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/health') return response({ setupRequired: false, pushConfigured: false });
    if (path === '/login') return response({ token: 'A'.repeat(43), user: parent, familyName: 'Family' });
    if (path === '/state') return response({ ...state(), user: parent });
    if (path === '/transactions') {
      posted.push(JSON.parse(options.body!).idempotencyKey);
      if (reject) return response({ error: 'Invalid reason.' }, 400);
    }
    return response({ ok: true });
  });
  await controller.initialize(); await controller.signIn('parent', 'password');
  const input = { childId: child.id, kind: 'addition' as const, amountCents: 30, merchant: 'Allowance', note: '', idempotencyKey: 'rejected-key' };
  await assert.rejects(controller.recordTransaction(input), /Invalid reason/);
  assert.equal(controller.getSnapshot().pendingTransaction, null);
  reject = false;
  await controller.recordTransaction({ ...input, merchant: 'Corrected', idempotencyKey: 'corrected-key' });
  assert.deepEqual(posted, ['rejected-key', 'corrected-key']);
});
