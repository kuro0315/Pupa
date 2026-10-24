export type EntryKind = 'text' | 'link' | 'code';
export type EntryColor = 'mint' | 'rose' | 'lavender' | 'butter';
export interface EntrySource {
  name: string;
  icon?: string;
  kind: 'foreground';
}
export interface ClipboardEntry {
  id: string;
  text: string;
  kind: EntryKind;
  color: EntryColor;
  createdAt: number;
  pinned: boolean;
  source?: EntrySource;
}
export interface Settings {
  shortcut: string;
  historyLimit: number;
  persistence: boolean;
  hideAfterCopy: boolean;
  sourceApp?: boolean;
  fanSpread?: number;
  fanDistance?: number;
}
export interface State {
  /** Native snapshot sequence; optional only for browser previews and fixtures. */
  revision?: number;
  entries: ClipboardEntry[];
  settings: Settings;
  paused: boolean;
  status: {
    shortcutRegistered: boolean;
    shortcutAvailable?: boolean;
    storageWarning: string | null;
    positionWarning?: string | null;
    platform: string;
    wayland: boolean;
    version: string;
  };
}
export interface Result { ok: boolean; error?: string }
export interface CopyResult extends Result { dismissToken?: string }
export interface PupaBridge {
  getState(): Promise<State>;
  copyEntry(id: string): Promise<CopyResult>;
  completeCopyDismissal(token: string): Promise<Result>;
  deleteEntry(id: string): Promise<Result>;
  togglePin(id: string): Promise<Result>;
  clearHistory(): Promise<Result>;
  setPaused(paused: boolean): Promise<Result>;
  updateSettings(settings: Partial<Settings> & { confirmHistoryReduction?: boolean }): Promise<Result>;
  hide(): void;
  quit(): void;
  onState(callback: (state: State) => void): () => void;
  onShown(callback: () => void): () => void;
  onSettings?(callback: () => void): () => void;
}
declare global { interface Window { pupa?: PupaBridge } }
