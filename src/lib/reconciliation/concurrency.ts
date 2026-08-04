/**
 * One definition of "do these N things a few at a time, in order".
 *
 * Two places in this module need it — the runner fanning checks out, and the deductions checks
 * fanning one service call out per employee — and a second copy of the worker loop is exactly the
 * duplication this harness exists to catch elsewhere. Results are placed BY INDEX, never pushed, so
 * the caller's order survives however the workers interleave.
 */
export async function mapWithConcurrency<In, Out>(
  items: readonly In[],
  concurrency: number,
  run: (item: In, index: number) => Promise<Out>,
): Promise<Out[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<Out>(items.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}
