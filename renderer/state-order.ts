import type { State } from './types';

/** Native snapshots can finish crossing IPC in a different order than they were
 * captured. Share one revision gate between events and the initial snapshot so
 * stale responses cannot restore deleted entries or undo newer settings. */
export function createStateReceiver(apply: (state: State) => void): (state: State) => boolean {
  let latestRevision: number | undefined;
  return (next) => {
    const revision = next.revision;
    if (revision === undefined) {
      // Browser previews and pre-existing injected fixtures are unversioned.
      // Once native state is seen, never let an unversioned update replace it.
      if (latestRevision !== undefined) return false;
    } else {
      if (!Number.isSafeInteger(revision) || revision < 0) return false;
      if (latestRevision !== undefined && revision < latestRevision) return false;
      latestRevision = revision;
    }
    apply(next);
    return true;
  };
}
