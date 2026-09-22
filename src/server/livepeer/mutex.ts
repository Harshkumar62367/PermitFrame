/**
 * In-process async mutexes keyed by resource id. The workspace state is a
 * single Neon-backed JSON blob read-modify-written per update: concurrent
 * pump workers must serialize their writes or lose each other's updates.
 * (Single always-on container per render.yaml - no cross-process lock
 * needed, and every write path re-reads before mutating.)
 */

const locks = new Map<string, { tail: Promise<void>; holders: number }>();

/** Serialize async work under one key within this server instance. */
export async function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const entry = locks.get(key) ?? { tail: Promise.resolve(), holders: 0 };
  entry.holders += 1;
  const previous = entry.tail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  entry.tail = previous.then(() => current);
  locks.set(key, entry);
  await previous;
  try {
    return await work();
  } finally {
    release();
    entry.holders -= 1;
    if (entry.holders <= 0) locks.delete(key);
  }
}

/** Serialize all state writes for one campaign. */
export function withCampaignLock<T>(campaignId: string, work: () => Promise<T>): Promise<T> {
  return withLock(`campaign:${campaignId}`, work);
}
