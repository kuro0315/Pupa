import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CopyResult, PupaBridge, Result, State } from './types';

export const isTauriRuntime = () => isTauri();

/** Only domain commands and state events cross the native boundary. The renderer
 * has no clipboard, filesystem, shell, HTTP, or shortcut plugin permissions. */
export function createTauriBridge(): PupaBridge {
  const subscriptions: Promise<void>[] = [];
  const subscribe = <T>(event: string, callback: (payload: T) => void) => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    const ready = listen<T>(event, ({ payload }) => { if (!disposed) callback(payload); })
      .then((stop) => { if (disposed) stop(); else unlisten = stop; });
    // getState waits for listeners before taking the first snapshot, so a native
    // update cannot disappear between initial state and event registration.
    subscriptions.push(ready);
    // Keep an early registration rejection handled until getState reports it.
    void ready.catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  };
  const fire = (command: 'hide' | 'quit') => {
    void invoke(command).catch((error: unknown) => console.error(`Pupa ${command} failed`, error));
  };
  return Object.freeze({
    getState: async () => { await Promise.all(subscriptions); return invoke<State>('get_state'); },
    requestSystemShortcut: () => invoke<Result>('request_system_shortcut'),
    copyEntry: (id: string) => invoke<CopyResult>('copy_entry', { id }),
    completeCopyDismissal: (token: string) => invoke<Result>('complete_copy_dismissal', { token }),
    deleteEntry: (id: string) => invoke<Result>('delete_entry', { id }),
    togglePin: (id: string) => invoke<Result>('toggle_pin', { id }),
    clearHistory: () => invoke<Result>('clear_history'),
    setPaused: (paused: boolean) => invoke<Result>('set_paused', { paused }),
    updateSettings: (patch: Parameters<PupaBridge['updateSettings']>[0]) => invoke<Result>('update_settings', { patch }),
    hide: () => fire('hide'),
    quit: () => fire('quit'),
    onState: (callback: (state: State) => void) => subscribe('pupa-state', callback),
    onShown: (callback: () => void) => subscribe('pupa-shown', callback),
    onSettings: (callback: () => void) => subscribe('pupa-open-settings', callback),
  });
}
