'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClipboardMonitor, MAX_TEXT_BYTES } = require('../electron/history.cjs');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(initial = 'prelaunch') {
  let value = initial; let reads = 0; let errors = 0;
  const texts = [];
  const monitor = new ClipboardMonitor({ read: async () => { reads++; return value; }, onText: text => texts.push(text), onError: () => { errors++; } });
  return { monitor, texts, set: next => { value = next; }, get reads() { return reads; }, get errors() { return errors; } };
}

test('first poll establishes a baseline without capturing prelaunch content', async () => {
  const f = fixture();
  await f.monitor.tick();
  await f.monitor.tick();
  assert.deepEqual(f.texts, []);
  f.set('new text');
  await f.monitor.tick();
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['new text']);
  f.set('prelaunch');
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['new text', 'prelaunch']);
});

test('null initial clipboard is a valid baseline', async () => {
  const f = fixture(null);
  await f.monitor.tick();
  f.set('first new text');
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['first new text']);
});

test('invalid, blank, non-text, and over-limit changes are never emitted', async () => {
  const f = fixture();
  await f.monitor.tick();
  for (const value of [null, undefined, {}, 42, '', ' \n ', 'x'.repeat(MAX_TEXT_BYTES + 1)]) { f.set(value); await f.monitor.tick(); }
  assert.deepEqual(f.texts, []);
  f.set('valid after rejected');
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['valid after rejected']);
});

test('pausing prevents reads and resuming discards content copied during pause', async () => {
  const f = fixture();
  await f.monitor.tick();
  const reads = f.reads;
  f.monitor.setPaused(true);
  f.set('private paused content');
  await f.monitor.tick();
  await f.monitor.tick();
  assert.equal(f.reads, reads);
  f.monitor.setPaused(false);
  await f.monitor.tick();
  assert.deepEqual(f.texts, []);
  f.set('after resume');
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['after resume']);
});

test('resetting baseline does not immediately recapture the current clipboard after clear', async () => {
  const f = fixture();
  await f.monitor.tick();
  f.set('captured once'); await f.monitor.tick();
  f.monitor.resetBaseline();
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['captured once']);
  f.set('next copy'); await f.monitor.tick();
  assert.deepEqual(f.texts, ['captured once', 'next copy']);
});

test('copying a history card updates baseline without adding the app copy again', async () => {
  const f = fixture();
  await f.monitor.tick();
  f.monitor.noteCopied('from a card');
  f.set('from a card');
  await f.monitor.tick();
  assert.deepEqual(f.texts, []);
  f.set('subsequent outside copy');
  await f.monitor.tick();
  assert.deepEqual(f.texts, ['subsequent outside copy']);
});

test('overlapping ticks share a non-reentrant read boundary', async () => {
  const pending = deferred(); let reads = 0; const texts = [];
  const monitor = new ClipboardMonitor({ read: () => { reads++; return pending.promise; }, onText: text => texts.push(text) });
  const first = monitor.tick();
  await monitor.tick(); await monitor.tick();
  assert.equal(reads, 1);
  assert.equal(monitor.busy, true);
  pending.resolve('baseline');
  await first;
  assert.equal(monitor.busy, false);
  assert.deepEqual(texts, []);
});

for (const action of ['pause', 'pause-resume', 'reset', 'copy']) {
  test(`in-flight read is discarded when ${action} invalidates its epoch`, async () => {
    const pending = deferred(); const texts = [];
    let read = async () => 'baseline';
    const monitor = new ClipboardMonitor({ read: () => read(), onText: text => texts.push(text) });
    await monitor.tick();
    read = () => pending.promise;
    const active = monitor.tick();
    if (action === 'pause') monitor.setPaused(true);
    if (action === 'pause-resume') { monitor.setPaused(true); monitor.setPaused(false); }
    if (action === 'reset') monitor.resetBaseline();
    if (action === 'copy') monitor.noteCopied('card');
    pending.resolve('stale read');
    await active;
    assert.deepEqual(texts, []);
    assert.equal(monitor.busy, false);
    if (action === 'pause') monitor.setPaused(false);
    read = async () => action === 'copy' ? 'card' : 'fresh baseline';
    await monitor.tick();
    assert.deepEqual(texts, []);
    read = async () => 'genuinely new';
    await monitor.tick();
    assert.deepEqual(texts, ['genuinely new']);
  });
}

test('read failure reports a generic error, releases busy, and recovers', async () => {
  let reads = 0; let errors = 0; const texts = [];
  const monitor = new ClipboardMonitor({ read: async () => { reads++; if (reads === 1) throw new Error('synthetic secret, do not forward'); return reads === 2 ? 'baseline' : 'new'; }, onText: text => texts.push(text), onError: (...args) => { assert.deepEqual(args, []); errors++; } });
  await monitor.tick();
  assert.equal(errors, 1);
  assert.equal(monitor.busy, false);
  await monitor.tick(); await monitor.tick();
  assert.deepEqual(texts, ['new']);
});

test('an invalidated in-flight rejection is suppressed after pause', async () => {
  const pending = deferred(); let errors = 0;
  const monitor = new ClipboardMonitor({ read: () => pending.promise, onText: () => assert.fail('unexpected text'), onError: () => errors++ });
  const active = monitor.tick();
  monitor.setPaused(true);
  pending.reject(new Error('stale failure'));
  await active;
  assert.equal(errors, 0);
  assert.equal(monitor.busy, false);
});

test('synchronous read errors are contained and callback reentrancy cannot start another poll', async () => {
  let errors = 0;
  const broken = new ClipboardMonitor({ read: () => { throw new Error('failure'); }, onText: () => {}, onError: () => errors++ });
  await broken.tick();
  assert.equal(errors, 1);
  assert.equal(broken.busy, false);
  let reads = 0;
  const monitor = new ClipboardMonitor({ read: () => ++reads === 1 ? 'baseline' : 'next', onText: () => { void monitor.tick(); } });
  await monitor.tick(); await monitor.tick();
  assert.equal(reads, 2);
});
