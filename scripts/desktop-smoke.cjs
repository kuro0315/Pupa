'use strict';

// Real Tauri/WebKitGTK integration test, not an Electron launch or browser mock.
// Run only in an isolated Linux desktop (CI uses Xvfb + dbus-run-session).
// The explicit smoke-test Cargo feature substitutes synthetic clipboard values
// and a disposable data directory; normal release installers do not include it.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const application = path.resolve(process.argv[2] || 'src-tauri/target/debug/pupa');
const port = Number(process.env.TAURI_DRIVER_PORT || 4444);
const endpoint = `http://127.0.0.1:${port}`;
let sessionId;
let driver;
let driverError;

async function request(method, route, body) {
  const response = await fetch(`${endpoint}${route}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json();
  if (!response.ok || data.value?.error) throw new Error(`${route}: ${JSON.stringify(data.value)}`);
  return data.value;
}
async function waitFor(check, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    if (driverError) throw driverError;
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}
const execute = (script, args = []) => request('POST', `/session/${sessionId}/execute/sync`, { script, args });
async function invoke(command, args = {}) {
  const result = await request('POST', `/session/${sessionId}/execute/async`, {
    script: 'const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({value}), error => done({error: String(error)}));',
    args: [command, args],
  });
  if (result.error) throw new Error(`${command}: ${result.error}`);
  return result.value;
}
async function key(value) {
  await request('POST', `/session/${sessionId}/actions`, { actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }] });
}
async function collect(text) {
  await invoke('smoke_set_clipboard', { text });
  await invoke('smoke_tick');
}
async function count(expected) {
  return waitFor(async () => await execute('return document.querySelectorAll(".clip-card").length') === expected, `${expected} rendered cards`);
}

async function main() {
  assert.equal(process.platform, 'linux', 'Native smoke currently requires Linux WebKitGTK');
  assert.ok(process.env.DISPLAY, 'Start the smoke in an isolated Xvfb desktop');
  assert.ok(fs.existsSync(application), `Build the smoke-test binary first: ${application}`);
  driver = spawn(process.env.TAURI_DRIVER || 'tauri-driver', ['--port', String(port)], {
    stdio: 'inherit', env: { ...process.env, PUPA_TEST_MODE: '1' },
  });
  driver.on('error', error => { driverError = error; });
  driver.on('exit', code => { if (code && !driverError) driverError = new Error(`tauri-driver exited ${code}`); });
  try {
    await waitFor(async () => { await request('GET', '/status'); return true; }, 'tauri-driver startup');
    const session = await request('POST', '/session', {
      capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application } } },
    });
    sessionId = session.sessionId;
    await request('POST', `/session/${sessionId}/timeouts`, { implicit: 0, script: 20_000, pageLoad: 30_000 });
    await waitFor(() => execute('return Boolean(window.pupa && document.querySelector(".is-desktop"))'), 'Tauri renderer bridge');
    assert.equal(await execute('return Boolean(window.__TAURI__)'), false, 'global Tauri API stays disabled');
    const initial = await invoke('smoke_state');
    assert.equal(initial.state.settings.persistence, false, 'history is opt-in');
    assert.equal(initial.state.entries.length, 0, 'fresh synthetic test history');
    assert.equal(initial.visible, true, 'test window starts visible');
    assert.equal((await invoke('smoke_native_clipboard_roundtrip')).ok, true, 'real isolated OS clipboard round-trip uses only its own synthetic value');

    await collect('小さなひらめきを、逃さない。\n今日の「いいな」を、明日のアイデアに。');
    await collect('https://github.com/kuro0315/Pupa');
    await collect("const littleThings = ['ひらめき', 'ことば', '好き'];");
    await count(3);
    assert.equal(fs.existsSync(path.join(initial.dataDir, 'history.json')), false, 'default history is never persisted');
    await key('\uE015'); // ArrowDown expands the same card as hover.
    await waitFor(() => execute('return document.querySelectorAll(".card-slot.is-expanded").length === 1'), 'keyboard expansion');
    await sleep(1200);
    fs.mkdirSync('artifacts', { recursive: true });
    const screenshot = await request('GET', `/session/${sessionId}/screenshot`);
    fs.writeFileSync('artifacts/pupa-tauri-native-linux.png', Buffer.from(screenshot, 'base64'));
    await key('\uE007'); // Enter copies the selected card and hides.
    await waitFor(async () => !(await invoke('smoke_state')).visible, 'copy-and-hide');
    assert.match((await invoke('smoke_state')).syntheticClipboard, /littleThings/);
    await invoke('smoke_tick');
    assert.equal((await invoke('smoke_state')).state.entries.length, 3, 'self-copy does not add a duplicate');

    for (let i = 0; i < 3; i++) {
      await invoke('smoke_toggle');
      await waitFor(async () => (await invoke('smoke_state')).visible, 'reopen');
      await key('\uE00C');
      await waitFor(async () => !(await invoke('smoke_state')).visible, 'Escape hide');
    }
    await invoke('set_paused', { paused: true });
    await collect('not captured while paused');
    await invoke('set_paused', { paused: false });
    await invoke('smoke_tick');
    assert.equal((await invoke('smoke_state')).state.entries.length, 3, 'resume rebases the paused clipboard');
    await collect('A new synthetic entry after resume');
    const state = (await invoke('smoke_state')).state;
    assert.equal(state.entries.length, 4);
    assert.equal((await invoke('toggle_pin', { id: state.entries[0].id })).ok, true);
    assert.equal((await invoke('smoke_state')).state.entries[0].pinned, true);
    assert.equal((await invoke('delete_entry', { id: state.entries[1].id })).ok, true);
    assert.equal((await invoke('smoke_state')).state.entries.length, 3);
    assert.equal((await invoke('clear_history')).ok, true);
    assert.equal((await invoke('smoke_state')).state.entries.length, 0);
    console.log('PASS: native Tauri startup, Rust commands/events, synthetic clipboard capture, memory-only default, keyboard copy-and-hide, repeated toggle/Escape, pause baseline, pin/delete/clear.');
  } finally {
    if (sessionId) await request('DELETE', `/session/${sessionId}`).catch(error => console.error('WebDriver cleanup:', error.message));
    driver?.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
