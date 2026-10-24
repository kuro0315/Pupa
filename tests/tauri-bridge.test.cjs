'use strict';
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let createTauriBridge, isTauriRuntime, mockIPC, clearMocks, emit;
before(async () => {
  global.window = globalThis;
  ({ createTauriBridge, isTauriRuntime } = await import('../renderer/tauri.ts'));
  ({ mockIPC, clearMocks } = await import('@tauri-apps/api/mocks'));
  ({ emit } = await import('@tauri-apps/api/event'));
});
afterEach(() => { clearMocks(); delete global.isTauri; });

test('ordinary browser is not mistaken for the native runtime', () => {
  assert.equal(isTauriRuntime(), false);
  global.isTauri = true;
  assert.equal(isTauriRuntime(), true);
});

test('bridge maps only narrow domain commands and named arguments', async () => {
  const calls = [];
  const state = { entries: [], paused: false };
  mockIPC((command, args) => { calls.push({ command, args }); return command === 'get_state' ? state : { ok: true }; });
  const bridge = createTauriBridge();
  assert.ok(Object.isFrozen(bridge));
  assert.deepEqual(await bridge.getState(), state);
  await bridge.copyEntry('copy'); await bridge.completeCopyDismissal('dismiss-token'); await bridge.deleteEntry('delete'); await bridge.togglePin('pin');
  await bridge.clearHistory(); await bridge.setPaused(true);
  await bridge.updateSettings({ persistence: true, confirmHistoryReduction: true });
  bridge.hide(); bridge.quit();
  assert.deepEqual(calls, [
    { command: 'get_state', args: {} },
    { command: 'copy_entry', args: { id: 'copy' } },
    { command: 'complete_copy_dismissal', args: { token: 'dismiss-token' } },
    { command: 'delete_entry', args: { id: 'delete' } },
    { command: 'toggle_pin', args: { id: 'pin' } },
    { command: 'clear_history', args: {} },
    { command: 'set_paused', args: { paused: true } },
    { command: 'update_settings', args: { patch: { persistence: true, confirmHistoryReduction: true } } },
    { command: 'hide', args: {} },
    { command: 'quit', args: {} },
  ]);
});

test('state, shown, and settings events preserve payloads and unsubscribe safely', async () => {
  mockIPC(() => ({ entries: [] }), { shouldMockEvents: true });
  const bridge = createTauriBridge();
  const states = []; let shown = 0; let settings = 0;
  const offState = bridge.onState(state => states.push(state));
  const offShown = bridge.onShown(() => shown++);
  const offSettings = bridge.onSettings(() => settings++);
  await bridge.getState();
  await emit('pupa-state', { entries: ['fixture'] });
  await emit('pupa-shown'); await emit('pupa-open-settings');
  assert.deepEqual(states, [{ entries: ['fixture'] }]);
  assert.equal(shown, 1); assert.equal(settings, 1);
  offState(); offShown(); offSettings();
  // Unsubscribe twice is harmless, including after pagehide.
  offState();
});

test('snapshot waits for event registration; cancellation before registration does not leak', async () => {
  const calls = []; let release;
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === 'plugin:event|listen') return new Promise(resolve => { release = () => resolve(123); });
    return { entries: [] };
  });
  const bridge = createTauriBridge();
  const off = bridge.onState(() => assert.fail('cancelled callback must not run'));
  const snapshot = bridge.getState();
  off();
  assert.equal(calls.some(call => call.command === 'get_state'), false);
  release();
  await snapshot;
  assert.ok(calls.find(call => call.command === 'plugin:event|unlisten'));
  assert.equal(calls.at(-1).command, 'get_state');
});

test('subscription failure fails initial state instead of silently dropping updates', async () => {
  mockIPC(command => { if (command === 'plugin:event|listen') throw new Error('capability denied'); return {}; });
  const bridge = createTauriBridge();
  bridge.onState(() => {});
  await assert.rejects(bridge.getState(), /capability denied/);
});


test('copy dismissal tokens are preserved and completion is explicit', async () => {
  const calls = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    return command === 'copy_entry' ? { ok: true, dismissToken: 'opaque-native-token:42' } : { ok: true };
  });
  const bridge = createTauriBridge();
  const copied = await bridge.copyEntry('entry');
  assert.deepEqual(copied, { ok: true, dismissToken: 'opaque-native-token:42' });
  assert.deepEqual(calls, [{ command: 'copy_entry', args: { id: 'entry' } }], 'copy does not complete or hide through a transport side effect');
  assert.deepEqual(await bridge.completeCopyDismissal(copied.dismissToken), { ok: true });
  assert.deepEqual(calls.at(-1), { command: 'complete_copy_dismissal', args: { token: 'opaque-native-token:42' } });
});

test('failed and stale no-token copy results remain unchanged without implicit dismissal', async () => {
  const calls = [];
  const results = [{ ok: false, error: 'synthetic copy failure' }, { ok: true }];
  mockIPC((command, args) => { calls.push({ command, args }); return results.shift(); });
  const bridge = createTauriBridge();
  assert.deepEqual(await bridge.copyEntry('failed'), { ok: false, error: 'synthetic copy failure' });
  assert.deepEqual(await bridge.copyEntry('stale'), { ok: true });
  assert.deepEqual(calls, [
    { command: 'copy_entry', args: { id: 'failed' } },
    { command: 'copy_entry', args: { id: 'stale' } },
  ]);
});

test('system shortcut request is explicit and has no implicit startup or approval side effect', async () => {
  const calls = [];
  mockIPC((command, args) => { calls.push({ command, args }); return command === 'get_state' ? { entries: [], status: { shortcutBackend: 'portal', shortcutState: 'needs-approval' } } : { ok: true }; });
  const bridge = createTauriBridge();
  await bridge.getState();
  assert.deepEqual(calls, [{ command: 'get_state', args: {} }]);
  assert.deepEqual(await bridge.requestSystemShortcut(), { ok: true });
  assert.deepEqual(calls.at(-1), { command: 'request_system_shortcut', args: {} });
  assert.equal(calls.length, 2, 'request does not accept a permission, alter settings, or hide the app');
});

test('system shortcut cancellation and unavailable results pass through unchanged', async () => {
  const results = [{ ok: false, error: '許可されなかったか、キャンセルされました' }, { ok: false, error: 'GlobalShortcuts unavailable' }];
  const calls = [];
  mockIPC((command, args) => { calls.push({ command, args }); return results.shift(); });
  const bridge = createTauriBridge();
  assert.deepEqual(await bridge.requestSystemShortcut(), { ok: false, error: '許可されなかったか、キャンセルされました' });
  assert.deepEqual(await bridge.requestSystemShortcut(), { ok: false, error: 'GlobalShortcuts unavailable' });
  assert.deepEqual(calls.map(call => call.command), ['request_system_shortcut', 'request_system_shortcut']);
});

test('portal binding changes and session closure are authoritative ordinary state events', async () => {
  mockIPC(() => ({ entries: [] }), { shouldMockEvents: true });
  const bridge = createTauriBridge(); const statuses = [];
  const off = bridge.onState(state => statuses.push(state.status)); await bridge.getState();
  const registered = { shortcutBackend: 'portal', shortcutState: 'registered', shortcutRegistered: true, shortcutTrigger: 'Super+P', shortcutWarning: null };
  const closed = { shortcutBackend: 'portal', shortcutState: 'closed', shortcutRegistered: false, shortcutTrigger: null, shortcutWarning: 'Session closed' };
  await emit('pupa-state', { status: registered }); await emit('pupa-state', { status: closed });
  assert.deepEqual(statuses, [registered, closed]); off();
});
