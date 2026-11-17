/**
 * Phoenix CRM — the read the page makes on its own when a phone wakes up.
 *
 * 🔴 WHY THIS EXISTS (System Audit, 17 Nov 2026): `GET /api/phoenix-crm/overview` getting no answer was the
 * largest single failed-request class on production's board — 223 screenshots from 62 reps since 24 Oct, 168
 * of them on Visits and 41 on the List, still 13–14 reps a day on 14–16 Nov. The page read the overview THE
 * MOMENT it came back into sight after a minute away; a phone that is waking has no network yet, so the fetch
 * rejected and the rep met "The page could not read the latest territories and counts" over a screen that
 * was perfectly fine — for a read he never asked for.
 *
 * So a WAKE-UP read (never one the rep asked for):
 *   1. waits a moment for the network: always `settleMs`, then, if the browser says it is offline, until the
 *      `online` event or `capMs`, whichever comes first;
 *   2. reads; a dropped connection (and only that) is retried ONCE, after another wait;
 *   3. a read that still fails is QUIET while an overview is on screen — the counts already shown stay, and
 *      the next return to the page reads again.
 *
 * A read the rep asked for (Try again, Check again, a tab's own save) is NOT this path: it reports its failure
 * exactly as before. Pure — the page hands in the browser; tests hand in fakes.
 */

/** Always waited before the wake-up read: the radio is still coming back when the screen turns on. */
export const WAKE_SETTLE_MS = 1_500;
/** Waited at most for the `online` event when the browser says it is offline. */
export const WAKE_ONLINE_WAIT_MS = 8_000;
/** Waited before the one retry of a read the connection stopped. */
export const WAKE_RETRY_SETTLE_MS = 3_000;

/** What `waitForNetwork` needs from the browser. Each subscription returns its own undo. */
export type WakeNetwork = {
  isOnline: () => boolean;
  onOnline: (listener: () => void) => () => void;
  setTimer: (callback: () => void, ms: number) => () => void;
};

/**
 * Resolves once the network has had its chance: after `settleMs`, then at once if the browser says it is
 * online, else on the `online` event or `capMs` later — whichever comes first. Never rejects. `cancelled`
 * ends the wait early (the page went out of sight again, or a newer read started), so nothing is left
 * listening.
 */
export function waitForNetwork(
  network: WakeNetwork,
  settleMs: number,
  capMs: number,
  cancelled: () => boolean = () => false,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const undo: Array<() => void> = [];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const step of undo) step();
      resolve();
    };
    undo.push(
      network.setTimer(() => {
        if (cancelled() || network.isOnline()) {
          finish();
          return;
        }
        undo.push(network.onOnline(finish));
        undo.push(network.setTimer(finish, capMs));
      }, settleMs),
    );
  });
}

export type WakeReadOutcome<T> =
  | { kind: "landed"; value: T }
  /** The read failed after its retry (or was refused): nothing changes on screen. */
  | { kind: "quiet"; error: unknown }
  /** A newer read started, or the page went out of sight: this one's answer is not wanted. */
  | { kind: "superseded" };

/**
 * One wake-up read: wait, read, and on a dropped connection wait again and read ONCE more. A refusal is never
 * retried (`retryable` is `isRetryableFailure`: it answers the same however often it is asked). It never
 * throws and never reports — the page decides what a `quiet` outcome shows.
 */
export async function runWakeRead<T>(input: {
  read: () => Promise<T>;
  wait: (attempt: 0 | 1) => Promise<void>;
  retryable: (error: unknown) => boolean;
  /** False once a newer read started or the page went out of sight. */
  current: () => boolean;
}): Promise<WakeReadOutcome<T>> {
  let lastError: unknown = null;
  for (const attempt of [0, 1] as const) {
    await input.wait(attempt);
    if (!input.current()) return { kind: "superseded" };
    try {
      const value = await input.read();
      return input.current() ? { kind: "landed", value } : { kind: "superseded" };
    } catch (error) {
      if (!input.current()) return { kind: "superseded" };
      lastError = error;
      if (!input.retryable(error)) break;
    }
  }
  return { kind: "quiet", error: lastError };
}

