import { isDevelopment as isDev } from "@/lib/env";

/**
 * Runs `iteratee` over every item in `items` with at most `concurrency` promises
 * in-flight at once. Resolves with results in the same order as `items`.
 *
 * In development mode, concurrency is clamped to 1 to avoid overwhelming
 * Turbopack's Jest worker pool with parallel server-side fetches.
 */
export async function asyncPool<T, R>(
  concurrency: number,
  items: readonly T[],
  iteratee: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (isDev) concurrency = 1;
  const results: R[] = new Array(items.length);
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < items.length; i++) {
    const idx = i;
    const p = iteratee(items[idx], idx).then((r) => {
      results[idx] = r;
    });
    const wrapped = p.then(() => {
      executing.delete(wrapped);
    });
    executing.add(wrapped);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}
