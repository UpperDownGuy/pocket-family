const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('prebuild requests only Reminders access and removes Android Calendar permissions', () => {
  const root = path.dirname(require.resolve('../package.json'));
  // Exercise the real app config and installed plugins, without generating
  // native projects or importing React Native modules in this Node process.
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/expo/bin/cli'), 'config', '--type', 'introspect', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' },
  });
  assert.equal(result.error, undefined, 'Expo config introspection must start successfully.');
  assert.equal(result.status, 0, 'Expo config introspection must finish successfully.');
  const config = JSON.parse(result.stdout);
  const generated = config._internal.modResults;
  const plist = generated.ios.infoPlist;
  assert.match(plist.NSRemindersUsageDescription, /Pocket.*subscription/i);
  assert.match(plist.NSRemindersFullAccessUsageDescription, /Pocket.*subscription/i);
  assert.deepEqual(Object.keys(plist).filter(key => key.startsWith('NSCalendars')), [], 'Reminders sync must not request access to Calendar events.');
  const permissions = generated.android.manifest.manifest['uses-permission'];
  for (const name of ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR']) {
    const entries = permissions.filter(entry => entry.$['android:name'] === name);
    assert.ok(entries.length > 0, `Generated manifest must explicitly remove ${name}.`);
    assert.ok(entries.every(entry => entry.$['tools:node'] === 'remove'), `${name} must be removed, including permissions inherited from the library.`);
  }
});
