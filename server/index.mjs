import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { APIError, FamilyStore, fail } from './store.mjs';
import { createAPNsProvider } from './apns.mjs';

export function createFamilyServer({ dbPath = './data/pocket.sqlite', setupCode, pushProvider = null } = {}) {
  const store = new FamilyStore(dbPath, { setupCode, pushProvider });
  const attempts = new Map();
  let closing = false;
  function limit(request, input) {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const ip = request.socket.remoteAddress;
    const keys = [`ip:${ip}`, `name:${String(input.username ?? '').toLowerCase()}`];
    for (const key of keys) {
      const attempt = attempts.get(key) ?? { count: 0, until: now + 60000 };
      attempt.count += 1;
      attempts.set(key, attempt);
      if (attempt.count > (key.startsWith('ip:') ? 30 : 8)) fail(429, 'Too many attempts. Try again in a minute.');
    }
  }
  async function body(request) {
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) fail(415, 'Send JSON.');
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16384) fail(413, 'Request is too large.');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
      if (route === 'GET /health') output = { setupRequired: store.setupRequired, pushConfigured: store.pushConfigured };
      else if (route === 'POST /setup' || route === 'POST /login') {
        const input = await body(request);
        limit(request, input);
        output = route === 'POST /setup' ? store.setup(input) : store.login(input);
      } else {
        const user = store.authenticate(request.headers.authorization);
        if (route === 'GET /state') output = store.state(user);
        else if (route === 'POST /logout') { store.logout(user); output = { ok: true }; }
        else if (route === 'POST /members') {
          if (user.role !== 'parent') fail(403, 'Only a parent can add family members.');
          const member = store.addMember(await body(request));
          output = { member: { ...member, balanceCents: 0 } };
        } else if (route === 'POST /transactions') {
          output = store.createTransaction(user, await body(request));
          // Delivery happens after the ledger and inbox transaction has committed.
          void store.drainOutbox().catch(() => {});
        } else if (route === 'POST /browser/purchase') {
          output = store.browserPurchase(user, await body(request));
          void store.drainOutbox().catch(() => {});
        } else if (route === 'POST /notifications/read') { store.markRead(user, await body(request)); output = { ok: true }; }
        else if (route === 'POST /devices' || route === 'DELETE /devices') { store.device(user, await body(request), request.method === 'DELETE'); output = { ok: true }; }
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
  const interval = setInterval(() => { if (!closing) void store.drainOutbox().catch(() => {}); }, 5000);
  interval.unref();
  return {
    server, store,
    async close() {
      closing = true;
      clearInterval(interval);
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      while (store.draining) await new Promise(resolve => setTimeout(resolve, 10));
      store.close();
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
    if (app.store.setupRequired) console.log(`One-time family setup code: ${app.store.setupCode}`);
    console.log(app.store.pushConfigured ? 'Apple sandbox push configured.' : 'In-app alerts enabled. Apple push is not configured.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
