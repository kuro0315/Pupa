export type EntryKind = 'text' | 'link' | 'code';
export type EntryColor = 'mint' | 'rose' | 'lavender' | 'butter';
export interface ClipboardEntry {
  id: string;
  text: string;
  kind: EntryKind;
  color: EntryColor;
  createdAt: number;
  pinned: boolean;
}
export interface Settings {
  shortcut: string;
  historyLimit: number;
  persistence: boolean;
  hideAfterCopy: boolean;
}
export interface State {
  entries: ClipboardEntry[];
  settings: Settings;
  paused: boolean;
  status: {
    shortcutRegistered: boolean;
    storageWarning: string | null;
    platform: string;
    wayland: boolean;
    version: string;
  };
}
export interface Result { ok: boolean; error?: string }
export interface PupaBridge {
  getState(): Promise<State>;
  copyEntry(id: string): Promise<Result>;
  deleteEntry(id: string): Promise<Result>;
  togglePin(id: string): Promise<Result>;
  clearHistory(): Promise<Result>;
  setPaused(paused: boolean): Promise<Result>;
  updateSettings(settings: Partial<Settings>): Promise<Result>;
  hide(): void;
  quit(): void;
  onState(callback: (state: State) => void): () => void;
  onShown(callback: () => void): () => void;
  onSettings?(callback: () => void): () => void;
}
declare global { interface Window { pupa?: PupaBridge } }
