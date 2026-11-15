import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFamilies } from '../backup-families.mjs';
import { FamilyRegistry } from '../store.mjs';

test('online backup snapshots every registered family including committed WAL changes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-online-backup-')));
  const path = join(root, 'pocket.sqlite');
  const open = [];
  try {
    const registry = new DatabaseSync(path + '.families.sqlite'); open.push(registry);
    registry.exec('PRAGMA journal_mode=WAL; CREATE TABLE families(id TEXT,db_path TEXT,is_legacy INTEGER);');
    mkdirSync(path + '.families');
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const dbPath = i === 0 ? path : join(path + '.families', id + '.sqlite');
      const family = new DatabaseSync(dbPath); open.push(family);
      family.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE balances(value INTEGER);');
      family.prepare('INSERT INTO balances VALUES (?)').run(i * 150);
      registry.prepare('INSERT INTO families VALUES (?,?,?)').run(id, dbPath, i === 0 ? 1 : 0);
    }
    const result = backupFamilies(path);
    assert.equal(result.databases, 4);
    const manifest = JSON.parse(readFileSync(join(result.backupDirectory, 'manifest.json')));
    const amounts = [];
    for (const file of manifest.files) {
      const target = join(result.backupDirectory, file.path);
      assert.equal(createHash('sha256').update(readFileSync(target)).digest('hex'), file.sha256);
      const db = new DatabaseSync(target, { readOnly: true });
      try {
        if (file.path.endsWith('.families.sqlite')) assert.equal(db.prepare('SELECT count(*) n FROM families').get().n, 3);
        else amounts.push(db.prepare('SELECT value FROM balances').get().value);
      } finally { db.close(); }
    }
    assert.deepEqual(amounts.sort((a, b) => a - b), [0, 150, 300]);
    // Snapshot does not hold locks or change the active database.
    open[1].prepare('INSERT INTO balances VALUES (?)').run(999);
    assert.equal(open[1].prepare('SELECT count(*) n FROM balances').get().n, 2);
  } finally {
    for (const db of open.reverse()) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy-only deployment backs up without a registry and unsafe registry paths fail', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-online-backup-')));
  const path = join(root, 'pocket.sqlite');
  const db = new DatabaseSync(path);
  let registry;
  try {
    db.exec('CREATE TABLE value(n INTEGER); INSERT INTO value VALUES (42);');
    assert.equal(backupFamilies(path).databases, 1);
    registry = new DatabaseSync(path + '.families.sqlite');
    registry.exec('CREATE TABLE families(id TEXT,db_path TEXT,is_legacy INTEGER);');
    registry.prepare('INSERT INTO families VALUES (?,?,0)').run(randomUUID(), join(root, 'wrong.sqlite'));
    assert.throws(() => backupFamilies(path), /outside the configured storage layout/);
    assert.equal(db.prepare('SELECT n FROM value').get().n, 42);
    assert.throws(() => backupFamilies('../pocket.sqlite'), /absolute path/);
  } finally { registry?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

function deletionFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-backup-delete-')));
  const path = join(root, 'pocket.sqlite');
  const id = randomUUID();
  const familyPath = join(path + '.families', id + '.sqlite');
  mkdirSync(path + '.families');
  const registry = new DatabaseSync(path + '.families.sqlite');
  const family = new DatabaseSync(familyPath);
  const legacy = new DatabaseSync(path);
  registry.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE families(id TEXT PRIMARY KEY,family_code TEXT,db_path TEXT,is_legacy INTEGER);
    CREATE TABLE deleted_families(family_id TEXT PRIMARY KEY,family_code TEXT NOT NULL UNIQUE,
      db_path TEXT NOT NULL UNIQUE,is_legacy INTEGER NOT NULL,deleted_at TEXT NOT NULL,cleared_at TEXT);`);
  registry.prepare('INSERT INTO families VALUES (?,?,?,0)').run(id, '01234567', familyPath);
  family.exec('PRAGMA journal_mode=WAL; CREATE TABLE balances(value INTEGER); INSERT INTO balances VALUES (150);');
  legacy.exec('CREATE TABLE value(n INTEGER);');
  const deletedAt = '2026-11-15T18:00:00.000Z';
  function deleteFamily() {
    registry.prepare('INSERT INTO deleted_families VALUES (?,?,?,0,?,NULL)').run(id, '01234567', familyPath, deletedAt);
    family.exec('DELETE FROM balances;');
    registry.prepare('DELETE FROM families WHERE id=?').run(id);
    registry.prepare('UPDATE deleted_families SET cleared_at=? WHERE family_id=?').run(deletedAt, id);
  }
  t.after(() => { legacy.close(); family.close(); registry.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, path, id, familyPath, registry, family, legacy, deleteFamily, deletedAt };
}

function assertDeletedBackup(result, f, retainedRows) {
  const copy = new DatabaseSync(join(result.backupDirectory, 'pocket.sqlite.families.sqlite'), { readOnly: true });
  try {
    assert.equal(copy.prepare('SELECT count(*) n FROM families WHERE id=?').get(f.id).n, 0);
    const tombstone = copy.prepare('SELECT * FROM deleted_families WHERE family_id=?').get(f.id);
    assert.equal(tombstone.deleted_at, f.deletedAt);
    assert.equal(tombstone.db_path, f.familyPath);
    assert.equal(tombstone.cleared_at, null, 'restore must reapply deletion if a family snapshot predates clearing');
  } finally { copy.close(); }
  const family = new DatabaseSync(join(result.backupDirectory, 'pocket.sqlite.families', f.id + '.sqlite'), { readOnly: true });
  try { assert.equal(family.prepare('SELECT count(*) n FROM balances').get().n, retainedRows); }
  finally { family.close(); }
  const manifest = JSON.parse(readFileSync(join(result.backupDirectory, 'manifest.json')));
  assert.equal(manifest.files.length, 3);
  for (const file of manifest.files) assert.equal(createHash('sha256').update(readFileSync(join(result.backupDirectory, file.path))).digest('hex'), file.sha256);
}

test('backup includes already deleted family files and forces safe cleanup on restore', t => {
  const f = deletionFixture(t);
  f.deleteFamily();
  const result = backupFamilies(f.path);
  assertDeletedBackup(result, f, 0);
  assert.equal(f.registry.prepare('SELECT cleared_at FROM deleted_families').get().cleared_at, f.deletedAt, 'backup never changes live tombstones');
});

for (const stage of ['registry', 'family']) {
  test(`deletion after ${stage} snapshot reconciles a coherent backup without blocking live writes`, t => {
    const f = deletionFixture(t);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let deleted = false;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      const statement = originalPrepare.call(this, sql);
      if (sql !== 'VACUUM INTO ?') return statement;
      return { run(target) {
        const result = statement.run(target);
        const trigger = stage === 'registry' ? target.endsWith('pocket.sqlite.families.sqlite') : target.endsWith(f.id + '.sqlite');
        if (trigger && !deleted) { deleted = true; f.deleteFamily(); }
        return result;
      } };
    });
    const result = backupFamilies(f.path);
    assert.ok(deleted);
    assertDeletedBackup(result, f, stage === 'family' ? 1 : 0);
  });
}

test('unsafe deleted-family registry paths fail without touching live data', t => {
  const f = deletionFixture(t);
  f.deleteFamily();
  f.registry.prepare('UPDATE deleted_families SET db_path=?').run(join(f.root, 'elsewhere.sqlite'));
  assert.throws(() => backupFamilies(f.path), /outside the configured storage layout/);
  assert.equal(f.registry.prepare('SELECT count(*) n FROM deleted_families').get().n, 1);
});

test('completed tombstones from older backups may omit empty files; pending deletions may not', t => {
  const f = deletionFixture(t);
  const missingId = randomUUID();
  const missingPath = join(f.path + '.families', missingId + '.sqlite');
  f.registry.prepare('INSERT INTO deleted_families VALUES (?,?,?,0,?,?)')
    .run(missingId, '87654321', missingPath, f.deletedAt, f.deletedAt);
  const result = backupFamilies(f.path);
  const copy = new DatabaseSync(join(result.backupDirectory, 'pocket.sqlite.families.sqlite'), { readOnly: true });
  try { assert.equal(copy.prepare('SELECT cleared_at FROM deleted_families WHERE family_id=?').get(missingId).cleared_at, f.deletedAt); }
  finally { copy.close(); }
  f.registry.prepare('UPDATE deleted_families SET cleared_at=NULL WHERE family_id=?').run(missingId);
  assert.throws(() => backupFamilies(f.path), { code: 'ENOENT' });
});

test('restore reapplies a concurrent real-family deletion and keeps the other family session usable', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-backup-restore-')));
  const path = join(root, 'pocket.sqlite');
  let registry = new FamilyRegistry(path, { setupCode: 'fixture-setup' });
  try {
    const deleted = registry.create({ familyName: 'Delete this family', name: 'Parent', username: 'parent', password: 'fixture-password' });
    const kept = registry.create({ familyName: 'Keep this family', name: 'Other parent', username: 'parent', password: 'fixture-password' });
    const context = registry.authenticated('Bearer ' + deleted.token);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let deletion;
    t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
      const statement = originalPrepare.call(this, sql);
      if (sql !== 'VACUUM INTO ?') return statement;
      return { run(target) {
        const result = statement.run(target);
        if (target.endsWith(context.family.id + '.sqlite') && !deletion) {
          deletion = registry.deleteFamily(context.family, context.store, context.actor, { confirmation: 'DELETE-FAMILY', familyCode: deleted.familyCode });
        }
        return result;
      } };
    });
    const backup = backupFamilies(path);
    assert.ok(deletion);
    await deletion;
    registry.close();
    registry = null;
    const manifest = JSON.parse(readFileSync(join(backup.backupDirectory, 'manifest.json')));
    // Restore only into this test's original, now-closed storage paths. The
    // copied family contains pre-deletion accounts; its tombstone must clear it.
    for (const file of manifest.files) copyFileSync(join(backup.backupDirectory, file.path), join(root, file.path));
    registry = new FamilyRegistry(path, { setupCode: 'fixture-setup' });
    assert.equal(registry.list().length, 1);
    assert.equal(registry.authenticated('Bearer ' + kept.token).store.familyName, 'Keep this family');
    assert.throws(() => registry.authenticated('Bearer ' + deleted.token), error => error.status === 401);
    const cleared = new DatabaseSync(context.family.db_path, { readOnly: true });
    try { assert.equal(cleared.prepare('SELECT count(*) n FROM members').get().n, 0); }
    finally { cleared.close(); }
  } finally { registry?.close(); rmSync(root, { recursive: true, force: true }); }
});
