'use strict';
// All fixtures are synthetic. Never query the actual foreground app or clipboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectSourceApp, sanitizeSourceApp, sanitizeIcon, parseSourceOutput, parseX11WindowId,
  parseX11Class, TIMEOUT_MS, MAX_OUTPUT_BYTES, MAX_ICON_BYTES,
} = require('../electron/source-app.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNuoAAAAASUVORK5CYII=';

function fixture(outputs) {
  const calls = [];
  return { calls, execFile: (file, args, options, callback) => {
    calls.push({ file, args, options });
    const value = outputs.shift();
    queueMicrotask(() => callback(value instanceof Error ? value : null, value instanceof Error ? '' : value));
    return { kill() {} };
  } };
}

test('unknown platforms, Wayland and pre-aborted signals perform no OS query', async () => {
  const f = fixture([]);
  for (const platform of ['freebsd', 'aix', 'unknown']) assert.equal(await detectSourceApp({ platform, execFile: f.execFile }), null);
  assert.equal(await detectSourceApp({ platform: 'linux', wayland: true, execFile: f.execFile }), null);
  assert.equal(await detectSourceApp({ platform: 'darwin', signal: AbortSignal.abort(), execFile: f.execFile }), null);
  assert.equal(f.calls.length, 0);
});

test('source data is allowlisted, sanitized and always labelled as heuristic', () => {
  assert.deepEqual(sanitizeSourceApp({ name: '  Synthetic\u0000 App\u202e  ', icon: PNG, kind: 'owner', url: 'https://example.invalid', title: 'never retain' }), { name: 'Synthetic App', icon: PNG, kind: 'foreground' });
  assert.equal(Array.from(sanitizeSourceApp({ name: '😀'.repeat(121) }).name).length, 120);
  for (const invalid of [null, [], 1, {}, { name: '' }, { name: '\u0001\u202e' }, { name: 42 }]) assert.equal(sanitizeSourceApp(invalid), null);
  assert.deepEqual(sanitizeSourceApp({ name: 'App', icon: 'https://example.invalid/icon.png' }), { name: 'App', kind: 'foreground' });
});

test('only bounded PNG data URLs and image dimensions are accepted', () => {
  assert.equal(sanitizeIcon(PNG), PNG);
  for (const invalid of ['data:image/svg+xml;base64,PHN2Zz4=', 'file:///private/icon.png', 'data:image/png;base64,eA==', PNG + '\n', 'data:image/png;base64,' + Buffer.alloc(MAX_ICON_BYTES + 1).toString('base64')]) assert.equal(sanitizeIcon(invalid), undefined);
  const huge = Buffer.from(PNG.split(',')[1], 'base64');
  huge.writeUInt32BE(1000000, 16);
  assert.equal(sanitizeIcon('data:image/png;base64,' + huge.toString('base64')), undefined);
});

test('untrusted or over-limit command output cannot become source metadata', () => {
  for (const invalid of ['', 'undefined', 'console noise\n{"name":"App"}', '{"name":"App"};run()', 'x'.repeat(MAX_OUTPUT_BYTES + 1), null]) assert.equal(parseSourceOutput(invalid), null);
  assert.deepEqual(parseSourceOutput('\uFEFF{"name":"Synthetic"}\n'), { name: 'Synthetic', kind: 'foreground' });
});

test('macOS uses a fixed AppKit script via execFile without shell interpretation', async () => {
  const f = fixture([JSON.stringify({ name: 'Synthetic Editor', icon: PNG })]);
  assert.deepEqual(await detectSourceApp({ platform: 'darwin', execFile: f.execFile }), { name: 'Synthetic Editor', icon: PNG, kind: 'foreground' });
  const call = f.calls[0];
  assert.equal(call.file, '/usr/bin/osascript');
  assert.deepEqual(call.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
  assert.match(call.args[3], /NSWorkspace\.sharedWorkspace\.frontmostApplication/);
  assert.doesNotMatch(call.args[3], /System Events|AXUIElement|CGWindow|pasteboard|clipboard|window.title/i);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.maxBuffer, MAX_OUTPUT_BYTES);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= TIMEOUT_MS);
});

test('Windows passes fixed encoded PowerShell and requests only process identity/icon', async () => {
  const f = fixture(['{"name":"SyntheticProcess"}']);
  assert.deepEqual(await detectSourceApp({ platform: 'win32', execFile: f.execFile }), { name: 'SyntheticProcess', kind: 'foreground' });
  const call = f.calls[0];
  assert.match(call.file, /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(call.args[4], 'base64').toString('utf16le');
  assert.match(script, /GetForegroundWindow/);
  assert.match(script, /GetWindowThreadProcessId/);
  assert.match(script, /\.ProcessName/);
  assert.match(script, /DriveType.*Fixed/);
  assert.doesNotMatch(script, /GetWindowText|MainWindowTitle|CommandLine|Get-Clipboard|Get-CimInstance|Invoke-Expression|ExecutionPolicy/);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
});

test('Linux reads only an allowlisted XID and WM_CLASS, never any window title', async () => {
  const f = fixture(['_NET_ACTIVE_WINDOW(WINDOW): window id # 0x123ab\n', 'WM_CLASS = "synthetic-instance", "Synthetic Browser"\n']);
  assert.deepEqual(await detectSourceApp({ platform: 'linux', execFile: f.execFile }), { name: 'Synthetic Browser', kind: 'foreground' });
  assert.deepEqual(f.calls.map(call => call.args), [['-root', '_NET_ACTIVE_WINDOW'], ['-id', '0x123ab', '-notype', 'WM_CLASS']]);
  assert.ok(f.calls.every(call => call.file === '/usr/bin/xprop' && call.options.shell === false));
  assert.equal(f.calls[1].options.env.XPROPFORMATS, '');
});

test('X11 parsers reject injected IDs, unrelated properties and malformed classes', () => {
  assert.equal(parseX11WindowId('_NET_ACTIVE_WINDOW(WINDOW): window id # 0xA1'), '0xa1');
  for (const value of ['0x123', '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0', '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1; touch /tmp/no', '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x123456789']) assert.equal(parseX11WindowId(value), null);
  assert.deepEqual(parseX11Class('WM_CLASS(STRING) = "instance", "Synthetic \\"Editor\\""'), { name: 'Synthetic "Editor"', kind: 'foreground' });
  for (const value of ['WM_NAME = "private window title"', 'WM_CLASS = "only-instance"', 'WM_CLASS = "instance", ""', 'WM_CLASS = "instance", "App"\nWM_NAME = "title"']) assert.equal(parseX11Class(value), null);
});

test('missing tools, permission errors, timeout and over-limit output fall back to unknown', async () => {
  for (const output of [Object.assign(new Error('synthetic missing tool'), { code: 'ENOENT' }), Object.assign(new Error('synthetic permission error'), { code: 'EACCES' }), Object.assign(new Error('synthetic timeout'), { killed: true }), 'x'.repeat(MAX_OUTPUT_BYTES + 1)]) {
    const f = fixture([output]);
    assert.equal(await detectSourceApp({ platform: 'darwin', execFile: f.execFile }), null);
  }
  assert.equal(await detectSourceApp({ platform: 'darwin', execFile: () => { throw new Error('synthetic spawn error'); } }), null);
});

test('X11 commands share one deadline, not one timeout per subprocess', async () => {
  let current = 100;
  const f = fixture(['_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1', 'WM_CLASS = "instance", "App"']);
  const execFile = (...args) => { current += 800; return f.execFile(...args); };
  await detectSourceApp({ platform: 'linux', execFile, now: () => current });
  assert.deepEqual(f.calls.map(call => call.options.timeout), [1200, 400]);
  const expired = fixture(['_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1']);
  current = 100;
  assert.equal(await detectSourceApp({ platform: 'linux', now: () => current, execFile: (...args) => { current += 1300; return expired.execFile(...args); } }), null);
  assert.equal(expired.calls.length, 1);
});

test('a cancellation during a subprocess discards its result', async () => {
  const controller = new AbortController();
  const f = fixture(['{"name":"Synthetic"}']);
  const result = detectSourceApp({ platform: 'darwin', signal: controller.signal, execFile: f.execFile });
  controller.abort();
  assert.equal(await result, null);
  assert.equal(f.calls[0].options.signal, controller.signal);
});

test('a late subprocess callback cannot return stale metadata', async () => {
  let current = 0;
  const f = fixture(['{"name":"Synthetic"}']);
  assert.equal(await detectSourceApp({ platform: 'darwin', now: () => current, execFile: (...args) => {
    current += TIMEOUT_MS + 1;
    return f.execFile(...args);
  } }), null);
});
