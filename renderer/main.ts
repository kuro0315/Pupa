import './style.css';
import { icons } from './icons';
import { createPreviewBridge } from './preview';
import type { ClipboardEntry, PupaBridge, Result, State } from './types';

const preview = !window.pupa;
const bridge: PupaBridge = window.pupa ?? createPreviewBridge();
const app = document.querySelector<HTMLDivElement>('#app')!;
const icon = (name: keyof typeof icons) => icons[name];
app.innerHTML = `
  <main class="fan-stage ${preview ? 'is-preview' : 'is-desktop'}" tabindex="-1" aria-label="Pupa クリップボード" data-testid="pupa-panel">
    <button class="fan-backdrop" id="backdrop" type="button" tabindex="-1" aria-label="Pupaを隠す"></button>
    <div class="fan-viewport" id="fan-viewport">
      <div class="card-deck" id="card-deck" role="list" aria-label="コピー履歴" data-testid="clipboard-list"></div>
      <div class="empty-state" id="empty-state" hidden><span id="empty-label">履歴はまだありません</span><button class="icon-button" id="empty-search" type="button" aria-label="検索をクリア" hidden>${icon('close')}</button><button class="icon-button" id="empty-settings" type="button" aria-label="設定を開く">${icon('settings')}</button></div>
    </div>
    <section id="search-popover" class="search-popover" aria-label="履歴を検索" hidden><div class="search-line">${icon('search')}<label class="sr-only" for="search">コピー履歴を検索</label><input id="search" data-testid="search-input" type="search" autocomplete="off" spellcheck="false" placeholder="検索"><button class="icon-button" id="search-close" type="button" aria-label="検索を閉じる">${icon('close')}</button></div><div class="filters" aria-label="絞り込み"><button type="button" class="filter active" data-filter="all" aria-pressed="true">すべて</button><button type="button" class="filter" data-filter="pinned" aria-pressed="false">ピン留め</button><button type="button" class="filter" data-filter="link" aria-pressed="false">リンク</button><button type="button" class="filter" data-filter="code" aria-pressed="false">コード</button></div></section>
    <div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
    <div class="preview-controls" ${preview ? '' : 'hidden'}><span>UI PREVIEW · システム連携なし</span><button id="preview-replay" type="button" aria-label="カードをもう一度開く">↗</button></div>
    <button class="preview-launcher" id="preview-launcher" type="button" hidden aria-label="プレビューのカードを開く">${icon('copy')}</button>
  </main>
  <dialog id="settings-dialog" class="pupa-dialog settings-dialog" aria-labelledby="settings-title" data-testid="settings-dialog">
    <form id="settings-form"><div class="dialog-heading"><div><h2 id="settings-title">設定</h2></div><button class="icon-button" type="button" data-close-dialog="settings-dialog" aria-label="設定を閉じる">${icon('close')}</button></div>
      <div id="settings-status" aria-live="polite"></div><div class="setting-row"><div><span class="setting-label">クリップボードの記録</span></div><button type="button" class="soft-button" id="pause-button">一時停止</button></div><div class="setting-group"><label class="setting-label" for="shortcut-input">呼び出すショートカット</label><div class="shortcut-field"><input id="shortcut-input" name="shortcut" spellcheck="false" autocomplete="off" required aria-describedby="shortcut-help"><button type="button" class="soft-button" id="record-shortcut">キーを記録</button></div><p class="field-help" id="shortcut-help">例: CommandOrControl+Shift+Space</p></div>
      <div class="setting-row"><div><label class="setting-label" for="history-limit">覚えておく枚数</label><p class="setting-description">ピン留めした手札も含めた上限です。</p></div><select id="history-limit" name="historyLimit"><option value="30">30 枚</option><option value="60">60 枚</option><option value="100">100 枚</option></select></div>
      <label class="setting-row toggle-row"><span><span class="setting-label">コピーしたら、そっと閉じる</span><span class="setting-description">貼り付けは元のアプリで ⌘ / Ctrl + V。</span></span><input class="switch" id="hide-after-copy" type="checkbox" name="hideAfterCopy"><span class="toggle-track" aria-hidden="true"></span></label>
      <label class="setting-row toggle-row persistence-row"><span><span class="setting-label">次に開くときも、履歴を残す</span><span class="setting-description">オフなら、アプリ終了時に履歴が消えます。</span></span><input class="switch" id="persistence" type="checkbox" name="persistence" aria-describedby="persistence-warning"><span class="toggle-track" aria-hidden="true"></span></label>
      <p class="privacy-warning" id="persistence-warning">${icon('lock')}<span>オンにすると、コピーした内容を暗号化せずにこの端末へ保存します。パスワードなど、大切な情報の保存にはご注意ください。Pupaから外部への送信はしません。</span></p>
      <p class="platform-note" id="platform-note" hidden></p><p class="form-error" id="settings-error" role="alert" hidden></p>
      <div class="dialog-actions"><button type="button" class="text-button quit-button" id="quit-button">終了</button><button type="button" class="text-button" id="clear-history-button" data-testid="clear-history-button">全履歴を削除</button><button type="button" class="soft-button" data-close-dialog="settings-dialog">キャンセル</button><button type="submit" class="primary-button" id="save-settings">設定を保存 ${icon('check')}</button></div><p class="version-label" id="version-label"></p>
    </form>
  </dialog>
  <dialog id="clear-dialog" class="pupa-dialog confirm-dialog" aria-labelledby="clear-title" data-testid="clear-dialog"><h2 id="clear-title">履歴を削除</h2><p class="confirm-body" id="clear-description"></p><p class="confirm-note">ピン留めした手札も削除されます。<br>削除した履歴は元に戻せません。</p><div class="dialog-actions"><button type="button" class="soft-button" data-close-dialog="clear-dialog">やめておく</button><button type="button" class="danger-button" id="confirm-clear" data-testid="confirm-clear">履歴を削除</button></div></dialog>`;
function $<T extends HTMLElement>(selector: string): T { return document.querySelector<T>(selector)!; }
const stage = $('.fan-stage');
const deck = $('#card-deck');
const search = $<HTMLInputElement>('#search');
const settingsDialog = $<HTMLDialogElement>('#settings-dialog');
const clearDialog = $<HTMLDialogElement>('#clear-dialog');
let state: State | null = null;
let filter = 'all';
let selectedId: string | null = null;
let hoverId: string | null = null;
let keyboardId: string | null = null;
let filteredEntries: ClipboardEntry[] = [];
let shownEntries: ClipboardEntry[] = [];
let pageOffset = 0;
let copying = false;
let copiedId: string | null = null;
let animateNext = true;
let recording = false;
let lastFocus: HTMLElement | null = null;
let wheelTime = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
const kindLabels = { text: 'テキスト', link: 'リンク', code: 'コード' } as const;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function addIcon(parent: HTMLElement, name: keyof typeof icons) { const span = make('span', 'icon'); span.innerHTML = icon(name); parent.append(span); }
function timeAgo(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'たった今';
  if (minutes < 60) return `${minutes}分前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}時間前`;
  if (minutes < 2880) return '昨日';
  return new Intl.DateTimeFormat('ja-JP', { month: 'short', day: 'numeric' }).format(timestamp);
}
function capacity() { return window.innerHeight < 600 ? 5 : 7; }
function showToast(message: string, isError = false) {
  clearTimeout(toastTimer);
  const toast = $('#toast'); toast.replaceChildren(); addIcon(toast, isError ? 'close' : 'check'); toast.append(make('span', '', message));
  toast.classList.toggle('is-error', isError); toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, isError ? 6000 : 2400);
}
async function mutate(action: () => Promise<Result>, success?: string) {
  try {
    const result = await action();
    if (!result.ok) { showToast(result.error || '操作できませんでした。もう一度お試しください。', true); return false; }
    if (success) showToast(success);
    return true;
  } catch { showToast('アプリとの接続を確認してください。', true); return false; }
}
function updateExpansion() {
  const activeId = hoverId ?? keyboardId;
  for (const slot of deck.querySelectorAll<HTMLElement>('.card-slot')) {
    const expanded = slot.dataset.id === activeId;
    slot.classList.toggle('is-expanded', expanded);
    slot.style.zIndex = expanded ? '100' : slot.dataset.order!;
    const button = slot.querySelector<HTMLButtonElement>('.card-copy')!;
    button.tabIndex = slot.dataset.id === selectedId ? 0 : -1;
  }
}
function selectCard(id: string, focus = false) {
  selectedId = id;
  if (focus) { hoverId = null; keyboardId = id; }
  updateExpansion();
  if (focus) Array.from(deck.querySelectorAll<HTMLElement>('.card-slot')).find((slot) => slot.dataset.id === id)?.querySelector<HTMLButtonElement>('.card-copy')?.focus({ preventScroll: true });
}
async function copyEntry(entry: ClipboardEntry) {
  if (copying) return;
  copying = true;
  try {
    if (!await mutate(() => bridge.copyEntry(entry.id))) return;
    copiedId = entry.id; clearTimeout(copiedTimer); renderCards();
    if (preview || !state?.settings.hideAfterCopy) showToast(preview ? 'プレビュー: 実際のコピーは行いません' : 'コピーしました');
    copiedTimer = setTimeout(() => { copiedId = null; renderCards(); }, 1700);
    if (preview && state?.settings.hideAfterCopy) previewTimer = setTimeout(hidePreview, 550);
  } finally { copying = false; }
}
function cardAction(name: keyof typeof icons, label: string, action: string, callback: () => void) {
  const button = make('button', 'card-icon'); button.type = 'button'; button.innerHTML = icon(name); button.setAttribute('aria-label', label); button.title = label; button.dataset.action = action;
  button.addEventListener('click', (event) => { event.stopPropagation(); callback(); });
  return button;
}
function changePage(direction: number, focus = false) {
  const max = Math.max(0, filteredEntries.length - capacity());
  const next = Math.max(0, Math.min(max, pageOffset + direction));
  if (next === pageOffset) return;
  pageOffset = next; hoverId = null; keyboardId = null; animateNext = false; renderCards();
  if (focus && shownEntries.length) selectCard(direction > 0 ? shownEntries.at(-1)!.id : shownEntries[0].id, true);
}
function renderCards() {
  if (!state) return;
  const focused = document.activeElement as HTMLElement | null;
  const focusedSlot = focused?.closest<HTMLElement>('.card-slot');
  const focusedAction = focused?.dataset.action;
  const query = search.value.trim().toLocaleLowerCase();
  filteredEntries = state.entries.filter((entry) => (filter === 'all' || (filter === 'pinned' ? entry.pinned : entry.kind === filter)) && (!query || entry.text.toLocaleLowerCase().includes(query)));
  pageOffset = Math.max(0, Math.min(pageOffset, Math.max(0, filteredEntries.length - capacity())));
  shownEntries = filteredEntries.slice(pageOffset, pageOffset + capacity());
  if (!shownEntries.some((entry) => entry.id === selectedId)) selectedId = shownEntries[0]?.id ?? null;
  if (!shownEntries.some((entry) => entry.id === hoverId)) hoverId = null;
  if (!shownEntries.some((entry) => entry.id === keyboardId)) keyboardId = null;
  deck.replaceChildren();
  const maxAngle = window.innerHeight < 580 ? 32 : window.innerHeight < 760 ? 38 : 42;
  const spread = shownEntries.length <= 1 ? 0 : Math.min(maxAngle, (shownEntries.length - 1) * 10.5);
  shownEntries.forEach((entry, index) => {
    const angle = shownEntries.length === 1 ? 0 : spread - (index / (shownEntries.length - 1)) * spread * 2;
    const slot = make('article', `card-slot${animateNext ? ' deal-in' : ''}`);
    slot.dataset.id = entry.id; slot.dataset.order = String(index + 1); slot.dataset.testid = 'clipboard-card'; slot.setAttribute('role', 'listitem');
    slot.style.setProperty('--angle', `${angle}deg`); slot.style.setProperty('--inverse-angle', `${-angle}deg`); slot.style.setProperty('--card-index', String(index)); slot.style.zIndex = String(index + 1);
    const card = make('div', `clip-card color-${entry.color}${entry.pinned ? ' is-pinned' : ''}`);
    card.dataset.testid = 'fan-card';
    const copy = make('button', 'card-copy'); copy.type = 'button'; copy.dataset.action = 'copy'; copy.dataset.testid = 'copy-entry'; copy.tabIndex = entry.id === selectedId ? 0 : -1;
    copy.setAttribute('aria-label', `${kindLabels[entry.kind]}をコピー: ${entry.text.slice(0, 100)}`);
    const number = make('span', 'card-number', String(pageOffset + index + 1).padStart(2, '0')); number.setAttribute('aria-hidden', 'true');
    const content = make(entry.kind === 'code' ? 'pre' : 'p', `card-content content-${entry.kind}`, entry.text);
    const time = make('time', 'card-time', timeAgo(entry.createdAt)); time.dateTime = new Date(entry.createdAt).toISOString();
    copy.append(number, content, time);
    copy.addEventListener('click', () => { selectCard(entry.id); void copyEntry(entry); });
    card.append(copy);
    const topTools = make('div', 'card-top-tools');
    const pin = cardAction('pin', entry.pinned ? 'ピン留めを外す' : 'ピン留めする', 'pin', () => { void mutate(() => bridge.togglePin(entry.id)); });
    pin.classList.toggle('pinned', entry.pinned); pin.setAttribute('aria-pressed', String(entry.pinned)); pin.dataset.testid = 'pin-entry';
    const remove = cardAction('trash', 'この履歴を削除', 'delete', () => { void mutate(() => bridge.deleteEntry(entry.id)); }); remove.dataset.testid = 'delete-entry';
    topTools.append(pin, remove); card.append(topTools);
    const bottomTools = make('div', 'card-bottom-tools');
    if (filteredEntries.length > capacity()) {
      const previous = cardAction('arrow', '前のカード', 'previous', () => changePage(-1)); previous.classList.add('previous-arrow'); previous.disabled = pageOffset === 0;
      const next = cardAction('arrow', '次のカード', 'next', () => changePage(1)); next.disabled = pageOffset >= filteredEntries.length - capacity();
      bottomTools.append(previous, make('span', 'page-count', `${pageOffset + 1}–${pageOffset + shownEntries.length} / ${filteredEntries.length}`), next, make('span', 'tool-divider'));
    }
    bottomTools.append(cardAction('search', '履歴を検索', 'search', openSearch));
    const settings = cardAction('settings', '設定を開く', 'settings', openSettings); settings.dataset.testid = 'settings-button';
    const warning = !state!.status.shortcutRegistered || !!state!.status.storageWarning;
    settings.classList.toggle('has-warning', warning); settings.classList.toggle('is-paused', state!.paused);
    bottomTools.append(settings, cardAction(copiedId === entry.id ? 'check' : 'copy', copiedId === entry.id ? 'コピー済み' : 'コピー', 'copy-icon', () => { void copyEntry(entry); }));
    card.append(bottomTools); slot.append(card); deck.append(slot);
    slot.addEventListener('pointerenter', (event) => { if (event.pointerType === 'touch') return; hoverId = entry.id; selectedId = entry.id; updateExpansion(); });
    slot.addEventListener('pointerleave', () => { if (hoverId === entry.id) { hoverId = null; updateExpansion(); } });
    slot.addEventListener('focusin', () => { keyboardId = entry.id; selectedId = entry.id; updateExpansion(); });
    slot.addEventListener('focusout', (event) => { if (!slot.contains(event.relatedTarget as Node | null) && keyboardId === entry.id) { keyboardId = null; updateExpansion(); } });
  });
  animateNext = false; updateExpansion();
  $('#empty-state').hidden = shownEntries.length > 0;
  $('#empty-label').textContent = query || filter !== 'all' ? '見つかりませんでした' : state.paused ? '記録を一時停止中' : '履歴はまだありません';
  $('#empty-search').hidden = !query && filter === 'all';
  if (focusedSlot) {
    const replacement = Array.from(deck.querySelectorAll<HTMLElement>('.card-slot')).find((slot) => slot.dataset.id === focusedSlot.dataset.id);
    const action = ['pin', 'delete', 'settings', 'search', 'previous', 'next', 'copy-icon'].includes(focusedAction ?? '') ? focusedAction : 'copy';
    const target = replacement?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    (target ?? stage).focus({ preventScroll: true });
  }
}
function renderSettingsStatus() {
  if (!state) return;
  const status = $('#settings-status'); status.replaceChildren();
  if (!state.status.shortcutRegistered) status.append(make('p', 'form-error', 'ショートカットを登録できませんでした。別のキーをお試しください。'));
  if (state.status.storageWarning) status.append(make('p', 'form-error', state.status.storageWarning));
  $('#pause-button').textContent = state.paused ? '記録を再開' : '一時停止';
  $('#pause-button').setAttribute('aria-pressed', String(state.paused));
  $<HTMLButtonElement>('#clear-history-button').disabled = !state.entries.length;
  $('#empty-settings').classList.toggle('has-warning', !state.status.shortcutRegistered || !!state.status.storageWarning);
}
function render() {
  if (!state) return;
  document.querySelectorAll<HTMLButtonElement>('.filter').forEach((button) => { const active = button.dataset.filter === filter; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  renderCards(); renderSettingsStatus();
}
function openSearch() { $('#search-popover').hidden = false; search.focus({ preventScroll: true }); }
function closeSearch(reset = false) { $('#search-popover').hidden = true; if (reset) { search.value = ''; filter = 'all'; pageOffset = 0; render(); } stage.focus({ preventScroll: true }); }
function openDialog(dialog: HTMLDialogElement) { lastFocus = document.activeElement as HTMLElement; dialog.showModal(); }
function closeDialog(dialog: HTMLDialogElement) { dialog.close(); }
function openSettings() {
  if (!state || settingsDialog.open) return;
  $('#search-popover').hidden = true;
  $<HTMLInputElement>('#shortcut-input').value = state.settings.shortcut;
  $<HTMLSelectElement>('#history-limit').value = String(state.settings.historyLimit);
  $<HTMLInputElement>('#hide-after-copy').checked = state.settings.hideAfterCopy;
  $<HTMLInputElement>('#persistence').checked = state.settings.persistence;
  $('#settings-error').hidden = true;
  $('#platform-note').hidden = !state.status.wayland;
  $('#platform-note').textContent = 'Waylandではデスクトップ環境により、ショートカットやクリップボードの取得に制約があります。トレイメニューからも開けます。';
  $('#version-label').textContent = `Pupa ${state.status.version}${preview ? ' · UI preview' : ''}`;
  renderSettingsStatus(); stopRecording(); openDialog(settingsDialog);
}
function stopRecording() { recording = false; $('#record-shortcut').textContent = 'キーを記録'; $('#record-shortcut').classList.remove('recording'); $('#shortcut-help').textContent = '例: CommandOrControl+Shift+Space'; }
function hidePreview() { if (!preview) return; clearTimeout(previewTimer); stage.classList.add('is-tucked'); $('#fan-viewport').inert = true; $('#search-popover').hidden = true; $('#preview-launcher').hidden = false; $('#preview-launcher').focus({ preventScroll: true }); }
function hideApp() { if (preview) hidePreview(); else bridge.hide(); }
function resetForShown() {
  if (settingsDialog.open) settingsDialog.close();
  if (clearDialog.open) clearDialog.close();
  clearTimeout(copiedTimer); copiedId = null; clearTimeout(toastTimer); $('#toast').hidden = true;
  search.value = ''; filter = 'all'; pageOffset = 0; selectedId = null; hoverId = null; keyboardId = null; animateNext = true; $('#search-popover').hidden = true; render(); stage.focus({ preventScroll: true });
}
function revealPreview() { if (!preview) return; clearTimeout(previewTimer); stage.classList.remove('is-tucked'); $('#fan-viewport').inert = false; $('#preview-launcher').hidden = true; resetForShown(); }

$('#backdrop').addEventListener('click', hideApp);
$('#preview-launcher').addEventListener('click', revealPreview);
$('#preview-replay').addEventListener('click', () => { hidePreview(); previewTimer = setTimeout(revealPreview, 300); });
$('#empty-settings').addEventListener('click', openSettings);
$('#empty-search').addEventListener('click', () => closeSearch(true));
$('#search-close').addEventListener('click', () => closeSearch(true));
search.addEventListener('input', () => { pageOffset = 0; hoverId = null; keyboardId = null; render(); });
document.querySelectorAll<HTMLButtonElement>('.filter').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter!; pageOffset = 0; render(); }));
$('#pause-button').addEventListener('click', () => { if (state) { const paused = !state.paused; void mutate(() => bridge.setPaused(paused)); } });
$('#quit-button').addEventListener('click', () => { if (preview) showToast('プレビューでは終了しません'); else bridge.quit(); });
$('#clear-history-button').addEventListener('click', () => { if (!state) return; $('#clear-description').textContent = `${state.entries.length}枚の履歴を削除しますか？`; settingsDialog.close(); openDialog(clearDialog); });
$('#confirm-clear').addEventListener('click', async () => { const button = $<HTMLButtonElement>('#confirm-clear'); button.disabled = true; if (await mutate(() => bridge.clearHistory(), '履歴を削除しました')) closeDialog(clearDialog); button.disabled = false; });
document.querySelectorAll<HTMLButtonElement>('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog($<HTMLDialogElement>(`#${button.dataset.closeDialog}`))));
[settingsDialog, clearDialog].forEach((dialog) => {
  dialog.addEventListener('close', () => { stopRecording(); (lastFocus?.isConnected && !lastFocus.closest('dialog') ? lastFocus : stage).focus({ preventScroll: true }); });
  dialog.addEventListener('click', (event) => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog); });
});
$('#record-shortcut').addEventListener('click', () => { if (recording) { stopRecording(); return; } recording = true; $('#record-shortcut').textContent = '記録をやめる'; $('#record-shortcut').classList.add('recording'); $('#shortcut-help').textContent = 'Ctrl / ⌘ / Alt と一緒に、使いたいキーを押してください。Escで中止。'; });
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); stopRecording(); const save = $<HTMLButtonElement>('#save-settings'); const error = $('#settings-error'); save.disabled = true; error.hidden = true;
  try {
    const result = await bridge.updateSettings({ shortcut: $<HTMLInputElement>('#shortcut-input').value.trim(), historyLimit: Number($<HTMLSelectElement>('#history-limit').value), hideAfterCopy: $<HTMLInputElement>('#hide-after-copy').checked, persistence: $<HTMLInputElement>('#persistence').checked });
    if (!result.ok) { error.textContent = result.error || '設定を保存できませんでした。'; error.hidden = false; }
    else { closeDialog(settingsDialog); showToast('設定を保存しました'); }
  } catch { error.textContent = '設定を保存できませんでした。アプリとの接続を確認してください。'; error.hidden = false; }
  finally { save.disabled = false; }
});
$('#fan-viewport').addEventListener('wheel', (event: WheelEvent) => {
  if (settingsDialog.open || clearDialog.open || filteredEntries.length <= capacity()) return;
  const content = (event.target as HTMLElement).closest<HTMLElement>('.card-content');
  if (content && content.scrollHeight > content.clientHeight + 2) return;
  if (Math.abs(event.deltaY) < 5 || Date.now() - wheelTime < 180) return;
  event.preventDefault(); wheelTime = Date.now(); changePage(event.deltaY > 0 ? 1 : -1);
}, { passive: false });
document.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (preview && !settingsDialog.open && !clearDialog.open && (event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Space') { event.preventDefault(); if (stage.classList.contains('is-tucked')) revealPreview(); else hidePreview(); return; }
  if (recording) {
    if (event.key === 'Escape') { event.preventDefault(); stopRecording(); return; }
    if (['Control', 'Meta', 'Alt', 'Shift', 'Tab'].includes(event.key)) return;
    event.preventDefault();
    if (!event.ctrlKey && !event.metaKey && !event.altKey) { $('#shortcut-help').textContent = 'Ctrl / ⌘ / Alt のいずれかも、一緒に押してください。'; return; }
    const parts: string[] = [];
    if (event.metaKey || event.ctrlKey) parts.push(event.metaKey && event.ctrlKey ? 'Command+Control' : 'CommandOrControl');
    if (event.altKey) parts.push('Alt'); if (event.shiftKey) parts.push('Shift');
    const key = event.code === 'Space' ? 'Space' : event.code.startsWith('Key') ? event.code.slice(3) : event.code.startsWith('Digit') ? event.code.slice(5) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
    if (!/^(?:Space|[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key)) { $('#shortcut-help').textContent = 'Space・英数字・Fキーを組み合わせてください。'; return; }
    parts.push(key); $<HTMLInputElement>('#shortcut-input').value = parts.join('+'); stopRecording(); return;
  }
  if (settingsDialog.open || clearDialog.open) return;
  if (event.key === 'Escape') { event.preventDefault(); if (!$('#search-popover').hidden) closeSearch(true); else hideApp(); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); return; }
  if (event.altKey || event.metaKey || event.ctrlKey || stage.classList.contains('is-tucked')) return;
  const target = event.target as HTMLElement;
  if ((event.key === '/' && target !== search)) { event.preventDefault(); openSearch(); return; }
  if (event.key === ',' && target !== search) { event.preventDefault(); openSettings(); return; }
  if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
    if (!shownEntries.length || (target === search && ['ArrowLeft', 'ArrowRight'].includes(event.key))) return;
    event.preventDefault(); const direction = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1;
    let current = shownEntries.findIndex((entry) => entry.id === selectedId);
    if (!keyboardId && !hoverId) current = direction > 0 ? -1 : shownEntries.length;
    const next = current + direction;
    if (next >= shownEntries.length && pageOffset + shownEntries.length < filteredEntries.length) changePage(1, true);
    else if (next < 0 && pageOffset > 0) changePage(-1, true);
    else selectCard(shownEntries[(next + shownEntries.length) % shownEntries.length].id, true);
  } else if (event.key === 'Enter' && (target === stage || target === search)) {
    const selected = shownEntries.find((entry) => entry.id === selectedId); if (selected) { event.preventDefault(); void copyEntry(selected); }
  } else if (event.key === 'PageDown' || event.key === 'PageUp') { event.preventDefault(); changePage(event.key === 'PageDown' ? capacity() : -capacity(), true); }
});
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderCards(), 80); });
const unsubscribeState = bridge.onState((next) => { state = next; render(); });
const unsubscribeShown = bridge.onShown(resetForShown);
const unsubscribeSettings = bridge.onSettings?.(openSettings) ?? (() => {});
window.addEventListener('pagehide', () => { unsubscribeState(); unsubscribeShown(); unsubscribeSettings(); clearTimeout(toastTimer); clearTimeout(copiedTimer); clearTimeout(previewTimer); clearTimeout(resizeTimer); }, { once: true });
void bridge.getState().then((next) => { state = next; render(); stage.focus({ preventScroll: true }); }).catch(() => {
  $('#empty-state').hidden = false; $('#empty-label').textContent = '履歴を読み込めませんでした'; showToast('Pupaを再起動してください。', true);
});
