// Standalone online backup helper; Docker may mount this outside the API image.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function ordinary(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.nlink !== 1)) {
    throw new Error('Backup storage must contain ordinary files and directories.');
  }
}

export function backupFamilies(dbPath) {
  if (!isAbsolute(dbPath) || resolve(dbPath) !== dbPath || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$/.test(basename(dbPath))) {
    throw new Error('Use the absolute path of the Pocket .sqlite database.');
  }
  const root = dirname(dbPath);
  for (let current = root; ; current = dirname(current)) {
    ordinary(current, true);
    if (dirname(current) === current) break;
  }
  const actual = realpathSync(root);
  if (process.platform === 'win32' ? actual.toLowerCase() !== root.toLowerCase() : actual !== root) throw new Error('Database storage is redirected.');
  const backupRoot = join(root, 'family-backups');
  if (!existsSync(backupRoot)) mkdirSync(backupRoot, { mode: 0o700 });
  ordinary(backupRoot, true);
  const destination = join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  mkdirSync(destination, { mode: 0o700 });
  const files = [];
  const snapshot = (source) => {
    ordinary(source);
    const name = relative(root, source);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const live = new DatabaseSync(source, { readOnly: true });
    try {
      live.exec('PRAGMA busy_timeout=10000;');
      // SQLite produces a consistent snapshot, including committed WAL data.
      live.prepare('VACUUM INTO ?').run(target);
    } finally { live.close(); }
    const copy = new DatabaseSync(target, { readOnly: true });
    try {
      if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
    } finally { copy.close(); }
    files.push({ path: name, sha256: createHash('sha256').update(readFileSync(target)).digest('hex') });
    return target;
  };
  const registryPath = dbPath + '.families.sqlite';
  const hasTombstones = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deleted_families'").get());
  let registryCopy;
  const capturedFamilies = new Map();
  // Snapshot membership first. Family deletion retains each SQLite file and
  // records a tombstone before clearing it, so every captured path still exists.
  if (existsSync(registryPath)) {
    registryCopy = snapshot(registryPath);
    const registry = new DatabaseSync(registryCopy, { readOnly: true });
    try {
      const families = registry.prepare('SELECT id,db_path,is_legacy FROM families').all();
      if (hasTombstones(registry)) families.push(...registry.prepare('SELECT family_id AS id,db_path,is_legacy,cleared_at FROM deleted_families').all());
      for (const family of families) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(family.id) || ![0, 1].includes(family.is_legacy)) {
          throw new Error('Invalid family registry.');
        }
        const expected = family.is_legacy ? dbPath : join(dbPath + '.families', family.id + '.sqlite');
        if (family.db_path !== expected) throw new Error('Family database is outside the configured storage layout.');
        const previous = capturedFamilies.get(family.id);
        if (previous && (previous.db_path !== expected || previous.is_legacy !== family.is_legacy)) throw new Error('Conflicting family tombstone path.');
        if (previous) { previous.cleared_at ||= family.cleared_at; continue; }
        capturedFamilies.set(family.id, { ...family });
      }
      for (const family of capturedFamilies.values()) {
        const expected = family.db_path;
        // Older backups can omit already-cleared files. Preserve their
        // completed tombstones without inventing a pending, missing database.
        if (!existsSync(expected) && family.cleared_at) { family.missingCompleted = true; continue; }
        ordinary(expected);
        if (!family.is_legacy) {
          ordinary(dirname(expected), true);
          snapshot(expected);
        }
      }
    } finally { registry.close(); }
  }
  if (existsSync(dbPath)) snapshot(dbPath);
  if (registryCopy) {
    // A deletion can begin after the registry snapshot and clear a database
    // before its later snapshot. Reconcile those tombstones into the copy so
    // restore cannot mistake an intentionally cleared family for corruption.
    ordinary(registryPath);
    const liveRegistry = new DatabaseSync(registryPath, { readOnly: true });
    let tombstones;
    try {
      liveRegistry.exec('PRAGMA busy_timeout=10000;');
      tombstones = hasTombstones(liveRegistry) ? liveRegistry.prepare('SELECT * FROM deleted_families').all() : [];
    } finally { liveRegistry.close(); }
    const registry = new DatabaseSync(registryCopy);
    try {
      const capturedTombstones = tombstones.filter(row => capturedFamilies.has(row.family_id));
      if (capturedTombstones.length || hasTombstones(registry)) {
        registry.exec(`CREATE TABLE IF NOT EXISTS deleted_families (
          family_id TEXT PRIMARY KEY,family_code TEXT NOT NULL UNIQUE,db_path TEXT NOT NULL UNIQUE,
          is_legacy INTEGER NOT NULL,deleted_at TEXT NOT NULL,cleared_at TEXT); BEGIN IMMEDIATE;`);
        try {
          for (const row of capturedTombstones) {
            const family = capturedFamilies.get(row.family_id);
            if (row.db_path !== family.db_path || row.is_legacy !== family.is_legacy || typeof row.deleted_at !== 'string' || !row.deleted_at) {
              throw new Error('Invalid family tombstone in the live registry.');
            }
            registry.prepare(`INSERT INTO deleted_families (family_id,family_code,db_path,is_legacy,deleted_at,cleared_at)
              VALUES (?,?,?,?,?,?) ON CONFLICT(family_id) DO UPDATE SET deleted_at=excluded.deleted_at,cleared_at=excluded.cleared_at`)
              .run(row.family_id, row.family_code, row.db_path, row.is_legacy, row.deleted_at, family.missingCompleted ? family.cleared_at : null);
            registry.prepare('DELETE FROM families WHERE id=?').run(row.family_id);
          }
          // A family snapshot can predate its completed clear. Re-run deletion
          // on restore rather than trusting the live completion timestamp.
          for (const family of capturedFamilies.values()) {
            if (!family.missingCompleted) registry.prepare('UPDATE deleted_families SET cleared_at=NULL WHERE family_id=?').run(family.id);
          }
          registry.exec('COMMIT;');
        } catch (error) { registry.exec('ROLLBACK;'); throw error; }
      }
      if (registry.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Reconciled registry integrity check failed.');
    } finally { registry.close(); }
    const entry = files.find(file => file.path === relative(root, registryPath));
    entry.sha256 = createHash('sha256').update(readFileSync(registryCopy)).digest('hex');
  }
  if (files.length === 0) throw new Error('No Pocket databases were found to back up.');
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify({ version: 1, dbPath, createdAt: new Date().toISOString(), files }, null, 2), { flag: 'wx', mode: 0o600 });
  return { backupDirectory: destination, databases: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--db-path') throw new Error('Usage: node backup-families.mjs --db-path /app/data/pocket.sqlite');
    console.log(JSON.stringify(backupFamilies(args[1])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
