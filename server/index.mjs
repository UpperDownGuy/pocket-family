import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { APIError, FamilyRegistry, fail } from './store.mjs';
import { createAPNsProvider } from './apns.mjs';

export function createFTSPairingLimiter(clock = Date.now) {
  const attempts = new Map();
  return ip => {
    const now = clock();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    // Count the server-wide budget first, limiting memory even if requests use
    // many addresses. Forwarded headers cannot override the connection's IP.
    for (const [key, maximum] of [['all', 30], [`ip:${ip}`, 10]]) {
      const attempt = attempts.get(key) ?? { count: 0, until: now + 60000 };
      attempt.count += 1;
      attempts.set(key, attempt);
      if (attempt.count > maximum) fail(429, 'Too many setup attempts. Try again in a minute.');
    }
  };
}

export function createFamilyServer({ dbPath = './data/pocket.sqlite', setupCode, pushProvider = null, clock } = {}) {
  const registry = new FamilyRegistry(dbPath, { setupCode, pushProvider, clock });
  const store = registry.legacyStore;
  const attempts = new Map();
  const registrations = new Map();
  const limitPairing = createFTSPairingLimiter();
  let closing = false;
  function limit(request, input) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const ip = request.socket.remoteAddress;
    const keys = [`ip:${ip}`, `name:${String(input.familyCode ?? 'default')}:${String(input.username ?? '').toLowerCase()}`];
    for (const key of keys) {
      const attempt = attempts.get(key) ?? { count: 0, until: now + 60000 };
      attempt.count += 1;
      attempts.set(key, attempt);
      if (attempt.count > (key.startsWith('ip:') ? 30 : 8)) fail(429, 'Too many attempts. Try again in a minute.');
    }
  }
  function limitRegistration(request) {
    const now = Date.now();
    for (const [key, value] of registrations) if (value.until <= now) registrations.delete(key);
    for (const [key, maximum] of [['all', 30], [`ip:${request.socket.remoteAddress}`, 5]]) {
      const attempt = registrations.get(key) ?? { count: 0, until: now + 10 * 60000 };
      attempt.count++;
      registrations.set(key, attempt);
      if (attempt.count > maximum) fail(429, 'Too many family setup attempts. Try again in ten minutes.');
    }
  }
  async function body(request, maximumBytes = 16384, allowGzip = false) {
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) fail(415, 'Send JSON.');
    const encoding = String(request.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && !(allowGzip && encoding === 'gzip')) fail(415, 'Unsupported request encoding.');
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximumBytes) fail(413, 'Request is too large.');
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks);
    if (encoding === 'gzip') {
      try { bytes = gunzipSync(bytes, { maxOutputLength: maximumBytes }); }
      catch (error) {
        if (error.code === 'ERR_BUFFER_TOO_LARGE') fail(413, 'Decompressed request is too large.');
        fail(400, 'Invalid gzip request.');
      }
    }
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Send a JSON object.');
      return value;
    } catch (error) { if (error instanceof APIError) throw error; fail(400, 'Invalid JSON.'); }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      // Native app only. Cross-origin browser requests cannot use this API.
      if (request.headers.origin) fail(403, 'Browser requests are not supported.');
      const path = new URL(request.url, 'http://localhost').pathname;
      const route = `${request.method} ${path}`;
      let output;
      if (route === 'GET /health') output = { setupRequired: registry.setupRequired, pushConfigured: registry.pushConfigured,
        capabilities: { fts: { setupCodeDigits: 8, childCanConnect: true, parentComputerLog: true, itemLists: true, manualReplacementCredits: true },
          families: { multiple: true, registration: true, deletion: true }, subscriptions: true, subscriptionReminders: true } };
      else if (route === 'POST /families') {
        limitRegistration(request);
        output = registry.create(await body(request));
      }
      else if (route === 'POST /setup' || route === 'POST /login') {
        const input = await body(request);
        limit(request, input);
        output = route === 'POST /setup' ? registry.setup(input) : registry.login(input);
      } else if (route === 'POST /fts/pair') {
        limitPairing(request.socket.remoteAddress);
        output = registry.pair(await body(request));
      } else if (route === 'GET /fts/connection' || route === 'POST /fts/vouchers' || route === 'POST /fts/vouchers/status' || route === 'POST /fts/vouchers/replacement') {
        // Tracker keys can issue and poll credits only. They are deliberately
        // not family sessions and cannot inspect accounts or spend money.
        const { store, actor: issuer } = registry.authenticated(request.headers.authorization, true, { allowRevoked: route === 'POST /fts/vouchers/status' });
        const issuerBody = async (maximumBytes = 16384, allowGzip = false) => {
          const input = await body(request, maximumBytes, allowGzip);
          const current = registry.authenticated(request.headers.authorization, true, { allowRevoked: route === 'POST /fts/vouchers/status' });
          if (current.store !== store || current.actor.id !== issuer.id) fail(401, 'Reconnect this file tracker before continuing.');
          return input;
        };
        if (route === 'GET /fts/connection') output = store.ftsConnection(issuer);
        else if (route === 'POST /fts/vouchers') output = store.issueFTSVoucher(issuer, await issuerBody(512 * 1024));
        else if (route === 'POST /fts/vouchers/replacement') output = store.issueFTSReplacement(issuer, await issuerBody(512 * 1024, true));
        else output = store.ftsVoucherStatus(issuer, await issuerBody());
      } else {
        const { store, family, actor: user } = registry.authenticated(request.headers.authorization);
        const userBody = async () => {
          const input = await body(request);
          // A body may arrive after its family/session was deleted or revoked.
          // Reauthenticate before using any actor captured before this await.
          const current = registry.authenticated(request.headers.authorization);
          if (current.store !== store || current.family.id !== family.id || current.actor.id !== user.id) fail(401, 'Sign in again before continuing.');
          return input;
        };
        if (route === 'GET /state') output = registry.withFamily(family, store.state(user));
        else if (route === 'DELETE /family') output = await registry.deleteFamily(family, store, user, await userBody());
        else if (route === 'POST /logout') { store.logout(user); output = { ok: true }; }
        else if (route === 'GET /subscriptions/sync') output = store.subscriptionSync(user);
        else if (route === 'GET /subscriptions') output = store.listSubscriptions(user);
        else if (route === 'POST /subscriptions') {
          output = store.createSubscription(user, await userBody());
          void store.drainOutbox().catch(() => {});
        } else if (request.method === 'PATCH' && /^\/subscriptions\/[a-f0-9-]{36}$/.test(path)) {
          output = store.updateSubscription(user, path.split('/')[2], await userBody());
          void store.drainOutbox().catch(() => {});
        } else if (request.method === 'DELETE' && /^\/subscriptions\/[a-f0-9-]{36}$/.test(path)) {
          output = store.deleteSubscription(user, path.split('/')[2]);
        }
        else if (route === 'POST /members') {
          if (user.role !== 'parent') fail(403, 'Only a parent can add family members.');
          const member = store.addMember(await userBody());
          output = { member: { ...member, balanceCents: 0 } };
        } else if (route === 'POST /transactions') {
          output = store.createTransaction(user, await userBody());
          // Delivery happens after the ledger and inbox transaction has committed.
          void store.drainOutbox().catch(() => {});
        } else if (request.method === 'GET' && /^\/transactions\/[a-f0-9-]{36}\/items$/.test(path)) output = store.transactionItems(user, path.split('/')[2]);
        else if (route === 'GET /fts/issuers') output = store.listFTSIssuers(user);
        else if (route === 'POST /fts/issuers') output = store.createFTSIssuer(user, await userBody());
        else if (request.method === 'POST' && /^\/fts\/issuers\/[a-f0-9-]{36}\/revoke$/.test(path)) output = store.revokeFTSIssuer(user, path.split('/')[3]);
        else if (route === 'POST /credits/preview') output = store.previewCredit(user, await userBody());
        else if (route === 'POST /credits/redeem') {
          output = store.redeemCredit(user, await userBody());
          void store.drainOutbox().catch(() => {});
        } else if (route === 'POST /browser/purchase') {
          output = store.browserPurchase(user, await userBody());
          void store.drainOutbox().catch(() => {});
        } else if (route === 'POST /notifications/read') { store.markRead(user, await userBody()); output = { ok: true }; }
        else if (route === 'POST /devices' || route === 'DELETE /devices') { registry.device(store, user, await userBody(), request.method === 'DELETE'); output = { ok: true }; }
        else fail(404, 'Not found.');
      }
      response.writeHead(200);
      response.end(JSON.stringify(output));
    } catch (error) {
      response.writeHead(error instanceof APIError ? error.status : 500);
      response.end(JSON.stringify({ error: error instanceof APIError ? error.message : 'The server could not complete this request.' }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const processSubscriptions = () => {
    try { registry.processSubscriptions(); }
    catch { console.error('Pocket could not process scheduled subscriptions. It will retry.'); }
  };
  processSubscriptions();
  const interval = setInterval(() => {
    if (!closing) {
      processSubscriptions();
      void registry.drainOutbox().catch(() => {});
    }
  }, 5000);
  interval.unref();
  return {
    server, store, registry,
    async close() {
      closing = true;
      clearInterval(interval);
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      while (registry.allStores().some(store => store.draining)) await new Promise(resolve => setTimeout(resolve, 10));
      registry.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createFamilyServer({ dbPath: process.env.DB_PATH || './data/pocket.sqlite', setupCode: process.env.SETUP_CODE,
    pushProvider: createAPNsProvider() });
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  app.server.listen(port, host, () => {
    console.log(`Pocket server: http://${host}:${port}`);
    if (app.registry.setupRequired) console.log(`One-time family setup code: ${app.store.setupCode}`);
    console.log(app.store.pushConfigured ? 'Apple sandbox push configured.' : 'In-app alerts enabled. Apple push is not configured.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
