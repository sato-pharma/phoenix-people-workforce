/**
 * Hand a degraded answer to the viewer WITHOUT letting a cache keep it.
 *
 * WHY (2026-10-26 cache audit, P3). Several cached reads swallow a failed source and return a
 * "no data" shape on purpose — the page then says the source is missing instead of crashing. That
 * is right for the ONE render that hit the failure, and wrong for every render after it: the cache
 * kept the empty shape for its whole lifetime (two hours on the retention-risk board), so a
 * database blip that lasted a second read as "no data" until the entry expired.
 *
 * `unstable_cache` stores only what its callback RETURNS. A callback that throws stores nothing —
 * on a miss the error reaches the caller; on a stale entry's background refresh Next logs it and
 * keeps the older good copy. So the callback throws the degraded answer instead of returning it,
 * and the caller, OUTSIDE the cache, catches it and serves it:
 *
 *     const cached = unstable_cache(async () => {
 *       const view = await build();
 *       if (view.sourceFailed) serveWithoutCaching(view, "the CRM read failed");
 *       return view;
 *     }, [...]);
 *     export const read = () => unwrapServedWithoutCaching(cached());
 *
 * The next request tries the read again. A healthy answer is cached exactly as before.
 */

const SERVED_WITHOUT_CACHING = Symbol.for("phoenix.cache.served-without-caching");

type ServedWithoutCaching = Error & { [SERVED_WITHOUT_CACHING]: true; value: unknown };

/** Throw `value` out of a cache callback so the cache stores nothing. Always throws. */
export function serveWithoutCaching(value: unknown, reason: string): never {
  const error = new Error(`Served without caching: ${reason}`) as ServedWithoutCaching;
  error.name = "ServedWithoutCaching";
  error[SERVED_WITHOUT_CACHING] = true;
  error.value = value;
  throw error;
}

/** The value `serveWithoutCaching` carried, or null when `error` is any other failure. */
export function servedWithoutCachingValue<T>(error: unknown): { value: T } | null {
  if (typeof error !== "object" || error === null) return null;
  if ((error as Partial<ServedWithoutCaching>)[SERVED_WITHOUT_CACHING] !== true) return null;
  return { value: (error as ServedWithoutCaching).value as T };
}

/** Await a cached read; a degraded answer thrown out of its callback is returned, not raised. */
export async function unwrapServedWithoutCaching<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    const served = servedWithoutCachingValue<T>(error);
    if (served) return served.value;
    throw error;
  }
}

const degraded = new WeakSet<object>();

/**
 * Mark an answer as built from a source that failed, so a cache further up never keeps it. For a
 * loader that must keep returning its "no data" shape to its own callers, and cannot throw.
 */
export function markDegraded<T extends object>(value: T): T {
  degraded.add(value);
  return value;
}

export function isDegraded(value: unknown): boolean {
  return typeof value === "object" && value !== null && degraded.has(value);
}
