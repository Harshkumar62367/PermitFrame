import type { Database } from "../types";
import { loadWorkspaceDb, updateWorkspaceDb } from "../store";

/**
 * Workspace state access seam for the async runner. Production behavior is
 * the Neon-backed workspace blob (with normalized mirroring); tests swap in
 * an in-memory implementation so pumpRun executes end-to-end with mocked
 * fetch and zero network. Only the pump path reads through here - the
 * request-scoped session paths keep their own access.
 */

export interface RunStore {
  loadWorkspace(workspaceId: string): Promise<Database>;
  writeWorkspace(workspaceId: string, mutator: (db: Database) => void, options?: { mirror?: boolean }): Promise<void>;
}

const liveStore: RunStore = {
  loadWorkspace: (workspaceId: string) => loadWorkspaceDb(workspaceId),
  writeWorkspace: (workspaceId: string, mutator: (db: Database) => void, options?: { mirror?: boolean }) =>
    updateWorkspaceDb(workspaceId, mutator, options).then(() => undefined)
};

let active: RunStore = liveStore;

/** Test seam: swap workspace I/O. Pass null/undefined to restore live. */
export function setRunStore(store: RunStore | null | undefined): void {
  active = store ?? liveStore;
}

export function readWorkspace(workspaceId: string): Promise<Database> {
  return active.loadWorkspace(workspaceId);
}

export function writeWorkspace(workspaceId: string, mutator: (db: Database) => void, options?: { mirror?: boolean }): Promise<void> {
  return active.writeWorkspace(workspaceId, mutator, options);
}

/** In-memory store for tests. Returns the handle plus a reader for assertions. */
export function memoryStore(seed: Database): { store: RunStore; read: () => Database } {
  let current: Database = seed;
  return {
    store: {
      loadWorkspace: async () => structuredClone(current),
      writeWorkspace: async (_id: string, mutator: (db: Database) => void) => {
        const next = structuredClone(current);
        mutator(next);
        current = next;
      }
    },
    read: () => current
  };
}
