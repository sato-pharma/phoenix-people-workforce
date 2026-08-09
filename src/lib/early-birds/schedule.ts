// When does a fortnight close, and when does an unanswered recommendation decide itself?
//
// Pure. The DUE-CHECK HAS NO IN-MEMORY DEPENDENCY FOR CORRECTNESS — the marker is the database (the
// set of period keys that already have a live snapshot), not a `lastRunMs` field. A process down
// for a week comes back, enumerates the recent periods, finds the unsnapshotted ones and closes
// them. That is deliberately different from the CRM poller's scheduled-work markers, which need
// re-seeding after a deploy; a fortnightly job that forgets across a restart would just never run.

import { addDaysIso } from "@/lib/crm/dates";
import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";
import { isEarlyBirdsPeriodClosed, listRecentEarlyBirdsPeriods } from "@/lib/early-birds/period";

/** Let the overnight poller ticks and the 06:00 rolling sync land late-saved visits first. */
export const EARLY_BIRDS_CLOSE_EARLIEST_CAIRO_MINUTES = 3 * 60;

/** How far back a cold start will heal. Older gaps stay gaps — see the note below. */
export const EARLY_BIRDS_BACKFILL_PERIODS = 4;

/**
 * The first fortnight this module is allowed to award. Nothing older is ever closed.
 *
 * The lookback window alone is not a floor. It is relative to today, so it keeps sliding backwards
 * over fortnights that existed before the module did — and every one of them looks like an
 * unfilled gap the scheduler is supposed to heal. Measured on 2026-08-09 the sweep was one tick
 * away from closing 2026-06-H1, 2026-06-H2 and the rest of 2026-07-H1: 46 districts, 46
 * recommendation emails to managers about work up to ten weeks old, and 46 automatic crowns five
 * days later.
 *
 * A fortnight nobody was watching at the time cannot be awarded honestly after the fact — the CRM
 * mirror behind it has been reconciled since, so the ranking would not be the one the manager would
 * have seen. Leaving a hole is the correct outcome.
 *
 * 2026-08-H1 is the first fortnight that closes with the module live and the poller running.
 */
export const EARLY_BIRDS_EARLIEST_PERIOD_KEY = "2026-08-H1";

/** Spread a cold start over ticks instead of blocking the CRM probe for minutes. */
export const EARLY_BIRDS_CLOSE_MAX_PER_TICK = 5;

/** Days after a period closes before rank #1 is crowned without the manager. */
export const EARLY_BIRDS_AUTO_APPROVE_AFTER_DAYS = 5;

/** The database is asked at most this often; losing this on restart costs one extra query. */
export const EARLY_BIRDS_DUE_CHECK_MIN_GAP_MS = 15 * 60 * 1000;

/**
 * Periods that should be closed now, newest first.
 *
 * The 03:00 gate applies only on the FIRST day after a period ends — that is the tick where the
 * final day's late saves are still arriving. A period that closed a week ago is already settled and
 * waiting for 03:00 would just delay a backfill by up to a day for no benefit.
 *
 * Backfill is bounded on purpose. A snapshot computed today from a mirror that has since been
 * reconciled is not the fact the manager would have seen at the time, and silently minting a
 * five-month-old winner nobody was ever asked about is worse than leaving a hole.
 */
export function resolveDueEarlyBirdsPeriods(input: {
  todayIso: string;
  minutesSinceMidnight: number;
  snapshottedPeriodKeys: ReadonlySet<string>;
  lookbackPeriods?: number;
  /** Overridable only so the test can pin the rule without rewriting history every August. */
  earliestPeriodKey?: string;
}): EarlyBirdsPeriod[] {
  const lookback = input.lookbackPeriods ?? EARLY_BIRDS_BACKFILL_PERIODS;
  const earliest = input.earliestPeriodKey ?? EARLY_BIRDS_EARLIEST_PERIOD_KEY;
  const due: EarlyBirdsPeriod[] = [];

  for (const period of listRecentEarlyBirdsPeriods(input.todayIso, lookback + 1)) {
    if (!isEarlyBirdsPeriodClosed(period, input.todayIso)) continue;
    if (input.snapshottedPeriodKeys.has(period.periodKey)) continue;
    // Fixed-width YYYY-MM-Hn sorts lexicographically in true chronological order, so a string
    // compare IS the date compare here. Pinned by a test, because that stops being true the moment
    // the key format changes.
    if (period.periodKey < earliest) continue;

    const isFirstDayAfterClose = input.todayIso === addDaysIso(period.endIso, 1);
    if (isFirstDayAfterClose && input.minutesSinceMidnight < EARLY_BIRDS_CLOSE_EARLIEST_CAIRO_MINUTES) {
      continue;
    }

    due.push(period);
    if (due.length >= lookback) break;
  }

  return due;
}

/**
 * The day rank #1 is crowned automatically if the manager still has not decided.
 *
 * Measured from when the recommendation was COMPUTED — the day the manager was actually asked — not
 * from the day the fortnight ended. For a normally-closed period those are the same day. For a
 * BACKFILLED period they are not, and the difference is severe: a fortnight that closed nine days
 * ago is already past a period-end deadline the instant it is created, so every district
 * auto-crowned in the same tick that created it and no manager was ever asked. That happened in
 * production on 2026-08-09 for 2026-07-H2, and it is irreversible by design —
 * phx_close_early_birds_period refuses a recompute once a winner exists.
 */
export function earlyBirdsAutoApproveDueAtIso(computedAtIso: string): string {
  return addDaysIso(String(computedAtIso).slice(0, 10), EARLY_BIRDS_AUTO_APPROVE_AFTER_DAYS);
}

/**
 * The rep is never punished for his manager's inaction, and the award always lands while it still
 * feels current — but only once that manager has genuinely had the window. He is told it happened
 * rather than it being silent.
 */
export function isEarlyBirdsAutoApproveDue(input: { computedAtIso: string; todayIso: string }): boolean {
  return input.todayIso >= earlyBirdsAutoApproveDueAtIso(input.computedAtIso);
}

/**
 * The national winner is crowned once every district has settled, or once every district has had
 * its full decision window — whichever comes first. Waiting only on "all settled" would stall
 * forever behind one district with no eligible rep; keying off a period-end deadline would, on a
 * backfilled fortnight, crown the first district to approve while the rest had not been asked.
 */
export function isEarlyBirdsNationalCrownDue(input: {
  todayIso: string;
  openDistrictCount: number;
  /** The NEWEST computed_at across the period's snapshots — the last manager to be asked. */
  latestComputedAtIso: string | null;
}): boolean {
  if (input.openDistrictCount === 0) return true;
  if (!input.latestComputedAtIso) return false;
  return isEarlyBirdsAutoApproveDue({ computedAtIso: input.latestComputedAtIso, todayIso: input.todayIso });
}
