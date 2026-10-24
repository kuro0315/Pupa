import type { PupaBridge, State } from './types';

/** An explicitly labeled, local UI preview. Never used inside the desktop app. */
export function createPreviewBridge(): PupaBridge {
  const now = Date.now();
  let state: State = {
    entries: [
      { id: 'demo-note', source: { name: 'Memo Lab（デモ）', kind: 'foreground' }, kind: 'text', color: 'butter', pinned: true, createdAt: now - 120000, text: '小さなひらめきを、逃さない。\n今日の「いいな」を、明日のアイデアに。' },
      { id: 'demo-link', source: { name: 'Orbit Browser（デモ）', kind: 'foreground' }, kind: 'link', color: 'mint', pinned: false, createdAt: now - 360000, text: 'https://github.com/kuro0315/Pupa' },
      { id: 'demo-code', source: { name: 'Pixel Editor（デモ）', kind: 'foreground' }, kind: 'code', color: 'lavender', pinned: false, createdAt: now - 720000, text: "const littleThings = ['ひらめき', 'ことば', '好き'];\n\nconst collect = (idea) => littleThings.push(idea);" },
      { id: 'demo-text', source: { name: 'Memo Lab（デモ）', kind: 'foreground' }, kind: 'text', color: 'rose', pinned: false, createdAt: now - 1440000, text: '週末の小さなリスト\n・いつものカフェで、ゆっくり\n・読みかけの本を一章\n・春色の花を一輪' },
      { id: 'demo-thought', kind: 'text', color: 'butter', pinned: false, createdAt: now - 3600000, text: 'つくることは、よく見ること。\n何気ない毎日のなかに、ヒントはたくさん。' },
    ],
    settings: { shortcut: 'CommandOrControl+Shift+Space', historyLimit: 60, persistence: false, hideAfterCopy: true, sourceApp: true, fanSpread: 72, fanDistance: 0 },
    paused: false,
    status: { shortcutRegistered: true, storageWarning: null, platform: /Mac/.test(navigator.platform) ? 'darwin' : 'linux', wayland: false, version: '0.2.0' },
  };
  const listeners = new Set<(next: State) => void>();
  const emit = () => { state = structuredClone(state); for (const fn of listeners) fn(state); return { ok: true }; };
  return {
    getState: async () => structuredClone(state),
    // Preview intentionally does not claim to access the system clipboard.
    copyEntry: async (id) => ({ ok: state.entries.some((entry) => entry.id === id) }),
    deleteEntry: async (id) => { state.entries = state.entries.filter((entry) => entry.id !== id); return emit(); },
    togglePin: async (id) => { const entry = state.entries.find((item) => item.id === id); if (entry) entry.pinned = !entry.pinned; return emit(); },
    clearHistory: async () => { state.entries = []; return emit(); },
    setPaused: async (paused) => { state.paused = paused; return emit(); },
    updateSettings: async ({ confirmHistoryReduction: _confirmation, ...settings }) => { state.settings = { ...state.settings, ...settings }; return emit(); },
    hide: () => {},
    quit: () => {},
    onState: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    onShown: () => () => {},
    onSettings: () => () => {},
  };
}
