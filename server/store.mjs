import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function fail(status, message) { throw new APIError(status, message); }
export function text(value, label, min = 1, max = 80) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${label} must be ${min}–${max} characters.`);
  return value.trim();
}
export function credentials(input) {
  const username = text(input.username, 'Username', 3, 40).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(username)) fail(400, 'Use letters, numbers, dots, dashes or underscores for the username.');
  if (typeof input.password !== 'string' || input.password.length < 10 || input.password.length > 128) fail(400, 'Password must be 10–128 characters.');
  return { username, password: input.password };
}
const hash = value => createHash('sha256').update(value).digest('hex');
const publicUser = row => ({ id: row.id, name: row.name, username: row.username, role: row.role });
const transactionJSON = row => ({ id: row.id, childId: row.child_id, childName: row.child_name, kind: row.kind,
  amountCents: row.amount_cents, merchant: row.merchant, note: row.note, createdAt: row.created_at });
const issuerJSON = row => ({ id: row.id, name: row.name, priceCents: row.price_cents,
  createdAt: row.created_at, revokedAt: row.revoked_at });
function voucherCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail(400, 'Scan a valid Pocket credit code.');
  return value;
}
const voucherJSON = row => ({ status: row.redeemed_at ? 'redeemed' : row.revoked_at ? 'revoked' : 'issued',
  amountCents: row.amount_cents, reportCount: row.report_count, editCount: row.edit_count,
  createdAt: row.created_at, redeemedAt: row.redeemed_at });

export class FamilyStore {
  constructor(path, { setupCode, pushProvider = null } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.setupCode = setupCode || randomBytes(12).toString('hex');
    this.pushProvider = pushProvider;
    this.draining = false;
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role IN ('parent','child')),salt TEXT NOT NULL,password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES members(id),expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY,child_id TEXT NOT NULL REFERENCES members(id),
        kind TEXT NOT NULL CHECK(kind IN ('addition','purchase')),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
        merchant TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES members(id),
        idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(created_by,idempotency_key));
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY,recipient_id TEXT NOT NULL REFERENCES members(id),
        transaction_id TEXT NOT NULL REFERENCES transactions(id),title TEXT NOT NULL,body TEXT NOT NULL,
        created_at TEXT NOT NULL,read_at TEXT,UNIQUE(recipient_id,transaction_id));
      CREATE TABLE IF NOT EXISTS devices (token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES members(id),session_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,notification_id TEXT NOT NULL REFERENCES notifications(id),
        device_token TEXT NOT NULL,recipient_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,UNIQUE(notification_id,device_token));
      CREATE INDEX IF NOT EXISTS tx_child ON transactions(child_id,created_at);
      CREATE INDEX IF NOT EXISTS notification_recipient ON notifications(recipient_id,created_at);
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,next_attempt);
      CREATE TABLE IF NOT EXISTS fts_issuers (id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
        price_cents INTEGER NOT NULL CHECK(price_cents>0),created_at TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES members(id),revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS fts_vouchers (code_hash TEXT PRIMARY KEY,issuer_id TEXT NOT NULL REFERENCES fts_issuers(id),
        fingerprint TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
        report_count INTEGER NOT NULL CHECK(report_count>0),edit_count INTEGER NOT NULL CHECK(edit_count>0),
        created_at TEXT NOT NULL,redeemed_at TEXT,child_id TEXT REFERENCES members(id),
        transaction_id TEXT UNIQUE REFERENCES transactions(id));
      CREATE TABLE IF NOT EXISTS fts_reports (report_id TEXT PRIMARY KEY,voucher_hash TEXT NOT NULL REFERENCES fts_vouchers(code_hash),
        movie_count INTEGER NOT NULL CHECK(movie_count>0),price_cents INTEGER NOT NULL CHECK(price_cents>0));
      CREATE INDEX IF NOT EXISTS fts_voucher_issuer ON fts_vouchers(issuer_id);
      CREATE TABLE IF NOT EXISTS fts_pairings (code_hash TEXT PRIMARY KEY,issuer_id TEXT NOT NULL UNIQUE REFERENCES fts_issuers(id),
        expires_at INTEGER NOT NULL,paired_at TEXT);
    `);
  }
  atomic(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get setupRequired() { return !this.db.prepare("SELECT value FROM settings WHERE key='familyName'").get(); }
  get familyName() { return this.db.prepare("SELECT value FROM settings WHERE key='familyName'").get()?.value ?? ''; }
  get pushConfigured() { return Boolean(this.pushProvider); }
  addMember(input) {
    const name = text(input.name, 'Name', 1, 60);
    const { username, password } = credentials(input);
    if (!['parent', 'child'].includes(input.role)) fail(400, 'Choose parent or child.');
    if (this.db.prepare('SELECT id FROM members WHERE username=?').get(username)) fail(409, 'That username is already taken.');
    const salt = randomBytes(16).toString('hex');
    const passwordHash = scryptSync(password, salt, 64).toString('hex');
    const user = { id: randomUUID(), name, username, role: input.role };
    this.db.prepare('INSERT INTO members VALUES (?,?,?,?,?,?)').run(user.id, name, username, input.role, salt, passwordHash);
    return user;
  }
  session(user) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), user.id, Date.now() + 14 * 24 * 60 * 60 * 1000);
    return { token, user: publicUser(user), familyName: this.familyName };
  }
  setup(input) {
    if (!this.setupRequired) fail(409, 'This family is already set up.');
    if (typeof input.setupCode !== 'string' || !timingSafeEqual(Buffer.from(hash(input.setupCode)), Buffer.from(hash(this.setupCode)))) fail(403, 'Incorrect setup code.');
    const familyName = text(input.familyName, 'Family name', 1, 60);
    return this.atomic(() => {
      const user = this.addMember({ ...input, role: 'parent' });
      this.db.prepare("INSERT INTO settings VALUES ('familyName',?)").run(familyName);
      return this.session(user);
    });
  }
  login(input) {
    const { username, password } = credentials(input);
    const user = this.db.prepare('SELECT * FROM members WHERE username=?').get(username);
    const computed = scryptSync(password, user?.salt ?? 'not-a-real-user', 64);
    const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
    if (!timingSafeEqual(computed, expected) || !user) fail(401, 'Incorrect username or password.');
    return this.session(user);
  }
  authenticate(header) {
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) fail(401, 'Sign in to continue.');
    const sessionHash = hash(header.slice(7));
    const user = this.db.prepare(`SELECT m.* FROM sessions s JOIN members m ON m.id=s.user_id WHERE s.hash=? AND s.expires_at>?`).get(sessionHash, Date.now());
    if (!user) fail(401, 'Your session has expired. Sign in again.');
    return { ...publicUser(user), sessionHash };
  }
  logout(user) {
    this.atomic(() => {
      this.db.prepare("UPDATE outbox SET status='cancelled' WHERE status='pending' AND device_token IN (SELECT token FROM devices WHERE session_hash=?)").run(user.sessionHash);
      this.db.prepare('DELETE FROM devices WHERE session_hash=?').run(user.sessionHash);
      this.db.prepare('DELETE FROM sessions WHERE hash=?').run(user.sessionHash);
    });
  }
  createFTSIssuer(user, input) {
    const name = text(input.name, 'Tracker name', 1, 60);
    if (!Number.isSafeInteger(input.priceCents) || input.priceCents <= 0 || input.priceCents > 1_000_000) fail(400, 'Set an edit price between $0.01 and $10,000.00 in whole cents.');
    return this.atomic(() => {
      let setupCode;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const candidate = this.generateFTSSetupCode();
        if (!this.db.prepare('SELECT code_hash FROM fts_pairings WHERE code_hash=?').get(hash(candidate))) { setupCode = candidate; break; }
      }
      if (setupCode === undefined) fail(503, 'Could not create a setup code. Try again.');
      // The initial strong credential is never exposed or usable by the app.
      // FTS supplies its own persisted credential during the one-time pairing.
      const token = 'fts_' + randomBytes(32).toString('base64url');
      const row = { id: randomUUID(), name, price_cents: input.priceCents, created_at: new Date().toISOString(), revoked_at: null };
      const expiresAt = Date.now() + 10 * 60 * 1000;
      this.db.prepare('INSERT INTO fts_issuers VALUES (?,?,?,?,?,?,NULL)').run(row.id, name, hash(token), input.priceCents, row.created_at, user.id);
      this.db.prepare('INSERT INTO fts_pairings VALUES (?,?,?,NULL)').run(hash(setupCode), row.id, expiresAt);
      return { issuer: issuerJSON(row), setupCode, expiresAt: new Date(expiresAt).toISOString() };
    });
  }
  generateFTSSetupCode() { return randomInt(100_000_000).toString().padStart(8, '0'); }
  pairFTSIssuer(input) {
    if (typeof input.setupCode !== 'string' || !/^[0-9]{8}$/.test(input.setupCode)) fail(400, 'Enter the eight-digit setup code from Pocket.');
    if (typeof input.credential !== 'string' || !/^fts_[A-Za-z0-9_-]{43}$/.test(input.credential)) fail(400, 'FTS must provide a valid connection credential.');
    const credentialHash = hash(input.credential);
    return this.atomic(() => {
      const row = this.db.prepare(`SELECT i.*,p.expires_at,p.paired_at FROM fts_pairings p JOIN fts_issuers i ON i.id=p.issuer_id WHERE p.code_hash=?`).get(hash(input.setupCode));
      if (!row) fail(400, 'That setup code is invalid. Generate a new one in Pocket.');
      if (row.revoked_at) fail(403, 'This file tracker has been disconnected. Generate a new setup code in Pocket.');
      if (row.paired_at) {
        // An exact retry proves possession of the already paired credential,
        // so it remains safe even if the original response arrived after expiry.
        if (row.token_hash !== credentialHash) fail(409, 'That setup code has already been used. Generate a new one in Pocket.');
        return { issuer: issuerJSON(row) };
      }
      if (row.expires_at <= Date.now()) fail(410, 'That setup code has expired. Generate a new one in Pocket.');
      if (this.db.prepare('SELECT id FROM fts_issuers WHERE token_hash=? AND id<>?').get(credentialHash, row.id)) fail(409, 'Use a fresh FTS connection credential for this setup code.');
      this.db.prepare('UPDATE fts_issuers SET token_hash=? WHERE id=?').run(credentialHash, row.id);
      this.db.prepare('UPDATE fts_pairings SET paired_at=? WHERE issuer_id=?').run(new Date().toISOString(), row.id);
      return { issuer: issuerJSON(row) };
    });
  }
  listFTSIssuers(user) {
    const rows = user.role === 'parent'
      ? this.db.prepare('SELECT * FROM fts_issuers ORDER BY created_at DESC,rowid DESC').all()
      : this.db.prepare('SELECT * FROM fts_issuers WHERE created_by=? ORDER BY created_at DESC,rowid DESC').all(user.id);
    return { issuers: rows.map(issuerJSON) };
  }
  revokeFTSIssuer(user, id) {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT * FROM fts_issuers WHERE id=?').get(id);
      if (!row || (user.role !== 'parent' && row.created_by !== user.id)) fail(404, 'File tracker not found.');
      row.revoked_at ||= new Date().toISOString();
      this.db.prepare('UPDATE fts_issuers SET revoked_at=? WHERE id=?').run(row.revoked_at, id);
      return { issuer: issuerJSON(row), revokedAt: row.revoked_at };
    });
  }
  authenticateFTSIssuer(header, { allowRevoked = false } = {}) {
    if (typeof header !== 'string' || !/^Bearer fts_[A-Za-z0-9_-]{43}$/.test(header)) fail(401, 'Connect FTS with a Pocket connection key.');
    const row = this.db.prepare('SELECT * FROM fts_issuers WHERE token_hash=?').get(hash(header.slice(7)));
    if (!row) fail(401, 'The file tracker key is invalid. Reconnect it in Pocket.');
    if (row.revoked_at && !allowRevoked) fail(403, 'This file tracker has been disconnected.');
    return row;
  }
  ftsConnection(issuer) { return { issuer: issuerJSON(issuer) }; }
  getFTSVoucher(code) {
    return this.db.prepare(`SELECT v.*,i.revoked_at FROM fts_vouchers v JOIN fts_issuers i ON i.id=v.issuer_id WHERE v.code_hash=?`).get(hash(voucherCode(code)));
  }
  issueFTSVoucher(issuer, input) {
    const code = voucherCode(input.code);
    if (!Array.isArray(input.reports) || input.reports.length < 1 || input.reports.length > 100) fail(400, 'Include 1–100 earned reports per credit code.');
    const seen = new Set();
    let amountCents = 0;
    let editCount = 0;
    const reports = input.reports.map(report => {
      if (!report || typeof report !== 'object' || Array.isArray(report)) fail(400, 'Each credit needs a report ID and edit count.');
      const reportId = text(report.reportId, 'Report ID', 1, 200);
      if (seen.has(reportId)) fail(400, 'Include each report ID only once.');
      seen.add(reportId);
      if (!Number.isSafeInteger(report.movieCount) || report.movieCount < 1 || report.movieCount > 1_000_000) fail(400, 'Each report must contain 1–1,000,000 earned edits.');
      if (!Number.isSafeInteger(report.priceCents) || report.priceCents !== issuer.price_cents) fail(400, 'The report price must match this connection\'s edit price in Pocket.');
      const earned = report.movieCount * issuer.price_cents;
      amountCents += earned;
      editCount += report.movieCount;
      if (!Number.isSafeInteger(amountCents) || amountCents > 1_000_000) fail(400, 'One credit code can add at most $10,000.00.');
      return { reportId, movieCount: report.movieCount, priceCents: report.priceCents };
    }).sort((a, b) => a.reportId < b.reportId ? -1 : a.reportId > b.reportId ? 1 : 0);
    const fingerprint = hash(JSON.stringify(reports));
    return this.atomic(() => {
      // Re-read inside the transaction so revocation cannot race issuance.
      const current = this.db.prepare('SELECT revoked_at FROM fts_issuers WHERE id=?').get(issuer.id);
      if (!current || current.revoked_at) fail(403, 'This file tracker has been disconnected.');
      const previous = this.getFTSVoucher(code);
      if (previous) {
        if (previous.issuer_id !== issuer.id || previous.fingerprint !== fingerprint) fail(409, 'This code was already used for different earnings.');
        return voucherJSON(previous);
      }
      for (const report of reports) {
        if (this.db.prepare('SELECT report_id FROM fts_reports WHERE report_id=?').get(report.reportId)) fail(409, 'One of these reports already has a Pocket credit code. Reopen its existing code.');
      }
      const row = { code_hash: hash(code), issuer_id: issuer.id, fingerprint, amount_cents: amountCents,
        report_count: reports.length, edit_count: editCount, created_at: new Date().toISOString(), redeemed_at: null, revoked_at: null };
      this.db.prepare('INSERT INTO fts_vouchers VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL)').run(row.code_hash, issuer.id, fingerprint, amountCents, reports.length, editCount, row.created_at);
      for (const report of reports) this.db.prepare('INSERT INTO fts_reports VALUES (?,?,?,?)').run(report.reportId, row.code_hash, report.movieCount, report.priceCents);
      return voucherJSON(row);
    });
  }
  ftsVoucherStatus(issuer, input) {
    const row = this.getFTSVoucher(input.code);
    if (!row || row.issuer_id !== issuer.id) fail(404, 'Credit code not found for this file tracker.');
    return voucherJSON(row);
  }
  previewCredit(_user, input) {
    const row = this.getFTSVoucher(input.code);
    if (!row) fail(404, 'Credit code not found. Check that Pocket is connected to the same family server as FTS.');
    return voucherJSON(row);
  }
  redeemCredit(user, input) {
    const code = voucherCode(input.code);
    const childId = user.role === 'child' ? user.id : text(input.childId, 'Child', 1, 80);
    if (user.role === 'child' && input.childId !== undefined && input.childId !== user.id) fail(403, 'You can only redeem a credit into your own account.');
    return this.atomic(() => {
      const row = this.getFTSVoucher(code);
      if (!row) fail(404, 'Credit code not found.');
      if (row.redeemed_at) {
        if (row.child_id !== childId) fail(409, 'This credit code has already been redeemed.');
        return { ...voucherJSON(row), replayed: true };
      }
      if (row.revoked_at) fail(403, 'This file tracker has been disconnected. This code cannot be redeemed.');
      const entry = { childId, kind: 'addition', amountCents: row.amount_cents, merchant: 'File edits',
        note: `${row.edit_count} edits · ${row.report_count} ${row.report_count === 1 ? 'report' : 'reports'}`,
        idempotencyKey: 'fts:' + randomUUID(), fingerprint: hash('fts:' + row.code_hash) };
      // The issuer authorized the immutable amount. This internal insert stays
      // in the same transaction as consuming the code and creating all alerts.
      const result = this.appendTransaction(user, entry);
      row.redeemed_at = result.transaction.createdAt;
      this.db.prepare('UPDATE fts_vouchers SET redeemed_at=?,child_id=?,transaction_id=? WHERE code_hash=?').run(row.redeemed_at, childId, result.transaction.id, row.code_hash);
      return { ...voucherJSON(row), replayed: false };
    });
  }
  balance(childId) {
    return this.db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'addition' THEN amount_cents ELSE -amount_cents END),0) AS balance FROM transactions WHERE child_id=?").get(childId).balance;
  }
  state(user) {
    const members = user.role === 'parent'
      ? this.db.prepare('SELECT * FROM members ORDER BY role DESC,name').all()
      : this.db.prepare('SELECT * FROM members WHERE id=?').all(user.id);
    const sql = 'SELECT t.*,m.name AS child_name FROM transactions t JOIN members m ON m.id=t.child_id';
    const rows = user.role === 'parent'
      ? this.db.prepare(`${sql} ORDER BY t.created_at DESC,t.rowid DESC`).all()
      : this.db.prepare(`${sql} WHERE t.child_id=? ORDER BY t.created_at DESC,t.rowid DESC`).all(user.id);
    const notes = this.db.prepare('SELECT * FROM notifications WHERE recipient_id=? ORDER BY created_at DESC,rowid DESC').all(user.id);
    return { user: publicUser(user), familyName: this.familyName,
      members: members.map(member => ({ ...publicUser(member), balanceCents: this.balance(member.id) })),
      transactions: rows.map(transactionJSON), notifications: notes.map(note => ({ id: note.id, transactionId: note.transaction_id,
        title: note.title, body: note.body, createdAt: note.created_at, readAt: note.read_at })), pushConfigured: this.pushConfigured };
  }
  createTransaction(user, input) {
    const childId = text(input.childId, 'Child', 1, 80);
    if (user.role === 'child' && (childId !== user.id || input.kind !== 'purchase')) fail(403, 'You can only record your own purchases.');
    if (!['addition', 'purchase'].includes(input.kind)) fail(400, 'Choose addition or purchase.');
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 1_000_000) fail(400, 'Amount must be between $0.01 and $10,000.00 in whole cents.');
    const merchant = text(input.merchant, input.kind === 'purchase' ? 'Store or purchase' : 'Reason', 1, 100);
    const note = text(input.note ?? '', 'Note', 0, 300);
    const idempotencyKey = text(input.idempotencyKey, 'Request ID', 8, 100);
    const fingerprint = hash(JSON.stringify({ childId, kind: input.kind, amountCents: input.amountCents, merchant, note }));
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT t.*,m.name AS child_name FROM transactions t JOIN members m ON m.id=t.child_id WHERE t.created_by=? AND t.idempotency_key=?').get(user.id, idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail(409, 'This request ID was already used for a different entry.');
        return { transaction: transactionJSON(previous), replayed: true };
      }
      return this.appendTransaction(user, { childId, kind: input.kind, amountCents: input.amountCents, merchant, note, idempotencyKey, fingerprint });
    });
  }
  // Call only within an existing atomic operation after authorization and
  // amount validation. Both ordinary entries and QR redemption share alerts.
  appendTransaction(user, input) {
      const { childId, merchant, note, idempotencyKey, fingerprint } = input;
      const child = this.db.prepare("SELECT * FROM members WHERE id=? AND role='child'").get(childId);
      if (!child) fail(404, 'Child not found.');
      // This is a record of money already spent, not a card authorization.
      // A missing opening balance must never hide a real purchase or its alerts.
      const newBalance = this.balance(childId) + (input.kind === 'addition' ? input.amountCents : -input.amountCents);
      if (!Number.isSafeInteger(newBalance)) fail(409, 'Balance is too large.');
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      this.db.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, childId, input.kind, input.amountCents, merchant, note, createdAt, user.id, idempotencyKey, fingerprint);
      const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(input.amountCents / 100);
      const title = input.kind === 'addition' ? `${child.name}: ${money} added` : `${child.name}: ${money} spent`;
      const body = merchant + (note ? ` · ${note}` : '');
      const recipients = this.db.prepare("SELECT id FROM members WHERE role='parent' OR id=?").all(childId);
      for (const recipient of recipients) {
        const noteId = randomUUID();
        this.db.prepare('INSERT INTO notifications VALUES (?,?,?,?,?,?,NULL)').run(noteId, recipient.id, id, title, body, createdAt);
        if (this.pushConfigured) {
          const devices = this.db.prepare('SELECT token FROM devices WHERE user_id=?').all(recipient.id);
          for (const device of devices) this.db.prepare('INSERT INTO outbox(id,notification_id,device_token,recipient_id) VALUES (?,?,?,?)').run(randomUUID(), noteId, device.token, recipient.id);
        }
      }
      return { transaction: { id, childId, childName: child.name, kind: input.kind, amountCents: input.amountCents, merchant, note, createdAt }, replayed: false };
  }
  browserPurchase(user, input) {
    if (user.role !== 'child') fail(403, 'Sign in with the child account that made this purchase.');
    if (input.currency !== undefined && input.currency !== 'USD') fail(400, 'Only USD receipts can be logged.');
    const rawURL = text(input.url, 'Receipt URL', 1, 2048);
    let url;
    try { url = new URL(rawURL); } catch { fail(400, 'Use a valid HTTPS receipt URL.'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail(400, 'Use a valid HTTPS receipt URL.');
    const orderReference = text(input.orderReference, 'Order reference', 2, 100);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(orderReference)) fail(400, 'The receipt needs a clear order reference.');
    // Navigation, reloads and repeated scans of one order map to one ledger entry.
    // Query strings, page content and payment credentials are never persisted.
    const idempotencyKey = 'browser:' + hash(`${user.id}\n${url.hostname.toLowerCase()}\n${orderReference.toLowerCase()}`);
    return this.createTransaction(user, { childId: user.id, kind: 'purchase', amountCents: input.amountCents,
      merchant: input.merchant, note: input.note ?? '', idempotencyKey });
  }
  markRead(user, input) {
    if (!Array.isArray(input.ids) || input.ids.length > 1000 || input.ids.some(id => typeof id !== 'string' || id.length > 80)) fail(400, 'Choose up to 1,000 alerts.');
    const now = new Date().toISOString();
    this.atomic(() => { for (const id of new Set(input.ids)) this.db.prepare('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient_id=?').run(now, id, user.id); });
  }
  device(user, input, remove = false) {
    if (typeof input.token !== 'string' || !/^[a-fA-F0-9]{32,256}$/.test(input.token) || input.token.length % 2) fail(400, 'Invalid device token.');
    const token = input.token.toLowerCase();
    this.atomic(() => {
      if (remove) {
        this.db.prepare("UPDATE outbox SET status='cancelled' WHERE device_token=? AND recipient_id=? AND status='pending'").run(token, user.id);
        this.db.prepare('DELETE FROM devices WHERE token=? AND user_id=?').run(token, user.id);
      } else {
        this.db.prepare("UPDATE outbox SET status='cancelled' WHERE device_token=? AND recipient_id<>? AND status='pending'").run(token, user.id);
        this.db.prepare('INSERT INTO devices VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,session_hash=excluded.session_hash').run(token, user.id, user.sessionHash);
      }
    });
  }
  async drainOutbox() {
    if (!this.pushProvider || this.draining) return;
    this.draining = true;
    try {
      const entries = this.db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT 20").all(Date.now());
      for (const entry of entries) {
        const device = this.db.prepare('SELECT d.token FROM devices d JOIN sessions s ON s.hash=d.session_hash WHERE d.token=? AND d.user_id=? AND s.expires_at>?').get(entry.device_token, entry.recipient_id, Date.now());
        if (!device) { this.db.prepare("UPDATE outbox SET status='cancelled' WHERE id=?").run(entry.id); continue; }
        let result;
        try { result = await this.pushProvider.send(device.token); }
        catch { result = { ok: false, retry: true, reason: 'Push connection failed' }; }
        const attempts = entry.attempts + 1;
        const status = result.ok ? 'delivered' : result.retry && attempts < 6 ? 'pending' : 'failed';
        this.db.prepare('UPDATE outbox SET status=?,attempts=?,next_attempt=?,last_error=? WHERE id=?').run(status, attempts,
          Date.now() + Math.min(3600000, 30000 * 2 ** (attempts - 1)), result.ok ? null : String(result.reason).slice(0, 100), entry.id);
        if (result.invalidToken) this.db.prepare('DELETE FROM devices WHERE token=? AND user_id=?').run(device.token, entry.recipient_id);
      }
    } finally { this.draining = false; }
  }
  close() { this.db.close(); }
}
