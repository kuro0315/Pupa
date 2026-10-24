'use strict';
const { randomUUID, createHash } = require('node:crypto');
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const DEFAULT_SETTINGS = Object.freeze({ shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, hideAfterCopy: true, sourceApp: true, fanSpread: 42, fanDistance: 0 });
const COLORS = ['lavender', 'mint', 'rose', 'butter'];
const digest = text => createHash('sha256').update(text).digest('hex');
function validText(text) { return typeof text === 'string' && text.trim().length > 0 && Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES; }
const MAX_ICON_DATA_URL_BYTES = 48 * 1024;
function sanitizeSource(value) {
  if (!value || value.kind !== 'foreground' || typeof value.name !== 'string') return null;
  const name = value.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 120) return null;
  const result = { name, kind: 'foreground' };
  const icon = value.icon;
  if (typeof icon === 'string' && icon.length <= MAX_ICON_DATA_URL_BYTES && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(icon)) {
    const bytes = Buffer.from(icon.slice(22), 'base64');
    if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 256 && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 256) result.icon = icon;
  }
  return result;
}
const entryBytes = e => Buffer.byteLength(e.text, 'utf8') + (e.source ? Buffer.byteLength(e.source.name, 'utf8') + (e.source.icon?.length || 0) : 0);
function kindOf(text) {
  if (/^https?:\/\/[^\s]+$/i.test(text.trim())) return 'link';
  if (/(?:^|\n)\s*(?:const |let |var |function |import |export |class |def |SELECT |\{\s*$)|=>|<\/?[a-z][^>]*>/m.test(text)) return 'code';
  return 'text';
}
function validateSettings(patch, current = DEFAULT_SETTINGS) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('設定の形式が正しくありません。');
  const settings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) throw new Error('この設定は変更できません。');
    if (key === 'shortcut') {
      if (typeof value !== 'string' || value.length > 100 || !/^(?:(?:CommandOrControl|Command|Control|Ctrl|Alt|Option|Shift|Super)\+)+(?:Space|[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(value) || !/(Command|Control|Ctrl|Alt|Option|Super)/i.test(value)) throw new Error('修飾キーと Space・英数字・F キーを組み合わせてください。');
    } else if (key === 'fanSpread' || key === 'fanDistance') {
      const [min, max] = key === 'fanSpread' ? [20, 55] : [0, 90];
      if (!Number.isInteger(value) || value < min || value > max) throw new Error('カードの開き方は設定範囲内で指定してください。');
    } else if (key === 'historyLimit') {
      if (![30, 60, 100].includes(value)) throw new Error('履歴件数は 30・60・100 から選んでください。');
    } else if (typeof value !== 'boolean') throw new Error('設定の値が正しくありません。');
    settings[key] = value;
  }
  return settings;
}
class History {
  constructor(limit = 60) { this.entries = []; this.limit = limit; }
  restore(values) {
    if (!Array.isArray(values)) return;
    const seen = new Set();
    this.entries = values.slice(0, 100).filter(e => e && validText(e.text)).map(e => ({
      id: randomUUID(), text: e.text, kind: kindOf(e.text), color: COLORS.includes(e.color) ? e.color : 'lavender',
      createdAt: Number.isFinite(e.createdAt) && e.createdAt > 0 ? Math.min(Date.now(), e.createdAt) : Date.now(), pinned: e.pinned === true,
      ...(sanitizeSource(e.source) ? { source: sanitizeSource(e.source) } : {})
    })).filter(e => { const hash = digest(e.text); if (seen.has(hash)) return false; seen.add(hash); return true; });
    this.trim();
  }
  add(text, now = Date.now()) {
    if (!validText(text)) return false;
    const old = this.entries.find(e => e.text === text);
    if (old) { this.entries = this.entries.filter(e => e !== old); old.createdAt = now; delete old.source; this.entries.unshift(old); }
    else this.entries.unshift({ id: randomUUID(), text, kind: kindOf(text), color: COLORS[this.entries.length % COLORS.length], createdAt: now, pinned: false });
    this.trim(); return true;
  }
  trim() {
    let bytes = this.entries.reduce((n, e) => n + entryBytes(e), 0);
    while (this.entries.length > this.limit || bytes > MAX_TOTAL_BYTES) {
      let index = this.entries.findLastIndex(e => !e.pinned);
      if (index < 0) index = this.entries.length - 1; // A hard privacy/memory bound, including pins.
      bytes -= entryBytes(this.entries[index]); this.entries.splice(index, 1);
    }
  }
  setSource(id, capturedAt, source) {
    const entry = this.get(id); const safe = sanitizeSource(source);
    if (!entry || entry.createdAt !== capturedAt || !safe) return false;
    entry.source = safe; this.trim(); return true;
  }
  remove(id) { const before = this.entries.length; this.entries = this.entries.filter(e => e.id !== id); return before !== this.entries.length; }
  pin(id) { const entry = this.entries.find(e => e.id === id); if (!entry) return false; entry.pinned = !entry.pinned; return true; }
  get(id) { return this.entries.find(e => e.id === id); }
  clear() { this.entries = []; }
  snapshot() { return this.entries.map(e => ({ ...e, ...(e.source ? { source: { ...e.source } } : {}) })); }
}
// Never fetch clipboard content while paused or locked. Resume takes a new baseline,
// so something copied during a pause cannot silently enter the history afterward.
class ClipboardMonitor {
  constructor({ read, onText, onError = () => {} }) { this.read = read; this.onText = onText; this.onError = onError; this.last = undefined; this.paused = false; this.busy = false; this.epoch = 0; }
  setPaused(paused) { this.paused = paused; this.last = undefined; this.epoch++; }
  resetBaseline() { this.last = undefined; this.epoch++; }
  noteCopied(text) { this.last = digest(text); this.epoch++; }
  async tick() {
    if (this.paused || this.busy) return;
    this.busy = true; const epoch = this.epoch;
    try {
      const text = await this.read();
      if (epoch !== this.epoch || this.paused) return;
      const hash = typeof text === 'string' ? digest(text) : null;
      if (this.last === undefined) { this.last = hash; return; }
      if (this.last === hash) return;
      this.last = hash;
      if (validText(text)) this.onText(text);
    } catch { if (epoch === this.epoch) this.onError(); }
    finally { this.busy = false; }
  }
}
module.exports = { History, ClipboardMonitor, DEFAULT_SETTINGS, MAX_TEXT_BYTES, MAX_TOTAL_BYTES, validText, kindOf, validateSettings, sanitizeSource, MAX_ICON_DATA_URL_BYTES };
