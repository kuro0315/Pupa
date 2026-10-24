'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
function loadBridge() {
  const ipc = new EventEmitter(); const calls = [];
  ipc.invoke = (channel, value) => { calls.push([channel, value]); return Promise.resolve({ ok: true }); };
  let key, bridge;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../electron/preload.cjs'), 'utf8'), {
    require: name => { assert.equal(name, 'electron'); return {
      ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => { key = name; bridge = value; } },
    }; },
  });
  return { ipc, calls, key, bridge };
}

test('preload exposes a frozen narrow API without raw Electron or arbitrary IPC access', () => {
  const { key, bridge } = loadBridge();
  assert.equal(key, 'pupa');
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge).sort(), [
    'getState', 'copyEntry', 'deleteEntry', 'togglePin', 'clearHistory', 'setPaused',
    'updateSettings', 'hide', 'quit', 'onState', 'onShown', 'onSettings',
  ].sort());
  assert.equal(bridge.invoke, undefined);
  assert.equal(bridge.send, undefined);
  assert.equal(bridge.ipcRenderer, undefined);
});

test('preload commands map only to fixed application channels', async () => {
  const { bridge, calls } = loadBridge();
  await bridge.getState(); await bridge.copyEntry('copy-id'); await bridge.deleteEntry('delete-id');
  await bridge.togglePin('pin-id'); await bridge.clearHistory(); await bridge.setPaused(true);
  await bridge.updateSettings({ persistence: false }); await bridge.hide(); await bridge.quit();
  assert.deepEqual(calls, [
    ['pupa:state', undefined], ['pupa:copy', 'copy-id'], ['pupa:delete', 'delete-id'],
    ['pupa:pin', 'pin-id'], ['pupa:clear', undefined], ['pupa:pause', true],
    ['pupa:settings', { persistence: false }], ['pupa:hide', undefined], ['pupa:quit', undefined],
  ]);
});

test('preload strips privileged event objects and provides independent unsubscribe functions', () => {
  const { bridge, ipc } = loadBridge();
  const stateCalls = []; const secondCalls = []; const shownCalls = [];
  const unsubscribe = bridge.onState((...args) => stateCalls.push(args));
  const unsubscribeSecond = bridge.onState((...args) => secondCalls.push(args));
  const unsubscribeShown = bridge.onShown((...args) => shownCalls.push(args));
  const privilegedEvent = { sender: 'must never reach renderer' };
  const state = { entries: [] };
  ipc.emit('pupa:changed', privilegedEvent, state);
  ipc.emit('pupa:shown', privilegedEvent);
  assert.deepEqual(stateCalls, [[state]]);
  assert.deepEqual(shownCalls, [[undefined]]);
  unsubscribe(); unsubscribe();
  ipc.emit('pupa:changed', privilegedEvent, state);
  assert.equal(stateCalls.length, 1);
  assert.equal(secondCalls.length, 2);
  unsubscribeSecond(); unsubscribeShown();
  assert.equal(ipc.listenerCount('pupa:changed'), 0);
  assert.equal(ipc.listenerCount('pupa:shown'), 0);
});


test('tray settings event is narrowly exposed and can be unsubscribed', () => {
  const { bridge, ipc } = loadBridge();
  const calls = [];
  const unsubscribe = bridge.onSettings((...args) => calls.push(args));
  ipc.emit('pupa:open-settings', { sender: 'private' });
  assert.deepEqual(calls, [[undefined]]);
  unsubscribe();
  assert.equal(ipc.listenerCount('pupa:open-settings'), 0);
});
