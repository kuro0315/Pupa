'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let createStateReceiver;
before(async () => { ({ createStateReceiver } = await import('../renderer/state-order.ts')); });
const snapshot = (revision, text = '') => ({ revision, entries: text ? [{ text }] : [] });

test('an older state event cannot resurrect a deleted card', () => {
  const applied = [];
  const receive = createStateReceiver(state => applied.push(state));
  assert.equal(receive(snapshot(3, 'before delete')), true);
  assert.equal(receive(snapshot(5)), true);
  assert.equal(receive(snapshot(4, 'stale captured entry')), false);
  assert.deepEqual(applied.map(state => state.revision), [3, 5]);
  assert.deepEqual(applied.at(-1).entries, []);
});

test('late initial getState snapshot cannot overwrite a newer event', async () => {
  let resolveInitial; let current;
  const receive = createStateReceiver(state => { current = state; });
  const initial = new Promise(resolve => { resolveInitial = resolve; }).then(receive);
  receive(snapshot(12)); // Clear event arrives while getState is in flight.
  resolveInitial(snapshot(11, 'deleted card from initial response'));
  assert.equal(await initial, false);
  assert.equal(current.revision, 12);
  assert.deepEqual(current.entries, []);
});

test('newer initial response and equal-revision repeats remain valid', () => {
  let current;
  const receive = createStateReceiver(state => { current = state; });
  assert.equal(receive(snapshot(0)), true);
  assert.equal(receive(snapshot(1, 'newer')), true);
  assert.equal(receive(snapshot(1, 'newer')), true);
  assert.equal(current.entries[0].text, 'newer');
});

test('unversioned preview and injected fixture updates continue to work', () => {
  let current;
  const receive = createStateReceiver(state => { current = state; });
  assert.equal(receive(snapshot(undefined, 'preview')), true);
  assert.equal(receive(snapshot(undefined, 'updated preview')), true);
  assert.equal(current.entries[0].text, 'updated preview');
});

test('unversioned state cannot replace versioned native state', () => {
  let current;
  const receive = createStateReceiver(state => { current = state; });
  receive(snapshot(undefined, 'initial fixture'));
  receive(snapshot(2, 'native'));
  assert.equal(receive(snapshot(undefined, 'unversioned stale data')), false);
  assert.equal(current.entries[0].text, 'native');
});

test('invalid revisions are rejected without poisoning subsequent valid updates', () => {
  let current;
  const receive = createStateReceiver(state => { current = state; });
  for (const revision of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(receive(snapshot(revision)), false);
  assert.equal(receive(snapshot(4, 'valid')), true);
  assert.equal(current.revision, 4);
});
