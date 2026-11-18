/**
 * A cap on how many runs of ONE kind of work may be in flight at once, shared by every caller in
 * the process.
 *
 * `asyncPool` bounds the fan-out of ONE call. It cannot see the call next to it: ten requests that
 * each pool four reads still put forty reads on the database together. This is the other half —
 * create ONE limit at module scope and every request, every page and every caller that goes through
 * it shares the same slots. A run past the cap waits in this process (first come, first served)
 * instead of queueing for a database connection, where the wait would starve every other query —
 * the sign-in bundle included — of the same small pool.
 *
 * A slot is released the moment its run settles, resolved OR rejected, and a run that throws
 * synchronously becomes a rejection of its own promise rather than escaping to the caller — so a
 * failing run can never leak a slot and shrink the cap for the rest of the process's life.
 *
 * Never call the limited function from inside a run of the same limit: a run that waits for a slot
 * of its own limit can deadlock once every slot is held by such a run.
 */
export function createConcurrencyLimit(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`createConcurrencyLimit needs a whole number of at least 1, got ${String(max)}`);
  }
  let active = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    const next = waiting.shift();
    // Hand the slot straight to the next waiter: `active` stays the same, so a caller arriving in
    // between can never take the slot out from under the queue.
    if (next) next();
    else active -= 1;
  };

  return <T>(run: () => Promise<T>): Promise<T> => {
    const start = (): Promise<T> => new Promise<T>((resolve) => resolve(run())).finally(release);
    if (active < max) {
      active += 1;
      return start();
    }
    return new Promise<void>((resolve) => {
      waiting.push(resolve);
    }).then(start);
  };
}
