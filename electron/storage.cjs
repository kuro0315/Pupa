'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS, validateSettings, MAX_TOTAL_BYTES } = require('./history.cjs');
class Storage {
  constructor(directory) { this.directory = directory; this.settingsPath = path.join(directory, 'settings.json'); this.historyPath = path.join(directory, 'history.json'); }
  read(file, maximum) {
    try { if (fs.statSync(file).size > maximum) throw new Error('File too large'); return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  load() {
    let settings = { ...DEFAULT_SETTINGS }; let entries = []; let warning = null;
    try { const data = this.read(this.settingsPath, 4096); if (data) settings = validateSettings(data); }
    catch { warning = '設定を読み込めなかったため、安全な初期設定で起動しました。'; }
    if (settings.persistence) {
      try { const data = this.read(this.historyPath, MAX_TOTAL_BYTES * 7); if (data?.version === 1 && Array.isArray(data.entries)) entries = data.entries; else if (data) throw new Error('Invalid history'); }
      catch { warning = '保存された履歴を読み込めませんでした。新しい履歴は引き続き使えます。'; }
    } else {
      try { this.eraseHistory(); } catch { warning = '以前の履歴ファイルを削除できませんでした。保存先の権限を確認してください。'; }
    }
    return { settings, entries, warning };
  }
  atomic(file, data) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, file);
    } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  }
  saveSettings(settings) { this.atomic(this.settingsPath, settings); }
  saveHistory(entries) { this.atomic(this.historyPath, { version: 1, entries }); }
  eraseHistory() { for (const file of [this.historyPath, this.historyPath + '.tmp']) { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
}
module.exports = { Storage };
