import './style.css';
import { icons } from './icons';
import { createPreviewBridge } from './preview';
import { createTauriBridge, isTauriRuntime } from './tauri';
import { createStateReceiver } from './state-order';
import type { ClipboardEntry, PupaBridge, Result, State } from './types';

// Injected fixtures stay authoritative; browser previews never invoke native APIs.
const preview = !window.pupa && !isTauriRuntime();
const bridge: PupaBridge = window.pupa ?? (preview ? createPreviewBridge() : createTauriBridge());
if (!preview) window.pupa = bridge;
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
      <div id="settings-status" aria-live="polite"></div><div class="setting-row"><div><span class="setting-label">クリップボードの記録</span></div><button type="button" class="soft-button" id="pause-button">一時停止</button></div><div class="setting-group" id="native-shortcut-controls"><label class="setting-label" for="shortcut-input">呼び出すショートカット</label><div class="shortcut-field"><input id="shortcut-input" name="shortcut" spellcheck="false" autocomplete="off" required aria-describedby="shortcut-help"><button type="button" class="soft-button" id="record-shortcut">キーを記録</button></div><p class="field-help" id="shortcut-help">例: CommandOrControl+Shift+Space</p></div>
      <div class="setting-group" id="system-shortcut-controls" hidden><span class="setting-label" id="system-shortcut-label">システムのショートカット</span><p class="setting-description" id="system-shortcut-status" role="status" aria-live="polite"></p><p class="setting-description" id="system-shortcut-current" hidden>現在のキー: <output id="system-shortcut-trigger"></output></p><button type="button" class="soft-button" id="system-shortcut-button" data-testid="system-shortcut-button" aria-describedby="system-shortcut-status system-shortcut-help">システムショートカットを有効にする</button><p class="field-help" id="system-shortcut-help">OSの確認画面が開きます。許可やキーの選択は、その画面で行ってください。</p><p class="form-error" id="system-shortcut-error" role="alert" hidden></p></div>
      <div class="setting-row"><div><label class="setting-label" for="history-limit">覚えておく枚数</label><p class="setting-description">ピン留めした手札も含めた上限です。</p></div><select id="history-limit" name="historyLimit"><option value="30">30 枚</option><option value="60">60 枚</option><option value="100">100 枚</option></select></div>
      <div class="history-reduction-warning" id="history-reduction-warning" hidden><p id="history-reduction-description"></p><label><input id="confirm-history-reduction" data-testid="confirm-history-reduction" type="checkbox">削除される可能性を確認しました</label></div>
      <div class="setting-row fan-setting"><div class="slider-heading"><label class="setting-label" for="fan-spread">カードの開く角度</label><output id="fan-spread-value" for="fan-spread">72°</output></div><input id="fan-spread" data-testid="fan-spread-setting" type="range" min="20" max="84" step="1" value="72"><div class="slider-labels"><span>せまく</span><span>広く</span></div></div>
      <div class="setting-row fan-setting"><div class="slider-heading"><label class="setting-label" for="fan-distance">画面の端からの距離</label><output id="fan-distance-value" for="fan-distance">0 px</output></div><input id="fan-distance" data-testid="fan-distance-setting" type="range" min="0" max="90" step="1" value="0"><div class="slider-labels"><span>近く</span><span>遠く</span></div><p class="setting-description">画面に収まる範囲に調整されます。</p></div>
      <label class="setting-row toggle-row"><span><span class="setting-label">収集時のアプリを記録</span><span class="setting-description" id="source-app-description">アプリ名とローカルのアイコンのみ。ウィンドウ名やURLは記録しません。</span><span class="setting-description" id="source-app-platform-note" hidden>GNOME / Waylandでアプリ名を記録するには、Pupa Source App拡張機能の有効化が必要です。未導入・取得できない場合は「アプリ不明」になります。アイコンは端末にインストールされたアプリから取得します。</span></span><input class="switch" id="source-app" data-testid="source-app-setting" type="checkbox" name="sourceApp" aria-describedby="source-app-description source-app-platform-note"><span class="toggle-track" aria-hidden="true"></span></label>
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
let renderedViewport = { width: 0, height: 0 };
let filter = 'all';
let selectedId: string | null = null;
let hoverId: string | null = null;
let keyboardId: string | null = null;
let interactionMode: 'pointer' | 'keyboard' = 'pointer';
let pointerPressId: string | null = null;
type CardRegion = { id: string; left: number; top: number; width: number; height: number; angle: number; expandedX: number; expandedY: number; expandedAngle: number; scale: number };
let cardRegions: CardRegion[] = [];
let lastPointerPosition: { x: number; y: number } | null = null;
let filteredEntries: ClipboardEntry[] = [];
let shownEntries: ClipboardEntry[] = [];
let pageOffset = 0;
let copying = false;
let copyEpoch = 0;
let pendingDismissToken: string | null = null;
let copyAfterimage: HTMLDivElement | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | undefined;
let copiedId: string | null = null;
let animateNext = true;
let recording = false;
let systemShortcutRequestPending = false;
let lastFocus: HTMLElement | null = null;
let wheelTime = 0;
let draftFan: { fanSpread: number; fanDistance: number } | null = null;
let reductionScope = '';
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
function measureFanViewport() {
  // These are CSS pixels in the actual webview, not physical monitor pixels.
  // Native code positions that webview against the monitor's work-area edge.
  const bounds = stage.getBoundingClientRect();
  return { width: bounds.width || window.innerWidth, height: bounds.height || window.innerHeight };
}
function capacity() { return measureFanViewport().height < 600 ? 5 : 7; }
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
  const activeId = pendingDismissToken && copiedId ? copiedId : interactionMode === 'pointer' ? hoverId : keyboardId;
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
  if (focus) { interactionMode = 'keyboard'; hoverId = null; keyboardId = id; }
  updateExpansion();
  if (focus) Array.from(deck.querySelectorAll<HTMLElement>('.card-slot')).find((slot) => slot.dataset.id === id)?.querySelector<HTMLButtonElement>('.card-copy')?.focus({ preventScroll: true });
}
// Hit testing follows the unchanging hand, not the animated front-most card.
// Otherwise the card pulled left would cover its neighbors and trap the hover.
function containsPoint(region: CardRegion, x: number, y: number, expanded = false) {
  const angle = (expanded ? region.expandedAngle : region.angle) * Math.PI / 180;
  const scale = expanded ? region.scale : 1;
  const dx = x - (region.left + region.width / 2 + (expanded ? region.expandedX : 0));
  const dy = y - (region.top + region.height / 2 + (expanded ? region.expandedY : 0));
  return Math.abs(dx * Math.cos(angle) + dy * Math.sin(angle)) <= region.width * scale / 2
    && Math.abs(-dx * Math.sin(angle) + dy * Math.cos(angle)) <= region.height * scale / 2;
}
function pointerRegion(x: number, y: number, target: Element | null) {
  const activeId = interactionMode === 'pointer' ? hoverId : keyboardId;
  const active = cardRegions.find(region => region.id === activeId);
  // Visible tools remain operable even where the pulled card overlaps the hand.
  if (active && target?.closest('.card-icon')?.closest<HTMLElement>('.card-slot')?.dataset.id === active.id) return active;
  const resting = [...cardRegions].reverse().find(region => containsPoint(region, x, y));
  if (resting) return resting;
  // The exposed left portion is also usable, but never masks another leaf's
  // resting region. Moving entirely away from both regions returns the hand.
  return active && containsPoint(active, x, y, true) ? active : undefined;
}
function pointAtCard(id: string | null) {
  interactionMode = 'pointer'; hoverId = id;
  if (id) selectedId = id;
  updateExpansion();
}
function isUtilityTarget(target: Element | null) {
  return !!target?.closest('dialog, .search-popover, .preview-controls, .preview-launcher, .empty-state, .toast');
}
function clearCopyAfterimage() { copyAfterimage?.remove(); copyAfterimage = null; }
function showCopyAfterimage(id: string) {
  clearCopyAfterimage();
  const region = cardRegions.find(candidate => candidate.id === id);
  const slot = Array.from(deck.querySelectorAll<HTMLElement>('.card-slot')).find(candidate => candidate.dataset.id === id);
  const card = slot?.querySelector<HTMLElement>('.clip-card');
  if (!region || !card) return;
  const bounds = card.getBoundingClientRect();
  const stageBounds = stage.getBoundingClientRect();
  const ghost = make('div', 'copy-afterimage');
  ghost.dataset.testid = 'copy-afterimage'; ghost.setAttribute('aria-hidden', 'true');
  // Decorative geometry only. Never clone clipboard text, app icons or controls.
  ghost.innerHTML = `<svg class="copy-circuit" viewBox="0 0 440 260" preserveAspectRatio="none" fill="none" aria-hidden="true">
    <path class="copy-circuit-rim" d="M16 2H416L438 24V244L424 258H16L2 244V16Z"/>
    <path class="copy-circuit-charge" pathLength="100" d="M16 2H416L438 24V244L424 258H16L2 244V16Z"/>
    <path class="copy-circuit-echo" pathLength="100" d="M16 2H416L438 24V244L424 258H16L2 244V16Z"/>
    <path class="copy-electric-arc copy-electric-arc-top" pathLength="100" d="M-12 38L12 30L4 19L40 24L55 5L77 14L103-9L124 2L149-3"/>
    <path class="copy-electric-arc copy-electric-arc-bottom" pathLength="100" d="M289 263L319 249L331 268L351 251L375 261L393 241L417 250L449 225"/>
    <path class="copy-electric-sparks" d="M-12 63L-24 67M76-11L80-23M451 181L465 177M364 272L369 285"/>
  </svg>`;
  ghost.style.width = `${region.width}px`; ghost.style.height = `${region.height}px`;
  ghost.style.left = `${(bounds.left + bounds.right) / 2 - stageBounds.left - region.width / 2}px`;
  ghost.style.top = `${(bounds.top + bounds.bottom) / 2 - stageBounds.top - region.height / 2}px`;
  ghost.style.transform = `rotate(${region.expandedAngle}deg) scale(${region.scale})`;
  stage.append(ghost); copyAfterimage = ghost;
}
function cancelCopyFeedback() {
  copyEpoch++; clearTimeout(dismissTimer); dismissTimer = undefined; clearCopyAfterimage();
  pendingDismissToken = null; copying = false; copiedId = null; clearTimeout(copiedTimer);
  stage.classList.remove('is-copy-dismiss', 'is-copy-dismissed');
  deck.querySelectorAll('.is-copy-confirmed').forEach(slot => slot.classList.remove('is-copy-confirmed'));
  $('#fan-viewport').inert = stage.classList.contains('is-tucked');
}
async function finishCopyDismissal(token: string, epoch: number) {
  if (epoch !== copyEpoch || pendingDismissToken !== token) return;
  clearCopyAfterimage(); stage.classList.add('is-copy-dismissed');
  try {
    const result = await bridge.completeCopyDismissal(token);
    if (epoch !== copyEpoch || pendingDismissToken !== token) return;
    if (!result.ok) { cancelCopyFeedback(); showToast('コピーしました。ウィンドウを閉じられませんでした。', true); return; }
    if (preview) hidePreview(false);
    // Native hiding is token-scoped. Never issue a generic hide here: a newer
    // shown event may already refer to a different window presentation.
  } catch {
    if (epoch !== copyEpoch) return;
    cancelCopyFeedback(); showToast('コピーしました。ウィンドウを閉じられませんでした。', true);
  }
}
async function copyEntry(entry: ClipboardEntry) {
  if (copying) return;
  copying = true;
  const epoch = ++copyEpoch;
  try {
    const result = await bridge.copyEntry(entry.id);
    if (epoch !== copyEpoch) return;
    if (!result.ok) { showToast(result.error || 'コピーできませんでした。もう一度お試しください。', true); return; }
    // No token means that the window changed while the actual clipboard write
    // was in flight. The successful old write must not animate this new view.
    if (!result.dismissToken) return;
    pendingDismissToken = result.dismissToken; copiedId = entry.id; renderCards();
    if (preview) showToast('プレビュー: 実際のコピーは行いません');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reducedMotion) showCopyAfterimage(entry.id);
    stage.classList.add('is-copy-dismiss'); $('#fan-viewport').inert = true;
    const duration = reducedMotion ? 0 : 420;
    dismissTimer = setTimeout(() => { void finishCopyDismissal(result.dismissToken!, epoch); }, duration);
  } catch {
    if (epoch === copyEpoch) showToast('アプリとの接続を確認してください。', true);
  } finally {
    if (epoch === copyEpoch && !pendingDismissToken) copying = false;
  }
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
function fanGeometry(count: number) {
  const { width, height } = measureFanViewport();
  renderedViewport = { width, height };
  const compact = width <= 560;
  const margin = compact ? 12 : 18;
  const configuredSpread = draftFan?.fanSpread ?? state?.settings.fanSpread ?? 72;
  const configuredDistance = draftFan?.fanDistance ?? state?.settings.fanDistance ?? 0;
  const spread = Math.max(20, Math.min(84, configuredSpread));
  const cardHeight = Math.min(compact ? 210 : 232, height * .3, (width - margin * 2) * .62);
  // A rotated rectangle can be wider than the unrotated card. Reserve its
  // complete diagonal so intermediate leaves also fit narrow displays.
  const cardWidth = Math.min(compact ? 360 : 440, width - margin * 2 - 30, height * .66, Math.sqrt(Math.max(1, (width - margin * 2) ** 2 - cardHeight ** 2)));
  // Spreading the centers as well as the angles opens up the whole available
  // work-area height. A fixed-radius pivot would leave tall displays half empty.
  const fullness = Math.min(1, .45 + (spread - 20) / 52 * .55);
  const countSpread = Math.min(1, Math.max(0, count - 1) / 4);
  const distance = Math.max(0, Math.min(90, configuredDistance, width - margin * 2 - cardWidth * (compact ? 1.1 : 1.22)));
  stage.style.setProperty('--fan-distance', `${distance.toFixed(2)}px`);
  stage.style.setProperty('--card-width', `${cardWidth.toFixed(2)}px`);
  stage.style.setProperty('--card-height', `${cardHeight.toFixed(2)}px`);
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  return Array.from({ length: count }, (_, index) => {
    const position = count === 1 ? 0 : 1 - index / (count - 1) * 2;
    const angle = position * spread * countSpread;
    const radians = angle * Math.PI / 180;
    const halfWidth = (cardWidth * Math.cos(radians) + cardHeight * Math.abs(Math.sin(radians))) / 2;
    const halfHeight = (cardWidth * Math.abs(Math.sin(radians)) + cardHeight * Math.cos(radians)) / 2;
    // Each visible leaf touches the same right-edge rail without clipping any
    // corner. Its center can move vertically independently of its rotation.
    const centerX = clamp(width - margin - distance - halfWidth, margin + halfWidth, width - margin - halfWidth);
    const centerY = height / 2 - position * Math.max(0, height / 2 - margin - halfHeight) * fullness * countSpread;
    // Pull the leaf out of the hand rather than zooming it: only a small lift
    // and a trace of its original angle remain, so the text stays readable.
    const expandedAngle = angle * (compact ? .06 : .8);
    const expandedRadians = expandedAngle * Math.PI / 180;
    const expandedWidth = cardWidth * Math.cos(expandedRadians) + cardHeight * Math.abs(Math.sin(expandedRadians));
    const expandedHeight = cardWidth * Math.abs(Math.sin(expandedRadians)) + cardHeight * Math.cos(expandedRadians);
    const scale = Math.min(compact ? 1.06 : 1.08, (width - margin * 2) / expandedWidth, (height - margin * 2) / expandedHeight);
    const expandedHalfWidth = expandedWidth * scale / 2;
    const expandedHalfHeight = expandedHeight * scale / 2;
    const expandedX = clamp(centerX - (compact ? 36 : 92), margin + expandedHalfWidth, width - margin - expandedHalfWidth);
    const expandedY = clamp(centerY, margin + expandedHalfHeight, height - margin - expandedHalfHeight);
    return { angle, width: cardWidth, height: cardHeight, left: centerX - cardWidth / 2, top: centerY - cardHeight / 2, expandedX: expandedX - centerX, expandedY: expandedY - centerY, expandedAngle, scale };
  });
}
function updateHistoryWarning() {
  if (!state) return;
  const limit = Number($<HTMLSelectElement>('#history-limit').value);
  const count = state.entries.length;
  const active = limit < count;
  const scope = active ? `${limit}:${count}` : '';
  const checkbox = $<HTMLInputElement>('#confirm-history-reduction');
  if (scope !== reductionScope) checkbox.checked = false;
  reductionScope = scope; checkbox.required = active;
  $('#history-reduction-warning').hidden = !active;
  $('#history-reduction-description').textContent = `現在${count}件あります。${limit}件に減らすと、古い履歴（ピン留めを含む）が削除される場合があります。元に戻せません。`;
}
function updateFanDraft() {
  draftFan = { fanSpread: Number($<HTMLInputElement>('#fan-spread').value), fanDistance: Number($<HTMLInputElement>('#fan-distance').value) };
  $('#fan-spread-value').textContent = `${draftFan.fanSpread}°`; $('#fan-distance-value').textContent = `${draftFan.fanDistance} px`; renderCards();
}
function renderCards() {
  if (!state) return;
  const focused = document.activeElement as HTMLElement | null;
  const focusedSlot = focused?.closest<HTMLElement>('.card-slot');
  const focusedAction = focused?.dataset.action;
  const retainedKeyboardId = focusedSlot?.dataset.id ?? keyboardId;
  const retainedHoverId = hoverId;
  const retainedMode = interactionMode;
  const query = search.value.trim().toLocaleLowerCase();
  filteredEntries = state.entries.filter((entry) => (filter === 'all' || (filter === 'pinned' ? entry.pinned : entry.kind === filter)) && (!query || entry.text.toLocaleLowerCase().includes(query)));
  pageOffset = Math.max(0, Math.min(pageOffset, Math.max(0, filteredEntries.length - capacity())));
  shownEntries = filteredEntries.slice(pageOffset, pageOffset + capacity());
  if (!shownEntries.some((entry) => entry.id === selectedId)) selectedId = shownEntries[0]?.id ?? null;
  if (!shownEntries.some((entry) => entry.id === hoverId)) hoverId = null;
  if (!shownEntries.some((entry) => entry.id === keyboardId)) keyboardId = null;
  deck.replaceChildren();
  const geometry = fanGeometry(shownEntries.length);
  cardRegions = geometry.map((region, index) => ({ ...region, id: shownEntries[index].id }));
  shownEntries.forEach((entry, index) => {
    const { angle, left, top, expandedX, expandedY, expandedAngle, scale } = geometry[index];
    const slot = make('article', `card-slot${animateNext ? ' deal-in' : ''}${copiedId === entry.id ? ' is-copy-confirmed' : ''}`);
    slot.dataset.id = entry.id; slot.dataset.order = String(index + 1); slot.dataset.testid = 'clipboard-card'; slot.setAttribute('role', 'listitem');
    slot.style.setProperty('--angle', `${angle}deg`); slot.style.setProperty('--inverse-angle', `${-angle}deg`); slot.style.setProperty('--card-index', String(index)); slot.style.zIndex = String(index + 1);
    slot.style.left = `${left.toFixed(2)}px`; slot.style.top = `${top.toFixed(2)}px`;
    slot.style.setProperty('--expanded-x', `${expandedX.toFixed(2)}px`); slot.style.setProperty('--expanded-y', `${expandedY.toFixed(2)}px`); slot.style.setProperty('--expanded-scale', String(scale)); slot.style.setProperty('--expanded-angle', `${expandedAngle}deg`);
    const card = make('div', `clip-card color-${entry.color}${entry.pinned ? ' is-pinned' : ''}`);
    card.dataset.testid = 'fan-card';
    const source = entry.source?.kind === 'foreground' && typeof entry.source.name === 'string' && entry.source.name.trim() ? entry.source : undefined;
    const sourceName = source ? source.name : 'アプリ不明';
    const watermark = make('div', 'source-watermark'); watermark.dataset.testid = 'source-watermark'; watermark.setAttribute('aria-hidden', 'true');
    // Only bounded inline PNGs from the local app adapter are accepted. No URLs.
    if (source?.icon && source.icon.length <= 400_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(source.icon)) {
      const image = make('img', 'source-icon'); image.alt = ''; image.draggable = false; image.src = source.icon;
      image.addEventListener('error', () => { watermark.replaceChildren(); addIcon(watermark, 'app'); }, { once: true });
      watermark.append(image);
    } else addIcon(watermark, 'app');
    card.append(watermark);
    const copy = make('button', 'card-copy'); copy.type = 'button'; copy.dataset.action = 'copy'; copy.dataset.testid = 'copy-entry'; copy.tabIndex = entry.id === selectedId ? 0 : -1;
    copy.setAttribute('aria-label', `${sourceName}、${kindLabels[entry.kind]}をコピー: ${entry.text.slice(0, 100)}`);
    const number = make('span', 'card-number', String(pageOffset + index + 1).padStart(2, '0')); number.setAttribute('aria-hidden', 'true');
    const sourceLabel = make('span', 'source-label', sourceName); sourceLabel.dataset.testid = 'source-app-label';
    sourceLabel.title = source ? 'コピー検出時に最前面だったアプリです。コピー元を保証するものではありません。' : '収集時のアプリ情報はありません。';
    const content = make(entry.kind === 'code' ? 'pre' : 'p', `card-content content-${entry.kind}`, entry.text);
    const time = make('time', 'card-time', timeAgo(entry.createdAt)); time.dateTime = new Date(entry.createdAt).toISOString();
    copy.append(number, sourceLabel, content, time);
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
    const warning = !state!.status.shortcutRegistered || !!state!.status.storageWarning || !!state!.status.positionWarning;
    settings.classList.toggle('has-warning', warning); settings.classList.toggle('is-paused', state!.paused);
    bottomTools.append(settings, cardAction(copiedId === entry.id ? 'check' : 'copy', copiedId === entry.id ? 'コピー済み' : 'コピー', 'copy-icon', () => { void copyEntry(entry); }));
    card.append(bottomTools); slot.append(card); deck.append(slot);
    slot.addEventListener('focusin', () => { interactionMode = 'keyboard'; hoverId = null; keyboardId = entry.id; selectedId = entry.id; updateExpansion(); });
    slot.addEventListener('focusout', (event) => { if (!slot.isConnected) return; if (!slot.contains(event.relatedTarget as Node | null) && keyboardId === entry.id) { keyboardId = null; updateExpansion(); } });
  });
  // Removing a focused/hovered DOM node may emit leave/out events, and an
  // unfocused native WebContents may not emit focusin when focus is restored.
  // Preserve the logical expansion explicitly instead of relying on DOM events.
  keyboardId = shownEntries.some((entry) => entry.id === retainedKeyboardId) ? retainedKeyboardId : null;
  hoverId = shownEntries.some((entry) => entry.id === retainedHoverId) ? retainedHoverId : null;
  if (keyboardId && focusedSlot) selectedId = keyboardId;
  animateNext = false; updateExpansion();
  $('#empty-state').hidden = shownEntries.length > 0;
  $('#empty-label').textContent = query || filter !== 'all' ? '見つかりませんでした' : state.paused ? '記録を一時停止中' : '履歴はまだありません';
  $('#empty-search').hidden = !query && filter === 'all';
  if (focusedSlot) {
    const replacement = Array.from(deck.querySelectorAll<HTMLElement>('.card-slot')).find((slot) => slot.dataset.id === focusedSlot.dataset.id);
    const action = ['pin', 'delete', 'settings', 'search', 'previous', 'next', 'copy-icon'].includes(focusedAction ?? '') ? focusedAction : 'copy';
    const target = replacement?.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    if (target && replacement) { keyboardId = replacement.dataset.id!; selectedId = keyboardId; }
    (target ?? stage).focus({ preventScroll: true });
    updateExpansion();
  }
  interactionMode = retainedMode;
  hoverId = shownEntries.some((entry) => entry.id === retainedHoverId) ? retainedHoverId : null;
  updateExpansion();
}
function usesSystemShortcut() { return state?.status.shortcutBackend === 'portal'; }
function renderShortcutSettings() {
  if (!state) return;
  const portal = usesSystemShortcut();
  $('#native-shortcut-controls').hidden = portal;
  $('#system-shortcut-controls').hidden = !portal;
  $<HTMLInputElement>('#shortcut-input').disabled = portal;
  $<HTMLButtonElement>('#record-shortcut').disabled = portal;
  if (portal && recording) stopRecording();
  $('#source-app-platform-note').hidden = !(state.status.platform === 'linux' && state.status.wayland);
  if (!portal) return;
  const current = state.status.shortcutState ?? (state.status.shortcutRegistered ? 'registered' : 'needs-approval');
  const busy = systemShortcutRequestPending || current === 'requesting';
  const descriptions = {
    'needs-approval': 'システムの確認画面でショートカットを許可してください。',
    requesting: 'システムの設定・確認画面での操作を待っています。',
    registered: 'ショートカットはシステムに登録されています。',
    cancelled: '許可されなかったか、設定がキャンセルされました。もう一度試せます。',
    unavailable: 'この環境ではシステムのショートカット機能を利用できません。トレイメニューまたはランチャーから開いてください。',
    closed: 'システムとのショートカット接続が終了しました。もう一度接続してください。',
    error: 'システムのショートカットを設定できませんでした。もう一度試せます。',
  };
  $('#system-shortcut-status').textContent = current === 'requesting' ? descriptions.requesting : state.status.shortcutWarning || (busy && current === 'needs-approval' ? descriptions.requesting : descriptions[current]);
  const registered = current === 'registered' && state.status.shortcutRegistered;
  $('#system-shortcut-current').hidden = !registered;
  $('#system-shortcut-trigger').textContent = registered ? state.status.shortcutTrigger || 'OSからキー表示は提供されていません' : '';
  const button = $<HTMLButtonElement>('#system-shortcut-button');
  button.disabled = busy; button.setAttribute('aria-busy', String(busy));
  button.textContent = busy ? 'システム画面で設定中…' : registered ? 'システム設定で変更' : current === 'needs-approval' ? 'システムショートカットを有効にする' : current === 'closed' ? 'システムに再接続' : 'もう一度設定する';
}
function renderSettingsStatus() {
  if (!state) return;
  renderShortcutSettings();
  const status = $('#settings-status'); status.replaceChildren();
  if (!usesSystemShortcut() && state.status.shortcutAvailable === false) status.append(make('p', 'form-error', 'この環境ではグローバルショートカットを利用できません。トレイメニューまたはアプリのランチャーからPupaを開いてください。'));
  else if (!usesSystemShortcut() && !state.status.shortcutRegistered) status.append(make('p', 'form-error', 'ショートカットを登録できませんでした。別のキーをお試しください。'));
  if (state.status.storageWarning) status.append(make('p', 'form-error', state.status.storageWarning));
  if (state.status.positionWarning) status.append(make('p', 'form-error', state.status.positionWarning));
  $('#pause-button').textContent = state.paused ? '記録を再開' : '一時停止';
  $('#pause-button').setAttribute('aria-pressed', String(state.paused));
  $<HTMLButtonElement>('#clear-history-button').disabled = !state.entries.length;
  $('#empty-settings').classList.toggle('has-warning', !state.status.shortcutRegistered || !!state.status.storageWarning || !!state.status.positionWarning);
  if (settingsDialog.open) updateHistoryWarning();
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
  $<HTMLInputElement>('#persistence').checked = state.settings.persistence;
  $<HTMLInputElement>('#source-app').checked = state.settings.sourceApp !== false;
  $<HTMLInputElement>('#fan-spread').value = String(state.settings.fanSpread ?? 72);
  $<HTMLInputElement>('#fan-distance').value = String(state.settings.fanDistance ?? 0);
  reductionScope = ''; updateHistoryWarning(); updateFanDraft();
  $('#settings-error').hidden = true; $('#system-shortcut-error').hidden = true;
  $('#platform-note').hidden = !state.status.wayland;
  $('#platform-note').textContent = usesSystemShortcut() ? 'ショートカットはOSが管理します。確認画面で許可・キー設定を行ってください。' : 'Waylandでは環境によりグローバルショートカットを利用できません。トレイメニューまたはランチャーから開けます。';
  $('#version-label').textContent = `Pupa ${state.status.version}${preview ? ' · UI preview' : ''}`;
  renderSettingsStatus(); stopRecording(); openDialog(settingsDialog);
}
function stopRecording() { recording = false; $('#record-shortcut').textContent = 'キーを記録'; $('#record-shortcut').classList.remove('recording'); $('#shortcut-help').textContent = '例: CommandOrControl+Shift+Space'; }
function hidePreview(cancelPending = true) { if (!preview) return; if (cancelPending) { cancelCopyFeedback(); bridge.hide(); } clearTimeout(previewTimer); stage.classList.add('is-tucked'); $('#fan-viewport').inert = true; $('#search-popover').hidden = true; $('#preview-launcher').hidden = false; $('#preview-launcher').focus({ preventScroll: true }); }
function hideApp() { if (preview) hidePreview(); else { cancelCopyFeedback(); bridge.hide(); } }
function resetForShown() {
  cancelCopyFeedback();
  if (settingsDialog.open) settingsDialog.close();
  if (clearDialog.open) clearDialog.close();
  clearTimeout(copiedTimer); copiedId = null; clearTimeout(toastTimer); $('#toast').hidden = true;
  search.value = ''; filter = 'all'; pageOffset = 0; selectedId = null; hoverId = null; keyboardId = null; interactionMode = 'pointer'; lastPointerPosition = null; animateNext = true; $('#search-popover').hidden = true; render(); stage.focus({ preventScroll: true });
}
function revealPreview() { if (!preview) return; clearTimeout(previewTimer); stage.classList.remove('is-tucked'); $('#fan-viewport').inert = false; $('#preview-launcher').hidden = true; resetForShown(); }

stage.addEventListener('pointermove', (event) => {
  if (copying || event.pointerType === 'touch' || settingsDialog.open || clearDialog.open || stage.classList.contains('is-tucked')) return;
  const moved = !lastPointerPosition || event.clientX !== lastPointerPosition.x || event.clientY !== lastPointerPosition.y;
  lastPointerPosition = { x: event.clientX, y: event.clientY };
  if (!moved) return;
  const target = event.target instanceof Element ? event.target : null;
  const region = isUtilityTarget(target) ? undefined : pointerRegion(event.clientX, event.clientY, target);
  // A keyboard user can approach the pulled card from outside the hand without
  // collapsing it. Once the pointer engages a card, pointer-leave owns reset.
  if (!region && interactionMode === 'keyboard') return;
  pointAtCard(region?.id ?? null);
}, true);
stage.addEventListener('pointerleave', () => { if (!copying && interactionMode === 'pointer') pointAtCard(null); });
window.addEventListener('blur', () => { if (!copying && interactionMode === 'pointer') pointAtCard(null); });
stage.addEventListener('pointerdown', (event) => {
  pointerPressId = null;
  if (copying || event.button !== 0 || settingsDialog.open || clearDialog.open) return;
  const target = event.target instanceof Element ? event.target : null;
  if (isUtilityTarget(target) || target?.closest('.card-icon')) return;
  const visibleCard = target?.closest('.card-copy')?.closest<HTMLElement>('.card-slot.is-expanded');
  pointerPressId = visibleCard?.dataset.id ?? pointerRegion(event.clientX, event.clientY, target)?.id ?? null;
  // Keep the mouse's resolved card instead of moving DOM focus to whichever
  // animated visual happened to receive pointerdown halfway through a switch.
  if (pointerPressId) event.preventDefault();
}, true);
stage.addEventListener('pointerup', () => { setTimeout(() => { pointerPressId = null; }, 0); });
stage.addEventListener('pointercancel', () => { pointerPressId = null; });
stage.addEventListener('click', (event) => {
  // Keyboard activation belongs to its focused button. Pointer clicks resolve
  // through the same stable map as hover, even during the pull animation.
  const target = event.target instanceof Element ? event.target : null;
  if (copying) {
    if (target?.closest('#preview-launcher, #preview-replay')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (target?.closest('#backdrop')) hideApp();
    return;
  }
  if (event.detail === 0 || event.button !== 0 || settingsDialog.open || clearDialog.open) return;
  if (isUtilityTarget(target)) return;
  const tool = target?.closest('.card-icon');
  if (tool?.closest('.card-slot.is-expanded')) return;
  const visibleCard = target?.closest('.card-copy')?.closest<HTMLElement>('.card-slot.is-expanded');
  const id = pointerPressId ?? visibleCard?.dataset.id ?? pointerRegion(event.clientX, event.clientY, target)?.id;
  pointerPressId = null;
  const entry = id && shownEntries.find(candidate => candidate.id === id);
  if (!entry) return;
  event.preventDefault(); event.stopImmediatePropagation(); pointAtCard(entry.id); void copyEntry(entry);
}, true);

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
  dialog.addEventListener('close', () => {
    // close is queued by the browser. Do not steal a focus choice made after
    // dismissal but before this event (including assistive/keyboard focus).
    const active = document.activeElement;
    const restoreFocus = active === document.body || active === stage || active === dialog || dialog.contains(active);
    stopRecording(); if (dialog === settingsDialog) { draftFan = null; renderCards(); }
    if (restoreFocus) (lastFocus?.isConnected && !lastFocus.closest('dialog') ? lastFocus : stage).focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (event) => { if (event.target !== dialog) return; const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog); });
});
$('#system-shortcut-button').addEventListener('click', async (event) => {
  event.preventDefault(); event.stopPropagation();
  if (!usesSystemShortcut() || systemShortcutRequestPending || state?.status.shortcutState === 'requesting') return;
  systemShortcutRequestPending = true;
  const error = $('#system-shortcut-error'); error.hidden = true; renderShortcutSettings();
  try {
    // Only this explicit settings button opens the OS flow. Result.ok is not
    // permission or registration: authoritative state and trigger come back
    // through pupa-state/getState, including later ShortcutsChanged events.
    const result = await bridge.requestSystemShortcut();
    applyState(await bridge.getState());
    if (!result.ok && !state?.status.shortcutWarning) {
      error.textContent = result.error || 'システム設定を開けませんでした。もう一度お試しください。'; error.hidden = false;
    }
  } catch {
    error.textContent = 'システム設定を開けませんでした。アプリとの接続を確認して、もう一度お試しください。'; error.hidden = false;
  } finally {
    systemShortcutRequestPending = false; renderSettingsStatus();
  }
});
$('#record-shortcut').addEventListener('click', () => { if (usesSystemShortcut()) return; if (recording) { stopRecording(); return; } recording = true; $('#record-shortcut').textContent = '記録をやめる'; $('#record-shortcut').classList.add('recording'); $('#shortcut-help').textContent = 'Ctrl / ⌘ / Alt と一緒に、使いたいキーを押してください。Escで中止。'; });
$('#fan-spread').addEventListener('input', updateFanDraft);
$('#fan-distance').addEventListener('input', updateFanDraft);
$('#history-limit').addEventListener('change', updateHistoryWarning);
$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault(); stopRecording(); updateHistoryWarning();
  if (!$('#history-reduction-warning').hidden && !$<HTMLInputElement>('#confirm-history-reduction').checked) { $<HTMLInputElement>('#confirm-history-reduction').focus(); return; }
  const save = $<HTMLButtonElement>('#save-settings'); const error = $('#settings-error'); save.disabled = true; error.hidden = true;
  try {
    const result = await bridge.updateSettings({ ...(!usesSystemShortcut() ? { shortcut: $<HTMLInputElement>('#shortcut-input').value.trim() } : {}), historyLimit: Number($<HTMLSelectElement>('#history-limit').value), persistence: $<HTMLInputElement>('#persistence').checked, sourceApp: $<HTMLInputElement>('#source-app').checked, fanSpread: Number($<HTMLInputElement>('#fan-spread').value), fanDistance: Number($<HTMLInputElement>('#fan-distance').value), ...(!$('#history-reduction-warning').hidden && $<HTMLInputElement>('#confirm-history-reduction').checked ? { confirmHistoryReduction: true } : {}) });
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
  if (copying) { event.preventDefault(); return; }
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
function scheduleFanLayout() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderCards(), 80); }
window.addEventListener('resize', scheduleFanLayout);
// Work-area changes and webview relayouts can update the drawable stage without
// a distinct window resize event. Re-measure only when its dimensions change.
const viewportObserver = new ResizeObserver(() => {
  const next = measureFanViewport();
  if (!state || (next.width === renderedViewport.width && next.height === renderedViewport.height)) return;
  scheduleFanLayout();
});
viewportObserver.observe(stage);
const applyState = createStateReceiver((next) => { state = next; render(); });
const unsubscribeState = bridge.onState(applyState);
const unsubscribeShown = bridge.onShown(resetForShown);
const unsubscribeSettings = bridge.onSettings?.(() => { cancelCopyFeedback(); openSettings(); }) ?? (() => {});
window.addEventListener('pagehide', () => { viewportObserver.disconnect(); cancelCopyFeedback(); unsubscribeState(); unsubscribeShown(); unsubscribeSettings(); clearTimeout(toastTimer); clearTimeout(copiedTimer); clearTimeout(previewTimer); clearTimeout(resizeTimer); }, { once: true });
void bridge.getState().then((next) => { applyState(next); stage.focus({ preventScroll: true }); }).catch(() => {
  $('#empty-state').hidden = false; $('#empty-label').textContent = '履歴を読み込めませんでした'; showToast('Pupaを再起動してください。', true);
});
