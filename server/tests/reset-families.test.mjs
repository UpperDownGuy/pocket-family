import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FamilyStore } from '../store.mjs';
import { resetFamilies, RESET_CONFIRMATION } from '../reset-families.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-reset-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dbPath: join(root, 'pocket.sqlite') };
}

function populate(path, name) {
  const store = new FamilyStore(path, { setupCode: 'fixture-code' });
  const session = store.setup({ familyName: name, name: 'Parent', username: 'parent', password: 'parent-password', setupCode: 'fixture-code' });
  const parent = store.authenticate('Bearer ' + session.token);
  const child = store.addMember({ name: 'Child', username: 'child', password: 'child-password', role: 'child' });
  store.createTransaction(parent, { childId: child.id, kind: 'addition', amountCents: 200, merchant: 'Allowance', note: '', idempotencyKey: randomUUID() });
  const created = store.createFTSIssuer(parent, { name: 'Computer', priceCents: 15 });
  const credential = 'fts_' + randomBytes(32).toString('base64url');
  store.pairFTSIssuer({ setupCode: created.setupCode, credential });
  const issuer = store.authenticateFTSIssuer('Bearer ' + credential);
  const code = randomBytes(32).toString('base64url');
  store.issueFTSVoucher(issuer, { code, reports: [{ reportId: randomUUID(), movieCount: 2, priceCents: 15 }] });
  store.close();
  return { token: session.token, credential, code, childId: child.id };
}

function registry(dbPath, rows) {
  const db = new DatabaseSync(dbPath + '.families.sqlite');
  db.exec('CREATE TABLE families(id TEXT PRIMARY KEY,family_code TEXT NOT NULL UNIQUE,db_path TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,is_legacy INTEGER NOT NULL)');
  for (const [index, row] of rows.entries()) db.prepare('INSERT INTO families VALUES (?,?,?,?,?)').run(row.id, 'family-' + index, row.path, new Date().toISOString(), row.legacy ? 1 : 0);
  db.close();
}

test('offline reset removes all families, accounts, sessions, balances and vouchers; verified backups restore them', t => {
  const f = fixture(t);
  const id = randomUUID();
  const otherPath = join(f.dbPath + '.families', id + '.sqlite');
  const first = populate(f.dbPath, 'Legacy family');
  const second = populate(otherPath, 'Other family');
  registry(f.dbPath, [{ id: randomUUID(), path: f.dbPath, legacy: true }, { id, path: otherPath }]);
  const result = resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION });
  assert.equal(result.status, 'reset');
  assert.ok(result.removedFiles >= 3);
  assert.equal(existsSync(f.dbPath), false);
  assert.equal(existsSync(f.dbPath + '.families.sqlite'), false);
  assert.deepEqual(readdirSync(f.dbPath + '.families'), []);
  assert.ok(existsSync(join(result.backupPath, 'reset-complete.json')));
  const manifest = JSON.parse(readFileSync(join(result.backupPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.filter(entry => entry.path.endsWith('.sqlite')).length, 3);
  for (const entry of manifest.files) {
    const content = readFileSync(join(result.backupPath, entry.path));
    assert.equal(content.length, entry.size);
    assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256);
  }
  if (process.platform !== 'win32') {
    assert.equal(statSync(result.backupPath).mode & 0o777, 0o700);
    for (const entry of manifest.files) assert.equal(statSync(join(result.backupPath, entry.path)).mode & 0o777, 0o600);
  }
  const clean = new FamilyStore(f.dbPath, { setupCode: 'new-code' });
  assert.equal(clean.setupRequired, true);
  assert.throws(() => clean.authenticate('Bearer ' + first.token), /Sign in/);
  assert.throws(() => clean.authenticateFTSIssuer('Bearer ' + first.credential));
  assert.equal(clean.db.prepare('SELECT count(*) AS n FROM fts_vouchers').get().n, 0);
  clean.close();
  const restored = join(f.root, 'restored');
  mkdirSync(restored);
  for (const entry of manifest.files) {
    const target = join(restored, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(result.backupPath, entry.path), target);
  }
  for (const [path, original, familyName] of [
    [join(restored, 'pocket.sqlite'), first, 'Legacy family'],
    [join(restored, 'pocket.sqlite.families', id + '.sqlite'), second, 'Other family'],
  ]) {
    const store = new FamilyStore(path, { setupCode: 'unused' });
    const parent = store.authenticate('Bearer ' + original.token);
    assert.equal(store.familyName, familyName);
    assert.equal(store.balance(original.childId), 200);
    assert.equal(store.previewCredit(parent, { code: original.code }).amountCents, 30);
    assert.equal(store.db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    store.close();
  }
});

test('wrong or missing confirmation cannot back up or remove anything', t => {
  const f = fixture(t);
  populate(f.dbPath, 'Keep family');
  for (const confirm of [undefined, '', 'wipe-all-families', 'WIPE-ALL-FAMILIES ']) {
    assert.throws(() => resetFamilies({ dbPath: f.dbPath, confirm }), /confirm/);
  }
  assert.deepEqual(readdirSync(f.root), ['pocket.sqlite']);
});

test('empty storage is a no-op, requiring confirmation and an explicit canonical path', t => {
  const f = fixture(t);
  assert.deepEqual(resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION }), { status: 'already-empty', removedFiles: 0, backupPath: null });
  for (const dbPath of ['pocket.sqlite', join(f.root, '..', 'not-a-database'), f.root, f.dbPath + '/..']) {
    assert.throws(() => resetFamilies({ dbPath, confirm: RESET_CONFIRMATION }), /canonical/);
  }
  assert.deepEqual(readdirSync(f.root), []);
});

test('unexpected family directory entries and out-of-layout registry paths stop before backup or removal', t => {
  const f = fixture(t);
  populate(f.dbPath, 'Keep family');
  mkdirSync(f.dbPath + '.families');
  const unexpected = join(f.dbPath + '.families', 'notes.txt');
  writeFileSync(unexpected, 'preserve me');
  assert.throws(() => resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION }), /Unexpected entry/);
  assert.equal(readFileSync(unexpected, 'utf8'), 'preserve me');
  rmSync(unexpected);
  registry(f.dbPath, [{ id: randomUUID(), path: join(f.root, 'unrelated.sqlite') }]);
  assert.throws(() => resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION }), /outside/);
  assert.ok(existsSync(f.dbPath));
  assert.equal(readdirSync(f.root).some(name => name.startsWith('.pocket-family-reset-')), false);
});

test('symlinked family directories are refused', t => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'untouched'), 'keep');
  try { symlinkSync(outside, f.dbPath + '.families', process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('This Windows account cannot create junctions.'); throw error; }
  assert.throws(() => resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION }), /symlink/);
  assert.equal(readFileSync(join(outside, 'untouched'), 'utf8'), 'keep');
});

test('hard-linked database paths are refused without touching either link', t => {
  const f = fixture(t);
  populate(f.dbPath, 'Keep family');
  const other = join(f.root, 'other.sqlite');
  linkSync(f.dbPath, other);
  assert.throws(() => resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION }), /hard link/);
  assert.ok(existsSync(f.dbPath));
  assert.ok(existsSync(other));
});

test('a stopped database with committed WAL data can be restored from the backup', t => {
  const f = fixture(t);
  const create = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('committed in WAL');");
    process.exit(0);
  `, f.dbPath], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  assert.ok(existsSync(f.dbPath + '-wal'));
  const result = resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION });
  const backupDb = new DatabaseSync(join(result.backupPath, 'pocket.sqlite'));
  try { assert.equal(backupDb.prepare('SELECT value FROM proof').get().value, 'committed in WAL'); }
  finally { backupDb.close(); }
});

test('backup preserves exact WAL and SHM bytes and leaves unrelated files, TLS, and older backups alone', t => {
  const f = fixture(t);
  populate(f.dbPath, 'Keep family');
  // Stopped SQLite databases normally checkpoint on close. Explicit fixture
  // sidecars exercise raw-file preservation without a live database process.
  writeFileSync(f.dbPath + '-wal', Buffer.from('fixture wal bytes'));
  writeFileSync(f.dbPath + '-shm', Buffer.from('fixture shm bytes'));
  writeFileSync(join(f.root, 'certificate.pem'), 'fixture certificate');
  const old = join(f.root, '.pocket-family-reset-previous');
  mkdirSync(old);
  writeFileSync(join(old, 'keep'), 'previous backup');
  const result = resetFamilies({ dbPath: f.dbPath, confirm: RESET_CONFIRMATION });
  assert.equal(readFileSync(join(result.backupPath, 'pocket.sqlite-wal'), 'utf8'), 'fixture wal bytes');
  assert.equal(readFileSync(join(result.backupPath, 'pocket.sqlite-shm'), 'utf8'), 'fixture shm bytes');
  assert.equal(readFileSync(join(f.root, 'certificate.pem'), 'utf8'), 'fixture certificate');
  assert.equal(readFileSync(join(old, 'keep'), 'utf8'), 'previous backup');
});

test('CLI rejects missing explicit flags and importing the maintenance module never resets data', t => {
  const f = fixture(t);
  populate(f.dbPath, 'Keep family');
  const cli = fileURLToPath(new URL('../reset-families.mjs', import.meta.url));
  const invalid = spawnSync(process.execPath, [cli, '--db-path', f.dbPath], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.ok(existsSync(f.dbPath));
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), 'pocket-family-reset-v1');
  assert.ok(existsSync(f.dbPath));
});
