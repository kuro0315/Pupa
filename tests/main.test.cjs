'use strict';
// Exercise the actual main-process source with isolated fake Electron services.
// No Electron process, OS clipboard, live shortcut, or user profile is accessed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { Storage } = require('../electron/storage.cjs');
const { DEFAULT_SETTINGS, MAX_TEXT_BYTES } = require('../electron/history.cjs');
const mainPath = path.resolve(__dirname, '../electron/main.cjs');
const localRequire = createRequire(mainPath);
const normalize = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const plainItem = text => ({ types: ['text/plain'], getType: async () => new Blob([text], { type: 'text/plain' }) });

async function harness(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pupa-main-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prepared = new Storage(directory);
  if (!options.firstRun) prepared.saveSettings({ ...DEFAULT_SETTINGS, ...options.settings });
  if (options.entries) prepared.saveHistory(options.entries);
  const ipc = new Map();
  const faults = {};
  let store, window, tray, timer, bootPromise;
  let items = [plainItem('synthetic prelaunch')];
  let reads = 0;
  const writes = [];
  const registered = new Map();
  const refusedShortcuts = new Set(options.refusedShortcuts || []);
  const unregistered = [];
  const errors = [];
  const timeouts = [];
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true, setName: () => {}, setDesktopName: () => {}, setPath: () => {},
    getPath: name => { assert.equal(name, 'userData'); return directory; },
    requestSingleInstanceLock: () => options.gotLock !== false,
    whenReady: () => ({ then: callback => { bootPromise = Promise.resolve().then(callback); return bootPromise; } }),
    getVersion: () => '0.1.0', quit: () => { app.quitCalls++; }, quitCalls: 0,
  });
  class FakeWindow extends EventEmitter {
    constructor(config) {
      super(); window = this; this.config = config; this.visible = config.show; this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.send = (...args) => this.sent.push(args);
      this.webContents.setWindowOpenHandler = fn => { this.openHandler = fn; };
      this.webContents.isDestroyed = () => false;
    }
    removeMenu() {} isDestroyed() { return false; }
    setBounds(value) { this.bounds = value; } getBounds() { return this.bounds; }
    show() { this.visible = true; } hide() { this.visible = false; }
    focus() { this.focused = true; } isFocused() { return this.focused; } isVisible() { return this.visible; }
    async loadFile(file) { this.loadedFile = file; this.webContents.mainFrame.url = pathToFileURL(file).href; }
  }
  class FakeTray extends EventEmitter {
    constructor() { super(); if (options.trayFails) throw new Error('synthetic tray unavailable'); tray = this; this.destroyed = false; }
    isDestroyed() { return this.destroyed; } setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; } destroy() { this.destroyed = true; }
  }
  class FaultableStorage extends Storage {
    constructor(...args) { super(...args); store = this; }
    saveSettings(...args) { if (faults.saveSettings) throw Object.assign(new Error('synthetic settings write error'), { code: 'EIO' }); return super.saveSettings(...args); }
    saveHistory(...args) { if (faults.saveHistory) throw Object.assign(new Error('synthetic history write error'), { code: 'EIO' }); return super.saveHistory(...args); }
    eraseHistory(...args) { if (faults.eraseHistory) throw Object.assign(new Error('synthetic history erase error'), { code: 'EACCES' }); return super.eraseHistory(...args); }
  }
  const localSession = {
    setPermissionRequestHandler(fn) { this.permissionRequest = fn; },
    setPermissionCheckHandler(fn) { this.permissionCheck = fn; },
    webRequest: { onBeforeRequest(filter, fn) { localSession.networkFilter = filter; localSession.networkRequest = fn; } },
  };
  const clipboard = {
    async read() { reads++; return options.read ? options.read() : items; },
    async write(value) { writes.push(value); if (faults.writeClipboard) throw new Error('synthetic clipboard denied'); if (faults.pendingWrite) await faults.pendingWrite.promise; items = value.map(item => plainItem(item.data['text/plain'])); },
  };
  const globalShortcut = {
    register(key, fn) { if (refusedShortcuts.has(key)) return false; registered.set(key, fn); return true; },
    unregister(key) { registered.delete(key); unregistered.push(key); },
    unregisterAll() { registered.clear(); },
  };
  const screen = new EventEmitter();
  screen.getCursorScreenPoint = () => ({ x: 800, y: 200 });
  screen.getDisplayNearestPoint = () => ({ workArea: options.workArea || { x: -1200, y: 50, width: 1200, height: 800 } });
  const powerMonitor = new EventEmitter();
  const electron = { app, BrowserWindow: FakeWindow, ipcMain: { handle: (channel, fn) => ipc.set(channel, fn) }, clipboard,
    ClipboardItem: class { constructor(data) { this.data = data; } }, globalShortcut, Tray: FakeTray,
    Menu: { buildFromTemplate: value => value }, nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) }, screen,
    session: { fromPartition: (partition, config) => { localSession.partition = partition; localSession.config = config; return localSession; } }, powerMonitor };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './storage.cjs' ? { Storage: FaultableStorage } : localRequire(name),
    __dirname: path.dirname(mainPath), process: { platform: 'linux', env: options.env || {} },
    console: { error: (...args) => errors.push(args) }, Buffer,
    setInterval: (fn, delay) => { timer = { fn, delay, cleared: false }; return timer; },
    clearInterval: value => { if (value) value.cleared = true; }, global: {},
    setTimeout: (fn, delay) => { const task = { fn, delay, cleared: false }; timeouts.push(task); return task; },
    clearTimeout: task => { if (task) task.cleared = true; },
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  if (bootPromise) await bootPromise;
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const call = (channel, value, suppliedEvent) => ipc.get(`pupa:${channel}`)(suppliedEvent || event(), value);
  return { app, window, tray, screen, powerMonitor, session: localSession, faults, ipc, store, directory, registered, unregistered, timeouts,
    refusedShortcuts, errors, writes, context, call, state: () => call('state'),
    tick: () => timer.fn(), setText: text => { items = [plainItem(text)]; }, setItems: value => { items = value; },
    get reads() { return reads; }, get timer() { return timer; } };
}

test('production boots hidden on later launches, discards prelaunch clipboard, and polls at 700ms', async t => {
  const h = await harness(t);
  assert.deepEqual(h.errors, []);
  assert.equal(h.window.visible, false);
  assert.equal((await h.state()).entries.length, 0);
  assert.equal(h.reads, 1);
  assert.equal(h.timer.delay, 700);
  assert.equal(h.registered.has(DEFAULT_SETTINGS.shortcut), true);
  h.setText('new synthetic clip'); await h.tick();
  assert.equal((await h.state()).entries[0].text, 'new synthetic clip');
  assert.equal(fs.existsSync(h.store.historyPath), false, 'default polling never persists text');
  assert.deepEqual(normalize(h.window.bounds || h.window.config).width, 780);
});

test('first run and a missing shortcut or tray show an accessible window', async t => {
  for (const options of [{ firstRun: true }, { refusedShortcuts: [DEFAULT_SETTINGS.shortcut] }, { trayFails: true }]) {
    const h = await harness(t, options);
    assert.equal(h.window.visible, true);
  }
});

test('secondary instances quit without creating a window or accessing clipboard', async t => {
  const h = await harness(t, { gotLock: false });
  assert.equal(h.app.quitCalls, 1);
  assert.equal(h.window, undefined);
  assert.equal(h.reads, 0);
});

test('renderer is sandboxed with isolation and permissions/network/window navigation denied', async t => {
  const h = await harness(t);
  const pref = h.window.config.webPreferences;
  assert.equal(pref.sandbox, true);
  assert.equal(pref.contextIsolation, true);
  assert.equal(pref.nodeIntegration, false);
  assert.equal(pref.webSecurity, true);
  assert.equal(pref.webviewTag, false);
  assert.equal(pref.spellcheck, false);
  assert.equal(pref.devTools, false);
  assert.equal(pref.session, h.session);
  assert.equal(h.session.partition.startsWith('persist:'), false);
  assert.equal(h.session.config.cache, false);
  assert.equal(h.session.permissionCheck(), false);
  let permission;
  h.session.permissionRequest(null, 'clipboard-read', result => { permission = result; });
  assert.equal(permission, false);
  assert.deepEqual(normalize(h.session.networkFilter.urls), ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']);
  let network;
  h.session.networkRequest({ url: 'https://example.invalid' }, value => { network = value; });
  assert.deepEqual(normalize(network), { cancel: true });
  assert.deepEqual(normalize(h.window.openHandler({ url: 'https://example.invalid' })), { action: 'deny' });
  for (const type of ['will-navigate', 'will-attach-webview']) {
    let prevented = false;
    h.window.webContents.emit(type, { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  }
});

test('IPC requires the exact app webContents, main frame, and loaded file URL', async t => {
  const h = await harness(t);
  const good = { sender: h.window.webContents, senderFrame: h.window.webContents.mainFrame };
  await assert.rejects(h.call('state', undefined, { ...good, sender: {} }));
  await assert.rejects(h.call('state', undefined, { ...good, senderFrame: { url: good.senderFrame.url } }));
  const url = good.senderFrame.url;
  good.senderFrame.url = 'https://example.invalid';
  await assert.rejects(h.call('state', undefined, good));
  good.senderFrame.url = url;
  assert.equal((await h.state()).settings.persistence, false);
});

test('entry mutations reject unknown, malformed, or oversize IDs and preserve history', async t => {
  const h = await harness(t);
  h.setText('valid synthetic entry'); await h.tick();
  for (const action of ['copy', 'delete', 'pin']) {
    for (const id of [null, {}, 1, 'missing', 'x'.repeat(101)]) assert.equal((await h.call(action, id)).ok, false);
  }
  assert.equal((await h.state()).entries.length, 1);
  assert.equal(h.writes.length, 0);
  assert.equal((await h.call('pause', 'true')).ok, false);
  assert.equal((await h.state()).paused, false);
});

test('copy writes only plain text, hides by default, and does not recapture its own write', async t => {
  const h = await harness(t);
  h.setText('<script>synthetic clipboard text</script>'); await h.tick();
  const entry = (await h.state()).entries[0];
  h.app.emit('activate');
  assert.equal(h.window.visible, true);
  assert.equal((await h.call('copy', entry.id)).ok, true);
  assert.deepEqual(normalize(h.writes[0][0].data), { 'text/plain': entry.text });
  assert.equal(h.window.visible, false);
  await h.tick();
  assert.equal((await h.state()).entries.length, 1);
  assert.equal((await h.state()).entries[0].createdAt, entry.createdAt);
});

test('copy failure is reported, retains the window, and resets capture baseline safely', async t => {
  const h = await harness(t);
  h.setText('card'); await h.tick();
  const id = (await h.state()).entries[0].id;
  h.app.emit('activate');
  h.faults.writeClipboard = true;
  assert.equal((await h.call('copy', id)).ok, false);
  assert.equal(h.window.visible, true);
  h.setText('new baseline after failed copy'); await h.tick();
  assert.equal((await h.state()).entries.length, 1);
  h.setText('new after baseline'); await h.tick();
  assert.equal((await h.state()).entries.length, 2);
});

test('polling during an asynchronous app copy cannot resurrect a deleted current clipboard entry', async t => {
  const h = await harness(t);
  h.setText('keep this card'); await h.tick();
  const keepId = (await h.state()).entries[0].id;
  h.setText('deleted clipboard content'); await h.tick();
  await h.call('delete', (await h.state()).entries[0].id);
  h.faults.pendingWrite = deferred();
  const copying = h.call('copy', keepId);
  await h.tick();
  h.faults.pendingWrite.resolve();
  assert.equal((await copying).ok, true);
  await h.tick();
  assert.deepEqual((await h.state()).entries.map(entry => entry.text), ['keep this card']);
});

test('concurrent copy requests are rejected without starting overlapping clipboard writes', async t => {
  const h = await harness(t);
  h.setText('card one'); await h.tick();
  h.setText('card two'); await h.tick();
  const entries = (await h.state()).entries;
  h.faults.pendingWrite = deferred();
  const first = h.call('copy', entries[0].id);
  assert.equal((await h.call('copy', entries[1].id)).ok, false);
  assert.equal(h.writes.length, 1);
  h.faults.pendingWrite.resolve();
  assert.equal((await first).ok, true);
});

for (const event of ['pause-resume', 'lock-unlock', 'suspend-resume']) {
  test(`${event} does not reactivate polling in the middle of a pending clipboard write`, async t => {
    const h = await harness(t);
    h.setText('card'); await h.tick();
    const id = (await h.state()).entries[0].id;
    h.faults.pendingWrite = deferred();
    const copying = h.call('copy', id);
    if (event === 'pause-resume') { await h.call('pause', true); await h.call('pause', false); }
    if (event === 'lock-unlock') { h.powerMonitor.emit('lock-screen'); h.powerMonitor.emit('unlock-screen'); }
    if (event === 'suspend-resume') { h.powerMonitor.emit('suspend'); h.powerMonitor.emit('resume'); }
    const reads = h.reads;
    await h.tick(); assert.equal(h.reads, reads);
    h.faults.pendingWrite.resolve();
    assert.equal((await copying).ok, true);
    await h.tick(); assert.equal(h.reads, reads + 1);
    assert.equal((await h.state()).entries.length, 1);
  });
}

for (const event of ['pause', 'lock', 'suspend']) {
  test(`clipboard write completion preserves an active ${event} state`, async t => {
    const h = await harness(t);
    h.setText('card'); await h.tick();
    const id = (await h.state()).entries[0].id;
    h.faults.pendingWrite = deferred();
    const copying = h.call('copy', id);
    if (event === 'pause') await h.call('pause', true);
    if (event === 'lock') h.powerMonitor.emit('lock-screen');
    if (event === 'suspend') h.powerMonitor.emit('suspend');
    h.faults.pendingWrite.resolve();
    assert.equal((await copying).ok, true);
    const reads = h.reads;
    h.setText('never read while blocked'); await h.tick();
    assert.equal(h.reads, reads);
    if (event === 'pause') await h.call('pause', false);
    if (event === 'lock') h.powerMonitor.emit('unlock-screen');
    if (event === 'suspend') h.powerMonitor.emit('resume');
    await h.tick();
    assert.equal((await h.state()).entries.length, 1);
    h.setText('after fresh baseline'); await h.tick();
    assert.equal((await h.state()).entries.length, 2);
  });
}

test('concealed/transient/autogenerated clipboard types are never inspected or stored', async t => {
  const h = await harness(t);
  for (const marker of ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'org.nspasteboard.AutoGeneratedType']) {
    h.setItems([{ types: ['text/plain', marker], getType: () => assert.fail('concealed clipboard text was inspected') }]);
    await h.tick();
  }
  assert.equal((await h.state()).entries.length, 0);
  h.setItems([{ types: ['image/png'], getType: () => assert.fail('non-text clipboard was inspected') }]);
  await h.tick();
  h.setItems([{ types: ['text/plain'], getType: async () => ({ size: MAX_TEXT_BYTES + 1, text: () => assert.fail('oversized clipboard was decoded') }) }]);
  await h.tick();
  assert.equal((await h.state()).entries.length, 0);
  h.setText('allowed next copy'); await h.tick();
  assert.equal((await h.state()).entries[0].text, 'allowed next copy');
});

test('lock then suspend/resume keeps capture and display blocked until unlock', async t => {
  const h = await harness(t);
  h.app.emit('activate');
  h.powerMonitor.emit('lock-screen');
  assert.equal(h.window.visible, false);
  h.powerMonitor.emit('suspend');
  h.powerMonitor.emit('resume');
  const reads = h.reads;
  h.setText('private while locked'); await h.tick();
  h.app.emit('activate'); h.app.emit('second-instance'); h.registered.get(DEFAULT_SETTINGS.shortcut)();
  assert.equal(h.reads, reads);
  assert.equal(h.window.visible, false);
  h.powerMonitor.emit('unlock-screen');
  await h.tick();
  assert.equal((await h.state()).entries.length, 0);
  h.setText('new after unlock'); await h.tick();
  assert.equal((await h.state()).entries[0].text, 'new after unlock');
});

test('unlock while suspended and resume while manually paused do not resume capture', async t => {
  const h = await harness(t);
  h.powerMonitor.emit('suspend'); h.powerMonitor.emit('lock-screen'); h.powerMonitor.emit('unlock-screen');
  const reads = h.reads;
  await h.tick(); assert.equal(h.reads, reads);
  assert.equal((await h.call('pause', true)).ok, true);
  h.powerMonitor.emit('resume');
  await h.tick(); assert.equal(h.reads, reads);
  assert.equal((await h.state()).paused, true);
  assert.equal((await h.call('pause', false)).ok, true);
  h.setText('ignored resume baseline'); await h.tick();
  assert.equal((await h.state()).entries.length, 0);
});

test('changing settings commits a working shortcut and respects hide-after-copy', async t => {
  const h = await harness(t);
  assert.equal((await h.call('settings', { shortcut: 'Alt+Space', hideAfterCopy: false, historyLimit: 30 })).ok, true);
  assert.equal(h.registered.has('Alt+Space'), true);
  assert.equal(h.registered.has(DEFAULT_SETTINGS.shortcut), false);
  const state = await h.state();
  assert.equal(state.settings.shortcut, 'Alt+Space');
  assert.equal(state.settings.historyLimit, 30);
  assert.equal(state.status.shortcutRegistered, true);
  h.setText('card'); await h.tick();
  h.app.emit('activate');
  await h.call('copy', (await h.state()).entries[0].id);
  assert.equal(h.window.visible, true);
});

test('shortcut conflicts and settings write failures preserve the previous working shortcut/settings', async t => {
  const h = await harness(t);
  h.refusedShortcuts.add('Alt+Space');
  assert.equal((await h.call('settings', { shortcut: 'Alt+Space' })).ok, false);
  assert.equal(h.registered.has(DEFAULT_SETTINGS.shortcut), true);
  assert.equal((await h.state()).settings.shortcut, DEFAULT_SETTINGS.shortcut);
  h.faults.saveSettings = true;
  assert.equal((await h.call('settings', { shortcut: 'Control+F8' })).ok, false);
  assert.equal(h.registered.has(DEFAULT_SETTINGS.shortcut), true);
  assert.equal(h.registered.has('Control+F8'), false);
  assert.equal((await h.state()).settings.shortcut, DEFAULT_SETTINGS.shortcut);
});

test('persistence opt-in saves history and opt-out erases it without clearing memory', async t => {
  const h = await harness(t);
  h.setText('synthetic history'); await h.tick();
  assert.equal((await h.call('settings', { persistence: true })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(h.store.historyPath, 'utf8')).entries[0].text, 'synthetic history');
  assert.equal((await h.call('settings', { persistence: false })).ok, true);
  assert.equal(fs.existsSync(h.store.historyPath), false);
  assert.equal((await h.state()).entries[0].text, 'synthetic history');
});

test('failed opt-in rolls back newly written history and leaves persistence disabled', async t => {
  const h = await harness(t);
  h.setText('synthetic history'); await h.tick();
  h.faults.saveSettings = true;
  assert.equal((await h.call('settings', { persistence: true })).ok, false);
  assert.equal((await h.state()).settings.persistence, false);
  assert.equal(fs.existsSync(h.store.historyPath), false);
  h.faults.saveSettings = false; h.faults.saveHistory = true;
  assert.equal((await h.call('settings', { persistence: true })).ok, false);
  assert.equal((await h.state()).settings.persistence, false);
  assert.equal(JSON.parse(fs.readFileSync(h.store.settingsPath, 'utf8')).persistence, false);
});

test('failed opt-in cleanup explicitly warns if plaintext history remains while persistence is disabled', async t => {
  const h = await harness(t);
  h.setText('synthetic rollback history'); await h.tick();
  h.faults.saveSettings = true; h.faults.eraseHistory = true;
  assert.equal((await h.call('settings', { persistence: true })).ok, false);
  const state = await h.state();
  assert.equal(state.settings.persistence, false);
  assert.equal(fs.existsSync(h.store.historyPath), true);
  assert.equal(typeof state.status.storageWarning, 'string', 'a failed rollback must not leave a false memory-only assurance');
});

test('history write/delete failures are visible without stopping capture', async t => {
  const h = await harness(t, { settings: { persistence: true } });
  h.faults.saveHistory = true;
  h.setText('still captured in memory'); await h.tick();
  assert.equal((await h.state()).entries.length, 1);
  assert.equal(typeof (await h.state()).status.storageWarning, 'string');
  h.faults.saveHistory = false;
  h.setText('saved later'); await h.tick();
  h.faults.eraseHistory = true;
  await h.call('settings', { persistence: false });
  assert.equal((await h.state()).settings.persistence, false);
  assert.equal(typeof (await h.state()).status.storageWarning, 'string');
  assert.equal(fs.existsSync(h.store.historyPath), true, 'failure is surfaced rather than falsely claiming disk deletion');
});

test('clear deletes all pins too, removes persisted text, and avoids immediate recapture', async t => {
  const h = await harness(t, { settings: { persistence: true } });
  h.setText('synthetic pin'); await h.tick();
  await h.call('pin', (await h.state()).entries[0].id);
  h.setText('synthetic unpinned'); await h.tick();
  assert.equal((await h.call('clear')).ok, true);
  assert.equal((await h.state()).entries.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.store.historyPath, 'utf8')).entries, []);
  await h.tick();
  assert.equal((await h.state()).entries.length, 0);
});

test('quit pauses pending capture, stops interval, unregisters shortcuts, and destroys tray', async t => {
  const h = await harness(t);
  h.app.emit('before-quit');
  assert.equal(h.timer.cleared, true);
  const reads = h.reads;
  await h.tick();
  assert.equal(h.reads, reads);
  h.app.emit('will-quit');
  assert.equal(h.registered.size, 0);
  assert.equal(h.tray.destroyed, true);
});

test('right-side window positioning respects negative monitor coordinates and narrow work areas', async t => {
  const h = await harness(t, { workArea: { x: -500, y: -200, width: 500, height: 600 } });
  h.app.emit('activate');
  assert.deepEqual(normalize(h.window.getBounds()), { x: -500, y: -200, width: 500, height: 600 });
});

test('packaged builds cannot enable synthetic test-mode hooks through environment variables', async t => {
  const h = await harness(t, { env: { PUPA_TEST_MODE: '1' } });
  assert.equal(h.context.global.pupaTest, undefined);
  assert.equal(h.reads, 1, 'packaged app follows the normal clipboard code path');
});

test('a quick blur still hides after the opening guard, but regained focus cancels it', async t => {
  const h = await harness(t);
  h.app.emit('activate');
  h.window.focused = false; h.window.emit('blur');
  const delayed = h.timeouts.at(-1);
  assert.ok(delayed.delay >= 0 && delayed.delay <= 300);
  assert.equal(h.window.visible, true);
  delayed.fn();
  assert.equal(h.window.visible, false);
  h.app.emit('activate');
  h.window.focused = false; h.window.emit('blur');
  const canceled = h.timeouts.at(-1);
  h.window.focus(); h.window.emit('focus');
  assert.equal(canceled.cleared, true);
  canceled.fn();
  assert.equal(h.window.visible, true);
});

test('startup restores only opted-in history and preserves pin metadata within the configured limit', async t => {
  const entries = Array.from({ length: 40 }, (_, index) => ({ text: `synthetic restored ${index}`, pinned: index === 39, createdAt: index + 1 }));
  const enabled = await harness(t, { settings: { persistence: true, historyLimit: 30 }, entries });
  const state = await enabled.state();
  assert.equal(state.entries.length, 30);
  assert.ok(state.entries.some(entry => entry.text === 'synthetic restored 39' && entry.pinned));
  const disabled = await harness(t, { entries });
  assert.equal((await disabled.state()).entries.length, 0);
  assert.equal(fs.existsSync(disabled.store.historyPath), false);
});

test('lowering history limit trims immediately and persists only the trimmed entries', async t => {
  const h = await harness(t, { settings: { persistence: true } });
  for (let index = 0; index < 40; index++) { h.setText(`synthetic entry ${index}`); await h.tick(); }
  assert.equal((await h.state()).entries.length, 40);
  assert.equal((await h.call('settings', { historyLimit: 30 })).ok, true);
  assert.equal((await h.state()).entries.length, 30);
  assert.equal(JSON.parse(fs.readFileSync(h.store.historyPath, 'utf8')).entries.length, 30);
  assert.equal((await h.call('settings', { historyLimit: 1 })).ok, false);
  assert.equal((await h.state()).entries.length, 30);
});

for (const interrupt of ['clear', 'pause', 'lock']) {
  test(`pending clipboard decode cannot add or persist text after ${interrupt}`, async t => {
    const h = await harness(t, { settings: { persistence: true } });
    const pending = deferred();
    h.setItems([{ types: ['text/plain'], getType: () => pending.promise }]);
    const poll = h.tick();
    await Promise.resolve();
    if (interrupt === 'clear') await h.call('clear');
    if (interrupt === 'pause') await h.call('pause', true);
    if (interrupt === 'lock') h.powerMonitor.emit('lock-screen');
    pending.resolve(new Blob(['synthetic interrupted clipboard'], { type: 'text/plain' }));
    await poll;
    assert.equal((await h.state()).entries.length, 0);
    if (fs.existsSync(h.store.historyPath)) assert.deepEqual(JSON.parse(fs.readFileSync(h.store.historyPath, 'utf8')).entries, []);
  });
}
