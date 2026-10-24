'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { History, DEFAULT_SETTINGS, MAX_TEXT_BYTES, MAX_TOTAL_BYTES, validText, kindOf, validateSettings } = require('../electron/history.cjs');

test('text validation rejects empty, non-string, and oversized values without altering content', () => {
  for (const value of [null, undefined, 123, {}, [], '', ' \n\t ', 'x'.repeat(MAX_TEXT_BYTES + 1)]) assert.equal(validText(value), false);
  assert.equal(validText('x'.repeat(MAX_TEXT_BYTES)), true);
  assert.equal(validText('é'.repeat(MAX_TEXT_BYTES / 2)), true);
  assert.equal(validText('é'.repeat(MAX_TEXT_BYTES / 2 + 1)), false);
  assert.equal(validText('🐛'.repeat(MAX_TEXT_BYTES / 4)), true);
  assert.equal(validText('🐛'.repeat(MAX_TEXT_BYTES / 4 + 1)), false);
  const history = new History();
  assert.equal(history.add('  preserve \n whitespace  '), true);
  assert.equal(history.entries[0].text, '  preserve \n whitespace  ');
  for (const value of [null, '', 'x'.repeat(MAX_TEXT_BYTES + 1)]) assert.equal(history.add(value), false);
  assert.equal(history.entries.length, 1);
});

test('kind detection classifies links and code without interpreting content', () => {
  assert.equal(kindOf('https://example.invalid/path?q=1'), 'link');
  assert.equal(kindOf('  HTTP://example.invalid  '), 'link');
  assert.equal(kindOf('https://example.invalid contains spaces'), 'text');
  for (const text of ['const x = 1;', '() => 1', '<script>alert(1)</script>', 'def example():\n  pass']) assert.equal(kindOf(text), 'code');
  assert.equal(kindOf('ordinary plain text'), 'text');
});

test('history deduplicates exact text and promotes a recopy while preserving its identity and pin', () => {
  const history = new History();
  history.add('first', 10);
  const original = history.snapshot()[0];
  history.pin(original.id);
  history.add('second', 20);
  history.add('first', 30);
  assert.deepEqual(history.entries.map(e => e.text), ['first', 'second']);
  assert.equal(history.entries[0].id, original.id);
  assert.equal(history.entries[0].createdAt, 30);
  assert.equal(history.entries[0].color, original.color);
  assert.equal(history.entries[0].pinned, true);
  history.add(' first', 40);
  history.add('FIRST', 50);
  assert.equal(history.entries.length, 4, 'deduplication does not normalize user content');
});

test('snapshot edits cannot mutate the underlying entries', () => {
  const history = new History();
  history.add('original');
  const snapshot = history.snapshot();
  snapshot[0].text = 'modified';
  snapshot[0].pinned = true;
  snapshot.push({ text: 'extra' });
  assert.equal(history.entries[0].text, 'original');
  assert.equal(history.entries[0].pinned, false);
  assert.equal(history.entries.length, 1);
});

test('remove, pin, get, and clear handle valid and missing IDs', () => {
  const history = new History();
  history.add('a');
  const id = history.entries[0].id;
  assert.equal(history.get(id).text, 'a');
  assert.equal(history.pin(id), true);
  assert.equal(history.get(id).pinned, true);
  assert.equal(history.pin(id), true);
  assert.equal(history.get(id).pinned, false);
  assert.equal(history.pin('missing'), false);
  assert.equal(history.remove('missing'), false);
  assert.equal(history.get('missing'), undefined);
  assert.equal(history.remove(id), true);
  assert.equal(history.remove(id), false);
  history.add('b');
  history.clear();
  assert.deepEqual(history.snapshot(), []);
});

test('history evicts oldest unpinned entries before pinned entries', () => {
  const history = new History(3);
  history.add('old pinned', 1);
  history.pin(history.entries[0].id);
  history.add('old unpinned', 2);
  history.add('recent unpinned', 3);
  history.add('newest', 4);
  assert.deepEqual(history.entries.map(e => e.text), ['newest', 'recent unpinned', 'old pinned']);
  history.limit = 1;
  history.trim();
  assert.deepEqual(history.entries.map(e => e.text), ['old pinned']);
});

test('all-pinned histories still honor the absolute entry limit', () => {
  const history = new History(100);
  for (let i = 0; i < 10; i++) { history.add(`pin ${i}`, i + 1); history.pin(history.entries[0].id); }
  history.limit = 3;
  history.trim();
  assert.deepEqual(history.entries.map(e => e.text), ['pin 9', 'pin 8', 'pin 7']);
  history.add('new unpinned');
  assert.deepEqual(history.entries.map(e => e.text), ['pin 9', 'pin 8', 'pin 7']);
});

test('total UTF-8 bytes are bounded independently of entry limit, including pins', () => {
  const history = new History(100);
  for (let i = 0; i < 40; i++) {
    history.add(`${String(i).padStart(4, '0')}${'é'.repeat((MAX_TEXT_BYTES - 4) / 2)}`, i + 1);
    history.pin(history.entries[0].id);
  }
  const bytes = history.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
  assert.ok(bytes <= MAX_TOTAL_BYTES);
  assert.equal(history.entries.length, MAX_TOTAL_BYTES / MAX_TEXT_BYTES);
  assert.ok(history.entries.every(entry => entry.pinned));
});

test('restore distrusts serialized IDs, kind, color, timestamps and pin types', () => {
  const history = new History();
  const before = Date.now();
  history.restore([
    { id: 'injected', text: 'https://example.invalid', kind: 'text', color: 'unknown', createdAt: Number.MAX_SAFE_INTEGER, pinned: 'true' },
    { id: 'injected', text: 'const value = 1', kind: 'text', color: 'mint', createdAt: 123, pinned: true },
    { text: 'normal', createdAt: -1 },
    null, false, {}, { text: '' }, { text: 3 }, { text: 'x'.repeat(MAX_TEXT_BYTES + 1) },
    { text: 'normal', pinned: true },
  ]);
  assert.equal(history.entries.length, 3);
  const [link, code, normal] = history.entries;
  assert.notEqual(link.id, 'injected');
  assert.notEqual(link.id, code.id);
  assert.equal(link.kind, 'link');
  assert.equal(link.color, 'lavender');
  assert.equal(link.pinned, false);
  assert.ok(link.createdAt >= before && link.createdAt <= Date.now());
  assert.equal(code.kind, 'code');
  assert.equal(code.color, 'mint');
  assert.equal(code.createdAt, 123);
  assert.equal(code.pinned, true);
  assert.ok(normal.createdAt >= before && normal.createdAt <= Date.now());
  assert.equal(normal.pinned, false, 'first duplicate wins');
});

test('restore limits untrusted entries and applies both count and byte bounds', () => {
  const history = new History(30);
  history.restore(Array.from({ length: 150 }, (_, i) => ({ text: `entry ${i}`, pinned: true })));
  assert.equal(history.entries.length, 30);
  assert.equal(history.entries[0].text, 'entry 0');
  assert.equal(history.entries.at(-1).text, 'entry 29');
  const bounded = new History(100);
  bounded.restore(Array.from({ length: 80 }, (_, i) => ({ text: `${String(i).padStart(4, '0')}${'x'.repeat(MAX_TEXT_BYTES - 4)}`, pinned: true })));
  assert.equal(bounded.entries.length, 32);
  assert.ok(bounded.entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0) <= MAX_TOTAL_BYTES);
});

test('invalid restore containers leave the existing history unchanged', () => {
  const history = new History();
  history.add('existing');
  for (const value of [null, undefined, {}, '[]', 1]) history.restore(value);
  assert.equal(history.entries[0].text, 'existing');
});

test('default settings are memory-only, bounded, and immutable', () => {
  assert.equal(DEFAULT_SETTINGS.persistence, false);
  assert.equal(DEFAULT_SETTINGS.historyLimit, 60);
  assert.equal(DEFAULT_SETTINGS.hideAfterCopy, true);
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  const next = validateSettings({ historyLimit: 30 });
  assert.notEqual(next, DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.historyLimit, 60);
  assert.equal(next.historyLimit, 30);
  assert.equal(next.persistence, false);
});

test('settings accept only declared keys and strict supported values', () => {
  for (const patch of [null, undefined, [], '', 1]) assert.throws(() => validateSettings(patch));
  for (const patch of [
    { extra: true }, JSON.parse('{"__proto__":{}}'), { constructor: true },
    { historyLimit: 0 }, { historyLimit: 31 }, { historyLimit: '60' }, { historyLimit: NaN },
    { persistence: 'true' }, { persistence: 1 }, { hideAfterCopy: null },
  ]) assert.throws(() => validateSettings(patch));
  for (const limit of [30, 60, 100]) assert.equal(validateSettings({ historyLimit: limit }).historyLimit, limit);
  const current = validateSettings({ persistence: true, hideAfterCopy: false });
  assert.deepEqual(validateSettings({}, current), current);
  assert.equal(validateSettings({ historyLimit: 100 }, current).persistence, true);
});

test('shortcut settings require a non-Shift modifier and a bounded supported key', () => {
  for (const shortcut of ['CommandOrControl+Shift+Space', 'Alt+A', 'Control+9', 'Super+F24', 'Command+Option+Space', 'ctrl+shift+f1']) {
    assert.equal(validateSettings({ shortcut }).shortcut, shortcut);
  }
  for (const shortcut of ['', 'Space', 'A', 'Shift+Space', 'Control', 'Control+', 'Alt+F0', 'Alt+F25', 'Alt+Enter', 'Alt+A+B', 'Alt+😀', 'Control+ A', 'Alt+'.repeat(30) + 'A', null, 1]) {
    assert.throws(() => validateSettings({ shortcut }), `accepted unsafe/unsupported shortcut ${shortcut}`);
  }
});

test('fan layout preferences are bounded integers', () => {
  assert.equal(DEFAULT_SETTINGS.fanSpread, 42); assert.equal(DEFAULT_SETTINGS.fanDistance, 0);
  assert.equal(validateSettings({ fanSpread: 55, fanDistance: 90 }).fanDistance, 90);
  for (const patch of [{fanSpread:19},{fanSpread:56},{fanSpread:30.5},{fanDistance:-1},{fanDistance:91},{fanDistance:'30'}]) assert.throws(()=>validateSettings(patch));
});

test('source attribution is sanitized, copied safely, cleared on recopy, and cannot update stale entries', () => {
  const { sanitizeSource } = require('../electron/history.cjs');
  const source = {name:'Demo Editor',kind:'foreground',icon:'https://example.invalid/icon.png',title:'must not store'};
  assert.deepEqual(sanitizeSource(source), {name:'Demo Editor',kind:'foreground'});
  assert.equal(sanitizeSource({name:'x'.repeat(121),kind:'foreground'}),null);
  assert.equal(sanitizeSource({name:'Demo',kind:'clipboard-owner'}),null);
  const h = new History(); h.add('first',10); const id=h.entries[0].id;
  assert.equal(h.setSource(id,9,source),false); assert.equal(h.setSource(id,10,source),true);
  const snapshot=h.snapshot(); snapshot[0].source.name='mutated'; assert.equal(h.get(id).source.name,'Demo Editor');
  h.add('first',11); assert.equal(h.get(id).source,undefined); assert.equal(h.setSource(id,10,source),false);
  h.clear(); assert.equal(h.setSource(id,11,source),false);
});

test('restoring source metadata keeps only bounded name and PNG data, included in total budget', () => {
  const h=new History(100);
  h.restore([{text:'record',createdAt:10,source:{name:'Demo',kind:'foreground',icon:'data:image/svg+xml,<svg/>',title:'discard'}}]);
  assert.deepEqual(h.entries[0].source,{name:'Demo',kind:'foreground'});
  h.clear(); for(let i=0;i<32;i++) h.add(String(i).padStart(2,'0')+'x'.repeat(MAX_TEXT_BYTES-2),i+1);
  assert.equal(h.entries.length,32); const entry=h.entries[0]; h.setSource(entry.id,entry.createdAt,{name:'Demo',kind:'foreground'});
  assert.equal(h.entries.length,31);
});
