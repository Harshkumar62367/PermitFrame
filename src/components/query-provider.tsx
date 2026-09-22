"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, dehydrate, hydrate, type DehydratedState } from "@tanstack/react-query";
import { WORKSPACE_SNAPSHOT_KEY } from "@/lib/use-workspace-snapshot";

let browserQueryClient: QueryClient | undefined;

/**
 * Single shared QueryClient. The browser reuses one module-level instance
 * across renders and navigations (so the workspace cache survives route
 * changes); server renders get an isolated client per render.
 * Follows the Next.js App Router TanStack Query guide.
 */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return new QueryClient();
  browserQueryClient ??= new QueryClient();
  return browserQueryClient;
}

/* ---------------- workspace snapshot persistence ---------------- */

// Bump the buster (and storage key suffix) whenever the snapshot shape changes.
const SNAPSHOT_BUSTER = "workspace-snapshot-v1";
const SNAPSHOT_STORAGE_KEY = "permitframe:workspace-snapshot:v1";
// Records which workspace owns the persisted bytes. Restore is refused on
// mismatch, so a new signed-in user can never render a previous user's cache.
const SNAPSHOT_OWNER_KEY = "permitframe:workspace-snapshot-owner:v1";
// Matches the query gcTime: persisted rows expire with the memory cache.
const SNAPSHOT_MAX_AGE_MS = 20 * 60_000;
// Coalesces write bursts from rapid cache transitions into one write/second.
const SNAPSHOT_WRITE_THROTTLE_MS = 1000;

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

interface PersistedSnapshot {
  buster: string;
  timestamp: number;
  clientState: DehydratedState;
}

function readPersisted(): PersistedSnapshot | undefined {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PersistedSnapshot>;
    if (parsed?.buster !== SNAPSHOT_BUSTER) return undefined;
    if (typeof parsed?.timestamp !== "number" || Date.now() - parsed.timestamp > SNAPSHOT_MAX_AGE_MS) return undefined;
    if (!parsed?.clientState || typeof parsed.clientState !== "object") return undefined;
    return parsed as PersistedSnapshot;
  } catch {
    return undefined;
  }
}

let lastPersistAt = 0;

function writePersisted(client: QueryClient): void {
  // Only persist meaningful states: an in-flight fetch with no data yet must
  // never shadow the last good bytes on disk (the 1s throttle could otherwise
  // drop the success write that follows milliseconds later).
  if (client.getQueryData(WORKSPACE_SNAPSHOT_KEY) === undefined) return;
  const now = Date.now();
  if (now - lastPersistAt < SNAPSHOT_WRITE_THROTTLE_MS) return;
  lastPersistAt = now;
  try {
    const payload: PersistedSnapshot = {
      buster: SNAPSHOT_BUSTER,
      timestamp: now,
      clientState: dehydrate(client, {
        shouldDehydrateQuery: (query) => query.queryKey[0] === WORKSPACE_SNAPSHOT_KEY[0]
      })
    };
    window.localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // quota / private mode - memory cache is unaffected
  }
}

function removePersisted(): void {
  try {
    window.localStorage.removeItem(SNAPSHOT_STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    window.localStorage.removeItem(SNAPSHOT_OWNER_KEY);
  } catch {
    // ignore
  }
}

function readOwner(): string | null {
  try {
    return window.localStorage.getItem(SNAPSHOT_OWNER_KEY);
  } catch {
    return null;
  }
}

function writeOwner(workspaceName: string): void {
  try {
    window.localStorage.setItem(SNAPSHOT_OWNER_KEY, workspaceName);
  } catch {
    // private mode etc. - memory cache still works, persistence just skips
  }
}

/**
 * Totally drop the persisted snapshot (disk + memory). Call on sign-out and
 * whenever the session resolves to signed-out.
 */
export function purgePersistedWorkspaceSnapshot(client?: QueryClient): void {
  if (!storageAvailable()) return;
  removePersisted();
  (client ?? getQueryClient()).clear();
}

/**
 * Owner-gated restore, called once the server session proves which workspace
 * is signed in. When the persisted bytes belong to that same workspace they
 * are hydrated (fresh rows render instantly with no fetch; stale rows render
 * instantly and background-refetch). On any mismatch - or a blank/unknown
 * owner - the previous owner's bytes are purged and the caller cold-fetches.
 * Returns true when cached rows were restored.
 */
export function establishSnapshotOwner(client: QueryClient, workspaceName: string): boolean {
  if (!storageAvailable()) return false;
  if (!workspaceName) {
    purgePersistedWorkspaceSnapshot(client);
    return false;
  }
  if (readOwner() !== workspaceName) {
    // Different (or unknown) owner: previous bytes must never render here.
    removePersisted();
    client.clear();
  }
  writeOwner(workspaceName);
  const persisted = readPersisted();
  if (!persisted) return false;
  try {
    hydrate(client, persisted.clientState);
  } catch {
    return false;
  }
  return client.getQueryData(WORKSPACE_SNAPSHOT_KEY) !== undefined;
}

/** Application provider boundary for TanStack Query. Never recreated per render. */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());

  useEffect(() => {
    // Persist only the workspace snapshot (never health checks or other
    // queries). Restore is deliberately NOT done here - it happens in
    // establishSnapshotOwner after the session proves the workspace owner.
    if (!storageAvailable()) return;
    return queryClient.getQueryCache().subscribe(() => {
      writePersisted(queryClient);
    });
  }, [queryClient]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
