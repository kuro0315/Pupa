'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Storage } = require('../electron/storage.cjs');
const { DEFAULT_SETTINGS, MAX_TOTAL_BYTES } = require('../electron/history.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pupa-storage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, storage: new Storage(path.join(root, 'data')) };
}

test('missing storage starts with private defaults and does not create files during load', t => {
  const { storage } = fixture(t);
  assert.deepEqual(storage.load(), { settings: { ...DEFAULT_SETTINGS }, entries: [], warning: null });
  assert.equal(fs.existsSync(storage.directory), false);
});

test('memory-only default deletes stale persisted history and its temporary file', t => {
  const { storage } = fixture(t);
  storage.saveHistory([{ text: 'synthetic old history' }]);
  fs.writeFileSync(storage.historyPath + '.tmp', 'synthetic partial history');
  const loaded = storage.load();
  assert.equal(loaded.settings.persistence, false);
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.warning, null);
  assert.equal(fs.existsSync(storage.historyPath), false);
  assert.equal(fs.existsSync(storage.historyPath + '.tmp'), false);
});

test('explicit persistence round-trips JSON including multiline Unicode and escapes', t => {
  const { storage } = fixture(t);
  const settings = { ...DEFAULT_SETTINGS, historyLimit: 100, persistence: true };
  const entries = [{ id: 'synthetic', text: 'こんにちは 🐛\n"quote"\t\\slash\u0000', pinned: true, createdAt: 123 }];
  storage.saveSettings(settings);
  storage.saveHistory(entries);
  assert.deepEqual(storage.load(), { settings, entries, warning: null });
  assert.equal(fs.existsSync(storage.settingsPath + '.tmp'), false);
  assert.equal(fs.existsSync(storage.historyPath + '.tmp'), false);
  assert.equal(JSON.parse(fs.readFileSync(storage.historyPath, 'utf8')).version, 1);
});

test('new storage directories and JSON files have restrictive POSIX permissions', { skip: process.platform === 'win32' }, t => {
  const { storage } = fixture(t);
  storage.saveSettings(DEFAULT_SETTINGS);
  storage.saveHistory([]);
  assert.equal(fs.statSync(storage.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(storage.settingsPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(storage.historyPath).mode & 0o777, 0o600);
  fs.writeFileSync(storage.settingsPath + '.tmp', '{}', { mode: 0o666 });
  fs.chmodSync(storage.settingsPath + '.tmp', 0o666);
  storage.saveSettings(DEFAULT_SETTINGS);
  assert.equal(fs.statSync(storage.settingsPath).mode & 0o777, 0o600);
});

test('corrupt or invalid settings fall back to defaults and delete persisted history', async t => {
  for (const contents of ['{bad json', JSON.stringify({ unknown: true }), JSON.stringify({ persistence: 'true' }), '[]', '"bad"', 'x'.repeat(4097)]) {
    await t.test(`invalid settings ${contents.slice(0, 25)}`, t => {
      const { storage } = fixture(t);
      storage.saveHistory([{ text: 'synthetic sensitive history' }]);
      fs.writeFileSync(storage.settingsPath, contents);
      const loaded = storage.load();
      assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
      assert.deepEqual(loaded.entries, []);
      assert.equal(typeof loaded.warning, 'string');
      assert.equal(fs.existsSync(storage.historyPath), false);
    });
  }
});

test('persisted history absent at startup is an empty history, not an error', t => {
  const { storage } = fixture(t);
  storage.saveSettings({ ...DEFAULT_SETTINGS, persistence: true });
  const loaded = storage.load();
  assert.equal(loaded.settings.persistence, true);
  assert.deepEqual(loaded.entries, []);
  assert.equal(loaded.warning, null);
});

test('invalid history envelopes produce a warning without losing valid settings', async t => {
  for (const contents of ['{bad json', '{}', '[]', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: {} })]) {
    await t.test(contents, t => {
      const { storage } = fixture(t);
      storage.saveSettings({ ...DEFAULT_SETTINGS, persistence: true, historyLimit: 30 });
      fs.writeFileSync(storage.historyPath, contents);
      const loaded = storage.load();
      assert.equal(loaded.settings.persistence, true);
      assert.equal(loaded.settings.historyLimit, 30);
      assert.deepEqual(loaded.entries, []);
      assert.equal(typeof loaded.warning, 'string');
    });
  }
});

test('history files exceeding the serialized-byte safety cap are not loaded', t => {
  const { storage } = fixture(t);
  storage.saveSettings({ ...DEFAULT_SETTINGS, persistence: true });
  fs.writeFileSync(storage.historyPath, '');
  fs.truncateSync(storage.historyPath, MAX_TOTAL_BYTES * 7 + 1);
  const loaded = storage.load();
  assert.deepEqual(loaded.entries, []);
  assert.equal(typeof loaded.warning, 'string');
});

test('history erase is idempotent, and failed deletion surfaces a warning', t => {
  const { storage } = fixture(t);
  assert.doesNotThrow(() => storage.eraseHistory());
  fs.mkdirSync(storage.historyPath, { recursive: true });
  assert.throws(() => storage.eraseHistory());
  const loaded = storage.load();
  assert.equal(loaded.settings.persistence, false);
  assert.equal(typeof loaded.warning, 'string');
  assert.deepEqual(loaded.entries, []);
});

test('atomic save preserves previous settings when serialization fails and cleans temporary file', t => {
  const { storage } = fixture(t);
  storage.saveSettings(DEFAULT_SETTINGS);
  fs.writeFileSync(storage.settingsPath + '.tmp', 'stale partial data');
  const circular = {}; circular.self = circular;
  assert.throws(() => storage.saveSettings(circular));
  assert.deepEqual(JSON.parse(fs.readFileSync(storage.settingsPath, 'utf8')), DEFAULT_SETTINGS);
  assert.equal(fs.existsSync(storage.settingsPath + '.tmp'), false);
});

test('failed rename cleans its temporary file and leaves an existing destination intact', t => {
  const { storage } = fixture(t);
  fs.mkdirSync(storage.settingsPath, { recursive: true });
  fs.writeFileSync(path.join(storage.settingsPath, 'sentinel'), 'unchanged');
  assert.throws(() => storage.saveSettings(DEFAULT_SETTINGS));
  assert.equal(fs.existsSync(storage.settingsPath + '.tmp'), false);
  assert.equal(fs.readFileSync(path.join(storage.settingsPath, 'sentinel'), 'utf8'), 'unchanged');
});

test('unusable storage directories report write failures without fallback to another location', t => {
  const { root } = fixture(t);
  const blocked = path.join(root, 'not-a-directory');
  fs.writeFileSync(blocked, 'synthetic file');
  const storage = new Storage(blocked);
  assert.throws(() => storage.saveSettings(DEFAULT_SETTINGS));
  assert.throws(() => storage.saveHistory([]));
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'synthetic file');
});
