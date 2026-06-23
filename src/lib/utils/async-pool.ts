/**
 * Runs `iteratee` over every item in `items` with at most `concurrency` promises
 * in-flight at once. Resolves with results in the same order as `items`.
 */
export async function asyncPool<T, R>(
  concurrency: number,
  items: readonly T[],
  iteratee: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
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
