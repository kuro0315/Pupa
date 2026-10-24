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
async function movePointer(x, y, duration = 140) {
  await request('POST', `/session/${sessionId}/actions`, { actions: [{
    type: 'pointer', id: 'hand-mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', origin: 'viewport', duration, x, y }],
  }] });
}
async function restingPointerTargets() {
  // Freeze the unexpanded hand, not DOM hit testing or expanded z-index. Every
  // sample is well inside the intended rotated rectangle's exposed region.
  return execute(`
    const slots = [...document.querySelectorAll('.card-slot')].map((slot, index) => {
      const width = slot.offsetWidth, height = slot.offsetHeight;
      const angle = parseFloat(slot.style.getPropertyValue('--angle')) * Math.PI / 180;
      return { id: slot.dataset.id, index, width, height, cos: Math.cos(angle), sin: Math.sin(angle),
        cx: parseFloat(slot.style.left) + width / 2, cy: parseFloat(slot.style.top) + height / 2 };
    });
    const local = (rect, x, y) => { const dx = x - rect.cx, dy = y - rect.cy;
      return { x: dx * rect.cos + dy * rect.sin, y: -dx * rect.sin + dy * rect.cos }; };
    const owner = (x, y) => slots.findLastIndex(rect => { const point = local(rect, x, y);
      return Math.abs(point.x) <= rect.width / 2 && Math.abs(point.y) <= rect.height / 2; });
    return slots.map(rect => {
      let best = null;
      for (let ly = -rect.height / 2 + 12; ly <= rect.height / 2 - 12; ly += 8) {
        for (let lx = -rect.width / 2 + 12; lx <= rect.width / 2 - 12; lx += 8) {
          const x = Math.round(rect.cx + lx * rect.cos - ly * rect.sin);
          const y = Math.round(rect.cy + lx * rect.sin + ly * rect.cos);
          if (x < 3 || y < 3 || x >= innerWidth - 3 || y >= innerHeight - 3 || owner(x, y) !== rect.index) continue;
          const self = local(rect, x, y);
          let clearance = Math.min(rect.width / 2 - Math.abs(self.x), rect.height / 2 - Math.abs(self.y));
          for (const later of slots.slice(rect.index + 1)) {
            const point = local(later, x, y);
            clearance = Math.min(clearance, Math.hypot(Math.max(0, Math.abs(point.x) - later.width / 2), Math.max(0, Math.abs(point.y) - later.height / 2)));
          }
          if (!best || clearance > best.clearance) best = { id: rect.id, index: rect.index, x, y, clearance };
        }
      }
      return best;
    });
  `);
}
async function leftExtensionCopyPoint(id) {
  return execute(`
    const slots = [...document.querySelectorAll('.card-slot')];
    const selected = slots.find(slot => slot.dataset.id === arguments[0]);
    if (!selected) return null;
    const copy = selected.querySelector('.card-copy');
    const box = copy.getBoundingClientRect();
    const rectangles = slots.map(slot => {
      const width = slot.offsetWidth, height = slot.offsetHeight;
      const angle = parseFloat(slot.style.getPropertyValue('--angle')) * Math.PI / 180;
      return { id: slot.dataset.id, width, height, cos: Math.cos(angle), sin: Math.sin(angle),
        cx: parseFloat(slot.style.left) + width / 2, cy: parseFloat(slot.style.top) + height / 2 };
    });
    const rest = rectangles.find(rect => rect.id === arguments[0]);
    const restingLeft = rest.cx - (rest.width * Math.abs(rest.cos) + rest.height * Math.abs(rest.sin)) / 2;
    let best = null;
    for (let y = Math.ceil(Math.max(4, box.top + 8)); y <= Math.min(innerHeight - 4, box.bottom - 8); y += 6) {
      for (let x = Math.ceil(Math.max(4, box.left + 8)); x <= Math.min(restingLeft - 8, box.left + box.width / 2, innerWidth - 4); x += 6) {
        // Only a real unobstructed copy-button pixel counts, never a toolbar or
        // a convenient point that belongs to another resting card.
        if (document.elementFromPoint(x, y)?.closest('.card-copy') !== copy) continue;
        let clearance = Math.min(x - box.left, box.right - x, y - box.top, box.bottom - y);
        let outside = true;
        for (const rect of rectangles) {
          const dx = x - rect.cx, dy = y - rect.cy;
          const lx = dx * rect.cos + dy * rect.sin, ly = -dx * rect.sin + dy * rect.cos;
          if (Math.abs(lx) <= rect.width / 2 && Math.abs(ly) <= rect.height / 2) { outside = false; break; }
          clearance = Math.min(clearance, Math.hypot(Math.max(0, Math.abs(lx) - rect.width / 2), Math.max(0, Math.abs(ly) - rect.height / 2)));
        }
        if (outside && (!best || clearance > best.clearance)) best = { x, y, clearance, restingLeft };
      }
    }
    return best;
  `, [id]);
}
async function clickPointer() {
  await request('POST', `/session/${sessionId}/actions`, { actions: [{
    type: 'pointer', id: 'hand-mouse', parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
  }] });
}
async function expectExpanded(id, description) {

  await waitFor(() => execute('const expanded = [...document.querySelectorAll(".card-slot.is-expanded")]; return expanded.length === 1 && expanded[0].dataset.id === arguments[0];', [id]), description);
}
async function expectReturned(id) {
  await waitFor(() => execute(`
    const slot = [...document.querySelectorAll('.card-slot')].find(item => item.dataset.id === arguments[0]);
    if (!slot || slot.classList.contains('is-expanded')) return false;
    const transform = getComputedStyle(slot.querySelector('.clip-card')).transform;
    if (transform === 'none') return true;
    const matrix = new DOMMatrixReadOnly(transform);
    return Math.abs(matrix.a - 1) < .001 && Math.abs(matrix.b) < .001 && Math.abs(matrix.c) < .001 && Math.abs(matrix.d - 1) < .001 && Math.abs(matrix.e) < .01 && Math.abs(matrix.f) < .01;
  `, [id]), 'previous native card returns to its resting transform');
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

    // Final visual evidence uses seven synthetic entries in the actual Tauri
    // window. No app attribution is fabricated and the original 3-card capture
    // above remains a separate record of the preceding integration assertions.
    await invoke('smoke_tick'); // Clear resets the baseline; do not recapture its previous synthetic value.
    assert.equal((await invoke('smoke_state')).state.entries.length, 0);
    for (const text of [
      '七枚のクリップボード履歴を、画面いっぱいの扇で。\nこれは検証用のサンプルです。',
      'https://v2.tauri.app/',
      "const palette = ['cyan', 'violet', 'lime'];",
      'IDEA LOG\n速く呼び出す。迷わず選ぶ。必要なときだけ、目の前に。',
      'https://github.com/kuro0315/Pupa',
      'function remember(text) {\n  return { text, local: true };\n}',
      'ローカルで完結する、七つの手札。\n↑ ↓ で選択 / Enter でコピー / Esc で閉じる',
    ]) await collect(text);
    assert.equal((await invoke('smoke_state')).state.entries.length, 7);
    await invoke('smoke_toggle');
    await waitFor(async () => (await invoke('smoke_state')).visible, 'seven-card native fan reopen');
    await count(7);
    await waitFor(() => execute('return document.querySelectorAll(".card-slot.is-expanded").length === 0'), 'resting native fan');
    await sleep(1300);
    fs.writeFileSync('artifacts/pupa-tauri-native-fan-linux.png', Buffer.from(await request('GET', `/session/${sessionId}/screenshot`), 'base64'));

    const pointerTargets = await restingPointerTargets();
    assert.equal(pointerTargets.length, 7);
    assert.ok(pointerTargets.every(target => target && target.clearance > 3), 'all seven resting leaves have an unambiguous pointer region');
    const beforeSweep = await invoke('smoke_state');
    const sweep = [...pointerTargets, ...pointerTargets.slice(0, -1).reverse()];
    const visited = [];
    let previous;
    for (const target of sweep) {
      await movePointer(target.x, target.y);
      await expectExpanded(target.id, `pointer selects native resting card ${target.index + 1}`);
      if (previous) await expectReturned(previous.id);
      // Holding the pointer still must not flicker back to the overlaid card.
      await sleep(330);
      await expectExpanded(target.id, `native hover stays on card ${target.index + 1}`);
      visited.push(target.index + 1);
      previous = target;
    }
    fs.writeFileSync('artifacts/pupa-tauri-native-pointer-linux.png', Buffer.from(await request('GET', `/session/${sessionId}/screenshot`), 'base64'));
    const afterSweep = await invoke('smoke_state');
    assert.equal(afterSweep.visible, true, 'pointer sweep never hides or auto-copies');
    assert.equal(afterSweep.syntheticClipboard, beforeSweep.syntheticClipboard, 'pointer sweep never changes the clipboard');
    assert.deepEqual(afterSweep.state.entries, beforeSweep.state.entries, 'pointer sweep never mutates clipboard history');
    await movePointer(2, 2);
    await waitFor(() => execute('return document.querySelectorAll(".card-slot.is-expanded").length === 0'), 'pointer leaving the hand clears expansion');
    await expectReturned(previous.id);
    fs.writeFileSync('artifacts/pupa-native-pointer-report.json', JSON.stringify({ visited, targets: pointerTargets, clipboardUnchanged: true, historyUnchanged: true, leaveClearsExpansion: true }, null, 2) + '\n');

    await key('\uE015');
    await expectExpanded(pointerTargets[0].id, 'keyboard selects the first card after pointer leave');
    await waitFor(() => execute('return document.querySelectorAll(".card-slot.is-expanded").length === 1'), 'expanded native fan card');
    await sleep(600);
    fs.writeFileSync('artifacts/pupa-tauri-native-hover-linux.png', Buffer.from(await request('GET', `/session/${sessionId}/screenshot`), 'base64'));
    await key('\uE015');
    await expectExpanded(pointerTargets[1].id, 'keyboard navigation continues after pointer sweep');
    assert.equal((await invoke('smoke_state')).syntheticClipboard, beforeSweep.syntheticClipboard, 'keyboard navigation alone never copies');

    // Prove the pulled-out left portion is genuinely clickable. A different
    // synthetic clipboard value makes the subsequent exact recopy observable.
    const firstEntry = beforeSweep.state.entries[0];
    assert.equal(firstEntry.id, pointerTargets[0].id);
    const clickSentinel = 'Pupa synthetic pointer-click sentinel (not a history entry)';
    await invoke('smoke_set_clipboard', { text: clickSentinel });
    await key('\uE013'); // ArrowUp returns from the second card to the first.
    await expectExpanded(firstEntry.id, 'keyboard reselects the first card for left-extension click');
    await sleep(330);
    const leftPoint = await leftExtensionCopyPoint(firstEntry.id);
    assert.ok(leftPoint && leftPoint.clearance > 3, 'first card exposes a safe left copy-button region outside every resting card');
    await movePointer(leftPoint.x, leftPoint.y);
    await sleep(330);
    await expectExpanded(firstEntry.id, 'moving onto the pulled-out left portion retains the selected card');
    const beforeClick = await invoke('smoke_state');
    assert.equal(beforeClick.visible, true, 'window stays visible until the explicit pointer click');
    assert.equal(beforeClick.syntheticClipboard, clickSentinel, 'moving onto the left extension does not copy');
    assert.deepEqual(beforeClick.state.entries, beforeSweep.state.entries, 'left-extension movement never changes history');
    fs.writeFileSync('artifacts/pupa-tauri-native-left-click-linux.png', Buffer.from(await request('GET', `/session/${sessionId}/screenshot`), 'base64'));
    await clickPointer();
    await waitFor(async () => !(await invoke('smoke_state')).visible, 'explicit left-extension pointer click copies and hides');
    const afterClick = await invoke('smoke_state');
    assert.equal(afterClick.syntheticClipboard, firstEntry.text, 'left-extension pointer click recopies the exact first card text');
    assert.deepEqual(afterClick.state.entries, beforeSweep.state.entries, 'copying the left extension never mutates history');
    fs.writeFileSync('artifacts/pupa-native-left-click-report.json', JSON.stringify({ cardId: firstEntry.id, point: leftPoint, outsideEveryRestingRectangle: true, clipboardChangedOnlyAfterClick: true, exactTextCopied: true, hiddenAfterClick: true }, null, 2) + '\n');
    console.log('PASS: native Tauri startup, Rust commands/events, synthetic clipboard capture, memory-only default, keyboard copy-and-hide, repeated toggle/Escape, pause baseline, pin/delete/clear, seven-card resting/expanded native screenshots, real pointer sweep 1→7→1, stable hover/return/leave without copy, keyboard after pointer, explicit left-extension pointer click with exact copy-and-hide.');
  } finally {
    if (sessionId) await request('DELETE', `/session/${sessionId}`).catch(error => console.error('WebDriver cleanup:', error.message));
    driver?.kill('SIGTERM');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
