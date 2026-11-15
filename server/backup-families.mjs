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
  // Snapshot membership first. The API never deletes family stores; all stores
  // referenced by this registry snapshot therefore remain available to copy.
  if (existsSync(registryPath)) {
    const registryCopy = snapshot(registryPath);
    const registry = new DatabaseSync(registryCopy, { readOnly: true });
    try {
      for (const family of registry.prepare('SELECT id,db_path,is_legacy FROM families').all()) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(family.id) || ![0, 1].includes(family.is_legacy)) {
          throw new Error('Invalid family registry.');
        }
        const expected = family.is_legacy ? dbPath : join(dbPath + '.families', family.id + '.sqlite');
        if (family.db_path !== expected) throw new Error('Family database is outside the configured storage layout.');
        if (!family.is_legacy) {
          ordinary(dirname(expected), true);
          snapshot(expected);
        }
      }
    } finally { registry.close(); }
  }
  if (existsSync(dbPath)) snapshot(dbPath);
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
