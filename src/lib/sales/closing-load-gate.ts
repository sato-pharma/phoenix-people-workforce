// The gate every Monthly Closing load passes through.
//
// 19 Oct 2026, 15:18:50 Cairo: about twenty closing loads started inside the same ten seconds, each
// one three heavy RPCs plus a dozen reads. The database's own time went from 0.15 s to 8.7 s at the
// median, and every other request the app made (heartbeats, pages, crons) waited behind them and
// hit the 15 second limit together. The load fell to 3 RPCs a minute and the median recovered to
// 0.28 s; it came back at 124 and the median went to 7.3 s again.
//
// Two things stop a repeat, and neither changes a number:
//   - at most `maxConcurrent` loads run at once in this process; the rest wait their turn;
//   - the same line and month asked for while it is already loading shares that one load, and a
//     caller that opts in may reuse a read that settled a few seconds ago.
// Everyone gets a COPY of the result, so one caller changing its matrix can never reach another.

export type ClosingLoadKey = { line?: string | null; period?: string | null };

type Settled<T> = { at: number; value: T };

export type ClosingLoadGate<T> = {
  /** `reuseMs` > 0 lets this caller take a read that settled that recently; 0 or absent never does. */
  load: (input?: ClosingLoadKey, options?: { reuseMs?: number }) => Promise<T>;
  /** Loads running or waiting right now, for tests and logs. */
  pending: () => number;
};

const MAX_SETTLED = 24;

function keyOf(input?: ClosingLoadKey): string {
  return `${String(input?.line ?? "").trim()}|${String(input?.period ?? "").trim()}`;
}

export function createClosingLoadGate<T>(config: {
  clone?: (value: T) => T;
  load: (input?: ClosingLoadKey) => Promise<T>;
  maxConcurrent: number;
  now?: () => number;
}): ClosingLoadGate<T> {
  const now = config.now ?? Date.now;
  const clone = config.clone ?? ((value: T) => structuredClone(value));
  const maxConcurrent = Math.max(1, Math.floor(config.maxConcurrent));
  const inFlight = new Map<string, Promise<T>>();
  const settled = new Map<string, Settled<T>>();
  const waiting: Array<() => void> = [];
  let running = 0;

  async function takeSlot(): Promise<void> {
    if (running < maxConcurrent) {
      running += 1;
      return;
    }
    // The slot is handed over still counted, so a newcomer can never slip in between.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }

  function giveSlot(): void {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }

  async function run(input: ClosingLoadKey | undefined): Promise<T> {
    await takeSlot();
    try {
      return await config.load(input);
    } finally {
      giveSlot();
    }
  }

  function remember(key: string, value: T): void {
    settled.delete(key);
    settled.set(key, { at: now(), value });
    while (settled.size > MAX_SETTLED) {
      const oldest = settled.keys().next().value;
      if (oldest === undefined) break;
      settled.delete(oldest);
    }
  }

  return {
    pending: () => running + waiting.length,
    async load(input, options) {
      const key = keyOf(input);
      const reuseMs = options?.reuseMs ?? 0;
      if (reuseMs > 0) {
        const hit = settled.get(key);
        if (hit && now() - hit.at <= reuseMs) return clone(hit.value);
      }
      let flight = inFlight.get(key);
      if (!flight) {
        flight = run(input).then(
          (value) => {
            inFlight.delete(key);
            remember(key, value);
            return value;
          },
          (error) => {
            // A failed read is never kept: the next caller asks the database again.
            inFlight.delete(key);
            throw error;
          },
        );
        inFlight.set(key, flight);
      }
      return clone(await flight);
    },
  };
}

/** How many closing loads one web process runs at once (CLOSING_LOAD_CONCURRENCY overrides it). */
export function closingLoadConcurrency(): number {
  const raw = Number(process.env.CLOSING_LOAD_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 4;
}

/** How long the screens may reuse a settled read. Exports, publishing and the checks never do. */
export const CLOSING_SCREEN_REUSE_MS = 10_000;
