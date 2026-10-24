'use strict';
// Real app → ashpd/zbus → isolated D-Bus mock protocol integration. GTK itself
// remains X11/Xvfb. This is NOT a real Wayland compositor or Chrome test.
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');
const application = path.resolve(process.argv[2] || 'src-tauri/target/debug/pupa');
const port = Number(process.env.TAURI_DRIVER_PORT || 4474);
const endpoint = `http://127.0.0.1:${port}`;
const restoring = process.env.PUPA_SMOKE_PORTAL_RESTORE === '1';
const restoreResponse = process.env.PUPA_PORTAL_RESTORE_RESPONSE || 'accepted';
const artifactDir = restoring ? `artifacts/portal-protocol/opted-in-${restoreResponse}` : 'artifacts/portal-protocol';
const events = [], checks = [];
const pending = new Map();
let service, driver, focusFixture, sessionId, nativeWindowId, failure, ready = false, nextId = 0;

async function waitFor(probe, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await sleep(100);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`);
}
async function request(method, route, body) {
  const response = await fetch(`${endpoint}${route}`, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25_000) });
  const data = await response.json();
  if (!response.ok || data.value?.error) throw new Error(`${route}: ${JSON.stringify(data.value)}`);
  return data.value;
}
const execute = (script, args = []) => request('POST', `/session/${sessionId}/execute/sync`, { script, args });
async function invoke(command, args = {}) {
  const result = await request('POST', `/session/${sessionId}/execute/async`, {
    script: 'const done=arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));', args: [command, args],
  });
  if (result.error) throw new Error(`${command}: ${result.error}`);
  return result.value;
}
function control(op, values = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Mock control timed out: ${op}`)); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    service.stdin.write(JSON.stringify({ id, op, ...values }) + '\n');
  });
}
async function status(expected) {
  return waitFor(async () => {
    const current = (await invoke('smoke_state')).state.status;
    assert.equal(current.shortcutBackend, 'portal', 'Wayland session chooses the portal even when test GTK uses X11');
    if (current.shortcutState !== expected) throw new Error(`Expected ${expected}, received ${JSON.stringify(current)}`);
    assert.equal(current.shortcutRegistered, expected === 'registered');
    return current;
  }, `portal state ${expected}`);
}
function record(check) { checks.push(check); console.log(`PASS (mock portal protocol): ${check}`); }
async function mappedWindow() {
  const { stdout } = await runFile('xwininfo', ['-display', process.env.DISPLAY, ...(nativeWindowId ? ['-id', nativeWindowId] : ['-name', 'Pupa'])], { timeout: 5000 });
  if (!nativeWindowId) {
    const match = stdout.match(/Window id:\s+(0x[0-9a-f]+)\s+"Pupa"/i);
    assert.ok(match, 'identify the exact Pupa X11 window in the isolated root');
    nativeWindowId = match[1];
  }
  const match = stdout.match(/Map State:\s+(\w+)/);
  assert.ok(match, 'independent X11 query reports actual map state');
  return match[1];
}
async function visible(expected, label) {
  return waitFor(async () => {
    if ((await invoke('smoke_state')).visible !== expected) return false;
    const mapped = await mappedWindow();
    if (expected ? mapped !== 'IsViewable' : !['IsUnMapped', 'IsUnviewable'].includes(mapped)) return false;
    events.push({ event: 'actual-native-window', label, windowId: nativeWindowId, mapState: mapped });
    return true;
  }, label);
}
async function staysVisible(expected, label) {
  // Multiple observations, not just the first state before a queued D-Bus
  // signal could be dispatched. Positive signal delivery is checked separately.
  for (let i = 0; i < 4; i++) {
    await sleep(100);
    assert.equal((await invoke('smoke_state')).visible, expected, label);
    const mapped = await mappedWindow();
    assert.equal(mapped === 'IsViewable', expected, `${label}: actual OS window map state`);
  }
}
async function focusOtherWindow() {
  if (!focusFixture) {
    focusFixture = spawn('xmessage', ['-title', 'PupaProtocolFocusFixture', '-buttons', 'Close:0', 'Synthetic focus fixture. Not a system permission dialog.'], { stdio: 'ignore' });
    focusFixture.on('error', error => { failure = error; });
  }
  const id = await waitFor(async () => {
    const { stdout } = await runFile('xwininfo', ['-display', process.env.DISPLAY, '-name', 'PupaProtocolFocusFixture'], { timeout: 2000 });
    return stdout.match(/Window id:\s+(0x[0-9a-f]+)/i)?.[1];
  }, 'synthetic external native focus window');
  await runFile('xdotool', ['windowfocus', '--sync', id], { timeout: 5000 });
  const { stdout } = await runFile('xdotool', ['getwindowfocus'], { timeout: 5000 });
  assert.notEqual(Number(stdout.trim()), Number(nativeWindowId), 'OS focus genuinely left Pupa');
  events.push({ event: 'actual-native-focus', focusedWindowId: id, pupaWindowId: nativeWindowId });
}
async function focusPupa() {
  await runFile('xdotool', ['windowfocus', '--sync', nativeWindowId], { timeout: 5000 });
}
async function quitAndExpectClose(boundSession) {
  await execute("setTimeout(() => window.__TAURI_INTERNALS__.invoke('quit').catch(() => {}), 100); return true;");
  await waitFor(async () => (await control('inspect')).closed.includes(boundSession), 'native quit closes the portal session');
}
async function activeSession() {
  const mock = await control('inspect');
  const sessions = Object.entries(mock.sessions).filter(([, value]) => value.bindings.length > 0);
  assert.equal(sessions.length, 1, 'exactly one bound portal session remains live');
  return sessions[0][0];
}
const signal = (member, session, values = {}) => control('signal', { member, session, ...values });

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.PUPA_ISOLATED_DESKTOP, '1');
  assert.equal(process.env.PUPA_MOCK_PORTAL_TEST, '1');
  assert.equal(process.env.XDG_SESSION_TYPE, 'wayland');
  assert.equal(process.env.GDK_BACKEND, 'x11');
  assert.ok(process.env.DISPLAY);
  assert.match(process.env.DBUS_SESSION_BUS_ADDRESS || '', /^unix:path=\/tmp\//);
  assert.ok(fs.existsSync(application));
  fs.mkdirSync(artifactDir, { recursive: true });
  service = spawn(process.env.PUPA_PORTAL_PYTHON || '/usr/bin/python3', ['scripts/mock-shortcut-portal.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
  service.on('error', error => { failure = error; });
  service.on('exit', code => { if (code !== 0 && code !== null) failure = new Error(`Mock portal exited ${code}`); });
  readline.createInterface({ input: service.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      if (message.id) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error) waiter.reject(new Error(message.error)); else waiter.resolve(message.result);
      } else {
        events.push(message);
        if (message.event === 'ready') ready = true;
        if (message.event === 'protocol-error') failure = new Error(`Mock protocol assertion: ${message.message}`);
      }
    } catch (error) { failure = error; }
  });
  try {
    await waitFor(() => ready, 'private mock portal name acquisition');
    if (restoring) await control('mode', { value: restoreResponse });
    driver = spawn(process.env.TAURI_DRIVER || 'tauri-driver', ['--port', String(port), '--native-port', String(port + 1)], { stdio: 'inherit', env: { ...process.env, PUPA_TEST_MODE: '1' } });
    driver.on('error', error => { failure = error; });
    await waitFor(async () => { await request('GET', '/status'); return true; }, 'tauri-driver');
    const session = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application } } } });
    sessionId = session.sessionId;
    await request('POST', `/session/${sessionId}/timeouts`, { implicit: 0, script: 20_000, pageLoad: 30_000 });
    await waitFor(() => execute('return Boolean(window.pupa && window.__TAURI_INTERNALS__);'), 'native renderer');
    if (restoring) {
      // This is an explicitly opted-in synthetic startup fixture, not a claim
      // that two processes reused real settings or that an OS grant was read.
      await status(restoreResponse === 'accepted' ? 'registered' : 'cancelled');
      const restored = await invoke('smoke_state');
      assert.equal((await invoke('smoke_geometry')).backend, 'x11');
      assert.equal(restored.state.entries.length, 0);
      assert.equal(restored.state.settings.systemShortcutEnabled, restoreResponse === 'accepted');
      await visible(true, 'opted-in startup native window is physically mapped');
      const calls = (await control('inspect')).calls;
      assert.equal(calls.filter(call => call.member === 'BindShortcuts').length, 1, 'opted-in startup initiates exactly one normal portal binding attempt');
      if (restoreResponse === 'accepted') {
        const restoredSession = await activeSession();
        await invoke('hide'); await visible(false, 'hide restored startup window');
        await signal('Activated', restoredSession, { timestamp: 1 });
        await visible(true, 'restored portal binding physically opens hidden native window');
        await signal('Deactivated', restoredSession, { timestamp: 2 });
        await quitAndExpectClose(restoredSession);
        record('smoke-only opted-in startup restores normal portal binding and actual activation; isolated fresh temp settings');
      } else {
        await sleep(500);
        assert.equal((await control('inspect')).calls.filter(call => call.member === 'BindShortcuts').length, 1, 'cancelled startup restore never loops or re-prompts');
        record('cancelled opted-in startup clears local preference and does not retry automatically');
      }
      return;
    }
    await status('needs-approval');
    const initial = await invoke('smoke_state');
    await visible(true, 'initial native window is physically mapped');
    assert.equal(initial.state.entries.length, 0);
    assert.equal(initial.state.settings.persistence, false);
    assert.equal((await invoke('smoke_geometry')).backend, 'x11', 'this is expressly an X11-hosted protocol test');
    assert.equal((await control('inspect')).calls.filter(call => call.member === 'BindShortcuts').length, 0, 'fresh launch never opens an unsolicited binding dialog');
    record('fresh launch uses portal state but never invokes BindShortcuts without a request');

    for (const [mode, expected] of [['unavailable', 'unavailable'], ['cancelled', 'cancelled'], ['denied', 'error'], ['empty', 'cancelled']]) {
      await control('mode', { value: mode, clearSaved: true });
      await invoke('request_system_shortcut');
      const result = await status(expected);
      assert.ok(result.shortcutWarning, `${mode} has an actionable warning`);
      assert.equal((await invoke('smoke_state')).visible, initial.visible, 'failed binding never toggles the window');
      record(`${mode === 'denied' ? 'generic portal Response(2)' : mode} request reports ${expected} without falsely registering`);
    }

    await control('mode', { value: 'accepted', clearSaved: true, hold: true });
    const before = (await control('inspect')).calls.filter(call => call.member === 'BindShortcuts').length;
    await execute(`window.__portalRepeatedRequests = null; Promise.all([1,2,3].map(()=>window.__TAURI_INTERNALS__.invoke('request_system_shortcut'))).then(value=>window.__portalRepeatedRequests={value},error=>window.__portalRepeatedRequests={error:String(error)}); return true;`);
    await status('requesting');
    await waitFor(async () => (await control('inspect')).heldRequests.length === 1, 'one genuinely pending D-Bus Bind response');
    await focusOtherWindow();
    await staysVisible(true, 'pending Bind retains the native parent after actual focus loss, including duplicate requests');
    await status('requesting');
    await control('respond');
    const registered = await status('registered');
    const repeated = await waitFor(() => execute('return window.__portalRepeatedRequests;'), 'all repeated request results');
    assert.equal(repeated.error, undefined);
    await focusPupa();
    assert.equal(registered.shortcutTrigger, 'Ctrl+Shift+Space (mock portal)');
    const accepted = await control('inspect');
    assert.equal(accepted.calls.filter(call => call.member === 'BindShortcuts').length - before, 1, 'concurrent requests create one binding dialog only');
    let boundSession = await activeSession();
    record('accepted binding returns the portal trigger; repeated requests create one BindShortcuts call; real focus loss does not hide the pending native parent');
    const beforeConfigure = (await control('inspect')).calls.filter(call => call.member === 'ConfigureShortcuts').length;
    await control('mode', { value: 'accepted', holdConfigure: true });
    await execute("window.__portalConfigure=null; window.__TAURI_INTERNALS__.invoke('request_system_shortcut').then(value=>window.__portalConfigure=value); return true;");
    await waitFor(async () => (await control('inspect')).heldConfigure === 1, 'genuinely pending ConfigureShortcuts response');
    assert.equal((await control('inspect')).calls.filter(call => call.member === 'ConfigureShortcuts').length, beforeConfigure + 1);
    await focusOtherWindow();
    await staysVisible(true, 'ConfigureShortcuts keeps parent visible while its method is pending');
    const queuedGeneration = (await invoke('smoke_geometry')).generation;
    await control('burst', { session: boundSession, count: 12 });
    await control('respond');
    const configured = await waitFor(() => execute('return window.__portalConfigure;'), 'ConfigureShortcuts completion');
    assert.equal(configured.ok, true);
    await waitFor(async () => (await invoke('smoke_geometry')).generation === queuedGeneration + 12, 'twelve press/release pairs queued during Configure each toggle once');
    await visible(true, 'even queued burst leaves the native window physically mapped');
    await focusPupa();
    // Repeat configuration without queued activations: its UI can remain open
    // after the method reply, and must not cause the parent to auto-hide.
    assert.equal((await invoke('request_system_shortcut')).ok, true);
    await focusOtherWindow();
    await staysVisible(true, 'ConfigureShortcuts keeps parent visible after method acceptance until focus returns');
    await focusPupa();
    record('configuration retains the native parent on focus loss, including after method return; queued signal burst preserves all twelve toggles');

    await invoke('hide'); await visible(false, 'hide before external portal activation');
    await signal('Activated', boundSession, { action: 'wrong-action', timestamp: 1 });
    await staysVisible(false, 'wrong action is ignored');
    await signal('Activated', '/org/freedesktop/portal/desktop/session/wrong/session', { timestamp: 2 });
    await staysVisible(false, 'wrong session is ignored');
    await signal('Activated', boundSession, { timestamp: 3 });
    await visible(true, 'actual D-Bus Activated reopens the hidden native window');
    await signal('Activated', boundSession, { timestamp: 4 });
    await staysVisible(true, 'held-key repeated Activated is ignored');
    await signal('Deactivated', boundSession, { action: 'wrong-action', timestamp: 5 });
    await signal('Deactivated', '/org/freedesktop/portal/desktop/session/wrong/session', { timestamp: 6 });
    await signal('Activated', boundSession, { timestamp: 7 });
    await staysVisible(true, 'wrong-action/session release cannot reset the held-key gate');
    await signal('Deactivated', boundSession, { timestamp: 8 });
    await staysVisible(true, 'Deactivated must not double-toggle');
    await signal('Activated', boundSession, { timestamp: 9 });
    await visible(false, 'second actual D-Bus Activated hides native window');
    await signal('Deactivated', boundSession, { timestamp: 10 });
    await staysVisible(false, 'key release leaves native window hidden');
    assert.equal((await invoke('smoke_state')).syntheticClipboard, initial.syntheticClipboard);
    assert.equal((await invoke('smoke_state')).state.entries.length, 0);
    record('wrong action/session ignored; real Activated toggles while hidden; held-key repeats and wrong releases ignored; Deactivated never toggles or copies');

    const beforeBurst = (await invoke('smoke_geometry')).generation;
    await control('burst', { session: boundSession, count: 12 });
    await waitFor(async () => (await invoke('smoke_geometry')).generation === beforeBurst + 12, 'all twelve queued press/release pairs toggle exactly once');
    await visible(false, 'even rapid signal burst leaves the real native window unmapped');
    await signal('Activated', boundSession, { timestamp: 200 });
    await visible(true, 'release ordering leaves the activation gate ready after a rapid burst');
    await signal('Deactivated', boundSession, { timestamp: 201 });
    await invoke('hide'); await visible(false, 'hide before revocation');
    record('rapid ordered D-Bus press/release burst delivers exactly twelve native toggles without a stuck held-key gate');

    await signal('ShortcutsChanged', boundSession, { omitTrigger: true });
    await status('needs-approval');
    assert.equal((await invoke('smoke_state')).state.settings.systemShortcutEnabled, false);
    await signal('Activated', boundSession, { timestamp: 202 });
    await staysVisible(false, 'revoked binding cannot activate the native window');
    await signal('ShortcutsChanged', boundSession);
    await status('registered');
    await waitFor(async () => (await invoke('smoke_state')).state.settings.systemShortcutEnabled === true, 're-enabled binding restores local opt-in');
    record('GNOME-style missing trigger_description revokes registration and clears local restore preference');

    const closedSession = boundSession;
    await signal('Closed', closedSession);
    await status('closed');
    await signal('Activated', closedSession, { timestamp: 7 });
    await staysVisible(false, 'closed-session activation is ignored');
    await control('mode', { value: 'accepted', delayMs: 80, clearSaved: true });
    await invoke('request_system_shortcut'); await status('registered');
    boundSession = await activeSession(); assert.notEqual(boundSession, closedSession);
    record('session Closed invalidates listeners; explicit retry creates a fresh session');

    const oldOwner = (await control('inspect')).uniqueName;
    await control('release');
    await status('closed');
    assert.notEqual((await control('acquire')).uniqueName, oldOwner, 'restarted portal has a genuinely new D-Bus connection/owner');
    await control('mode', { value: 'accepted', clearSaved: true });
    await invoke('request_system_shortcut'); await status('registered');
    const restartedSession = await activeSession(); assert.notEqual(restartedSession, boundSession);
    await signal('Activated', restartedSession, { timestamp: 8 });
    await visible(true, 'new portal owner activation works after restart');
    record('portal owner loss invalidates registration; restarted mock can register and activate again');

    // A scheduled real native quit leaves WebDriver time to return. Observe the
    // service-side Session.Close before any test cleanup deletes the session.
    await quitAndExpectClose(restartedSession);
    record('native quit sends Session.Close before harness teardown');
    assert.equal(events.some(event => event.event === 'protocol-error'), false);
  } finally {
    fs.writeFileSync(path.join(artifactDir, 'portal-protocol-report.json'), JSON.stringify({
      scope: 'Real Tauri/ashpd D-Bus transport against a purpose-built mock on an isolated bus and X11/Xvfb. NOT real Wayland, GNOME portal UI, or Chrome verification.',
      checks, events,
    }, null, 2) + '\n');
    if (sessionId) await request('DELETE', `/session/${sessionId}`).catch(() => {});
    driver?.kill('SIGTERM');
    focusFixture?.kill('SIGTERM');
    service?.stdin.end();
    service?.kill('SIGTERM');
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Harness stopping')); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
