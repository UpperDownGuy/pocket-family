import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFamilies } from '../backup-families.mjs';

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
