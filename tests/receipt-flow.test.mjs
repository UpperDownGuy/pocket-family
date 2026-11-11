import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createFamilyServer } from '../server/index.mjs';

test('opted-in Safari receipt becomes one private family purchase through the real API', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pocket-receipt-flow-'));
  const app = createFamilyServer({ dbPath: join(directory, 'test.sqlite'), setupCode: 'test-setup-only' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const baseURL = `http://127.0.0.1:${app.server.address().port}`;
  async function api(method, path, payload, token) {
    const response = await fetch(baseURL + path, {
      method, headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  }
  const setup = await api('POST', '/setup', { familyName: 'Receipt Test Family', name: 'Parent One', username: 'parent1', password: 'test-parent-password', setupCode: 'test-setup-only' });
  assert.equal(setup.status, 200);
  const parent = setup.body;
  async function addAccount(name, username, role) {
    const added = await api('POST', '/members', { name, username, role, password: 'test-member-password' }, parent.token);
    assert.equal(added.status, 200);
    const signedIn = await api('POST', '/login', { username, password: 'test-member-password' });
    assert.equal(signedIn.status, 200);
    return signedIn.body;
  }
  const otherParent = await addAccount('Parent Two', 'parent2', 'parent');
  const child = await addAccount('Avery', 'avery', 'child');
  const sibling = await addAccount('Jordan', 'jordan', 'child');
  const allowance = await api('POST', '/transactions', { childId: child.user.id, kind: 'addition', amountCents: 5000,
    merchant: 'Opening balance', note: '', idempotencyKey: 'receipt-flow-opening-balance' }, parent.token);
  assert.equal(allowance.status, 200);

  // Run the shipped detector and background scripts, with only the Safari
  // runtime/native URLSession boundary replaced. No external service is used.
  const detectorSource = await readFile(new URL('../PocketSafari/Resources/detector.js', import.meta.url), 'utf8');
  const backgroundSource = await readFile(new URL('../PocketSafari/Resources/background.js', import.meta.url), 'utf8');
  const detectorContext = vm.createContext({ URL });
  vm.runInContext(detectorSource, detectorContext);
  const detectReceipt = detectorContext.PocketReceipt.detectReceipt;
  const receiptPage = 'https://store.example/orders/THANKS-1042?receipt_token=must-stay-private';
  const origin = new URL(receiptPage).origin;
  const sourceText = 'Thank you for your order\nOrder number: THANKS-1042\nTotal paid: USD $12.99';
  const candidate = detectReceipt(sourceText, receiptPage);
  assert.ok(candidate);
  assert.equal(candidate.amountCents, 1299);
  assert.equal(candidate.url, origin);
  assert.equal(candidate.orderReference, 'THANKS-1042');
  assert.equal(JSON.stringify(candidate).includes('receipt_token'), false);

  const localStorage = { enabledOrigins: [] };
  let onMessage;
  let nativeCalls = 0;
  const serverResponses = [];
  const browser = {
    runtime: {
      id: 'pocket-test-extension', getURL: () => 'safari-web-extension://pocket-test/',
      onMessage: { addListener(callback) { onMessage = callback; } },
      async sendNativeMessage(_application, message) {
        nativeCalls += 1;
        assert.equal(message.type, 'purchase');
        // Matches SafariWebExtensionHandler's native API request conversion.
        const receipt = message.receipt;
        const result = await api('POST', '/browser/purchase', {
          merchant: new URL(receipt.url).hostname, note: 'Online purchase', amountCents: receipt.amountCents,
          orderReference: receipt.orderReference, url: receipt.url, currency: 'USD',
        }, child.token);
        serverResponses.push(result);
        if (result.status !== 200) return { ok: false, error: result.body.error };
        assert.ok(result.body.transaction);
        assert.equal(typeof result.body.replayed, 'boolean');
        assert.equal(Object.hasOwn(result.body, 'duplicate'), false);
        return { ok: true, duplicate: result.body.replayed };
      },
    },
    storage: { local: {
      async get(key) { return { [key]: localStorage[key] }; },
      async set(values) { Object.assign(localStorage, values); },
    } },
  };
  vm.runInContext(backgroundSource, vm.createContext({ browser, URL }));
  assert.equal(typeof onMessage, 'function');
  const sender = { id: browser.runtime.id, frameId: 0, url: receiptPage, tab: { id: 1, url: receiptPage } };
  const disabled = await onMessage({ type: 'receipt', receipt: candidate }, sender);
  assert.equal(disabled.ok, false);
  assert.equal(nativeCalls, 0, 'site opt-in must precede any API delivery');

  localStorage.enabledOrigins = [origin];
  const saved = await onMessage({ type: 'receipt', receipt: candidate }, sender);
  assert.equal(saved.ok, true);
  assert.equal(saved.duplicate, false);
  assert.equal(localStorage.lastDelivery.ok, true);
  const firstID = serverResponses[0].body.transaction.id;
  assert.equal(serverResponses[0].body.transaction.childId, child.user.id);
  assert.equal(serverResponses[0].body.transaction.kind, 'purchase');
  assert.equal(serverResponses[0].body.transaction.amountCents, 1299);

  // A new content-script instance after navigation cannot rely on lastSent.
  // The server must still identify the original purchase by child/site/order.
  const reloadedCandidate = detectReceipt(sourceText, 'https://store.example/receipt/THANKS-1042');
  const replay = await onMessage({ type: 'receipt', receipt: reloadedCandidate }, sender);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(serverResponses[1].body.transaction.id, firstID);

  for (const recipient of [parent, otherParent, child]) {
    const result = await api('GET', '/state', undefined, recipient.token);
    assert.equal(result.status, 200);
    const state = result.body;
    assert.equal(state.transactions.filter(entry => entry.id === firstID).length, 1);
    assert.equal(state.notifications.filter(alert => alert.transactionId === firstID).length, 1);
    assert.equal(state.members.find(member => member.id === child.user.id).balanceCents, 3701);
    assert.equal(state.transactions.length, 2, 'opening balance plus one captured purchase');
  }
  const siblingState = (await api('GET', '/state', undefined, sibling.token)).body;
  assert.equal(siblingState.transactions.length, 0);
  assert.equal(siblingState.notifications.length, 0);
  assert.equal(siblingState.members.length, 1);
  assert.equal(siblingState.members[0].id, sibling.user.id);

  for (const checkout of [
    'Complete your purchase\nOrder number: THANKS-1042\nTotal: USD $12.99',
    'Thank you for your order\nOrder number: THANKS-1042\nTotal paid: $12.99',
    'Thank you for your order\nOrder number: THANKS-1042\nTotal paid: USD $12.99\nTotal: USD $20.00',
    'Thank you for your order\nPayment pending\nOrder number: THANKS-1042\nTotal paid: USD $12.99',
    'Thank you for your order\nTotal paid: USD $12.99',
  ]) assert.equal(detectReceipt(checkout, receiptPage), null);
  assert.equal(nativeCalls, 2, 'ambiguous checkout pages never produce a request candidate');
});
