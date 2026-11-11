import { connect } from 'node:http2';
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

// Development builds use Apple's sandbox. Credentials never reach the iPhone.
export function createAPNsProvider(env = process.env) {
  const values = [env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_TOPIC, env.APNS_KEY_PATH];
  if (values.every(value => !value)) return null;
  if (values.some(value => !value)) throw new Error('Set all four APNS_* values, or remove them all.');
  const key = createPrivateKey(readFileSync(env.APNS_KEY_PATH));
  let cachedToken;
  let tokenTime = 0;
  function token() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && now - tokenTime < 3000) return cachedToken;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: now })).toString('base64url');
    const input = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    cachedToken = `${input}.${signature.toString('base64url')}`;
    tokenTime = now;
    return cachedToken;
  }
  return {
    async send(deviceToken) {
      return await new Promise((resolve, reject) => {
        const client = connect('https://api.sandbox.push.apple.com');
        let done = false;
        const finish = (error, value) => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          client.destroy();
          error ? reject(error) : resolve(value);
        };
        const timeout = setTimeout(() => finish(new Error('APNs timeout')), 10000);
        client.on('error', error => finish(error));
        const request = client.request({
          ':method': 'POST', ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${token()}`,
          'apns-topic': env.APNS_TOPIC, 'apns-push-type': 'alert',
          'apns-priority': '10', 'apns-expiration': '0',
          'content-type': 'application/json',
        });
        let status = 0;
        let body = '';
        request.on('response', headers => { status = Number(headers[':status']); });
        request.on('data', chunk => { if (body.length < 4096) body += chunk.toString(); });
        request.on('error', error => finish(error));
        request.on('end', () => {
          let reason = '';
          try { reason = JSON.parse(body).reason ?? ''; } catch { /* Success has no body. */ }
          finish(null, { ok: status === 200, retry: status === 429 || status >= 500,
            invalidToken: status === 410 || reason === 'BadDeviceToken', reason: reason || `HTTP ${status}` });
        });
        // Never place names, amounts, purchase details or account IDs on the lock screen.
        request.end(JSON.stringify({ aps: { alert: { title: 'Pocket', body: 'Your balance activity has changed.' }, sound: 'default' } }));
      });
    },
  };
}
