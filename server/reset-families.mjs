// Offline maintenance only. This module is never imported by the HTTP server.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, copyFileSync, constants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RESET_CONFIRMATION = 'WIPE-ALL-FAMILIES';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const familyFile = new RegExp(`^${UUID}\\.sqlite(?:-wal|-shm)?$`, 'i');
const familyId = new RegExp(`^${UUID}$`, 'i');
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

function regular(path, { directory = false, optional = false } = {}) {
  let stat;
  try { stat = lstatSync(path, { bigint: true }); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || (!directory && stat.nlink !== 1n)) {
    throw new Error('Refusing a symlink, hard link, or unexpected file type in database storage.');
  }
  return stat;
}

function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'); }

function hashFile(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const hash = createHash('sha256');
    const block = Buffer.alloc(64 * 1024);
    let bytes;
    while ((bytes = readSync(fd, block, 0, block.length, null)) > 0) hash.update(block.subarray(0, bytes));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

function storage(dbPath, { inspectRegistry = true } = {}) {
  if (typeof dbPath !== 'string' || !isAbsolute(dbPath) || resolve(dbPath) !== dbPath
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$/.test(basename(dbPath))) {
    throw new Error('Pass --db-path with the canonical absolute path of the existing .sqlite database.');
  }
  const root = dirname(dbPath);
  for (let path = root; ; path = dirname(path)) {
    regular(path, { directory: true });
    if (dirname(path) === path) break;
  }
  if (!samePath(realpathSync(root), root)) throw new Error('Database storage must not be redirected.');
  const registry = dbPath + '.families.sqlite';
  const families = dbPath + '.families';
  regular(dbPath, { optional: true });
  regular(registry, { optional: true });
  regular(families, { directory: true, optional: true });
  // Never use registry paths as deletion targets. They must match the fixed
  // layout before any backup or removal is allowed.
  if (inspectRegistry && existsSync(registry)) {
    const db = new DatabaseSync(registry, { readOnly: true });
    try {
      for (const row of db.prepare('SELECT id,db_path,is_legacy FROM families').all()) {
        if (!familyId.test(row.id) || ![0, 1].includes(row.is_legacy)) throw new Error('Unexpected family registry entry.');
        const expected = row.is_legacy ? dbPath : join(families, row.id + '.sqlite');
        if (!samePath(row.db_path, expected)) throw new Error('A family registry path is outside the configured database layout.');
      }
    } finally { db.close(); }
  }
  const paths = [];
  for (const base of [dbPath, registry]) {
    for (const suffix of ['', '-wal', '-shm']) if (regular(base + suffix, { optional: true })) paths.push(base + suffix);
  }
  if (existsSync(families)) {
    for (const name of readdirSync(families).sort()) {
      if (!familyFile.test(name)) throw new Error('Unexpected entry in the family database directory; nothing was removed.');
      const path = join(families, name);
      regular(path);
      paths.push(path);
    }
  }
  return { root, families, paths };
}

function durableJSON(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function durableDirectory(path) {
  // Windows cannot open directories through fs.open; the deployed tool runs
  // inside Docker's Linux engine, where directory entries can also be synced.
  if (process.platform === 'win32') return;
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Stop every process using these databases first. Copies and verifies all
 * known SQLite files before unlinking them; never deletes directories/volumes.
 * On failure, retain the backup and keep the API stopped for manual recovery.
 */
export function resetFamilies({ dbPath, confirm } = {}) {
  if (confirm !== RESET_CONFIRMATION) throw new Error('Reset requires --confirm WIPE-ALL-FAMILIES.');
  const target = storage(dbPath);
  if (!target.paths.length) return { status: 'already-empty', removedFiles: 0, backupPath: null };
  const backupPath = join(target.root, '.pocket-family-reset-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID());
  mkdirSync(backupPath, { mode: 0o700 });
  const entries = [];
  for (const source of target.paths) {
    const before = regular(source);
    const name = relative(target.root, source);
    const destination = join(backupPath, name);
    if (dirname(destination) !== backupPath && !existsSync(dirname(destination))) mkdirSync(dirname(destination), { mode: 0o700 });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    const fd = openSync(destination, constants.O_RDWR);
    try { fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); }
    const sha256 = hashFile(destination);
    if (identity(before) !== identity(regular(source)) || hashFile(source) !== sha256) {
      throw new Error('Database files changed during backup. Stop every API process before retrying. No files were removed.');
    }
    entries.push({ path: name, size: Number(before.size), sha256, identity: identity(before) });
  }
  durableJSON(join(backupPath, 'manifest.json'), { version: 1, createdAt: new Date().toISOString(), dbPath,
    files: entries.map(({ identity: _identity, ...entry }) => entry) });
  const familyBackup = join(backupPath, basename(target.families));
  if (existsSync(familyBackup)) durableDirectory(familyBackup);
  durableDirectory(backupPath);
  durableDirectory(target.root);
  // Check the complete set again before the first deletion. A newly opened DB
  // or changing WAL is a reason to stop, never a reason to skip its backup.
  // Opening SQLite again can update its own shared-memory bookkeeping even
  // with a read-only connection. Registry content was validated before backup;
  // compare its raw hash and identity below without reopening the database.
  const current = storage(dbPath, { inspectRegistry: false }).paths;
  if (current.length !== target.paths.length || current.some((path, i) => path !== target.paths[i])) {
    throw new Error('Database file set changed during backup. Nothing was removed.');
  }
  for (let i = 0; i < target.paths.length; i++) {
    if (identity(regular(target.paths[i])) !== entries[i].identity || hashFile(target.paths[i]) !== entries[i].sha256) {
      throw new Error('Database files changed during backup. Nothing was removed.');
    }
  }
  for (const path of target.paths) unlinkSync(path);
  if (existsSync(target.families)) durableDirectory(target.families);
  durableDirectory(target.root);
  durableJSON(join(backupPath, 'reset-complete.json'), { completedAt: new Date().toISOString(), removedFiles: target.paths.length });
  durableDirectory(backupPath);
  return { status: 'reset', removedFiles: target.paths.length, backupPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--version') console.log('pocket-family-reset-v1');
    else {
      if (args.length !== 4 || args[0] !== '--db-path' || args[2] !== '--confirm') {
        throw new Error('Stop the API, then use: node reset-families.mjs --db-path /app/data/pocket.sqlite --confirm WIPE-ALL-FAMILIES');
      }
      console.log(JSON.stringify(resetFamilies({ dbPath: args[1], confirm: args[3] })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
