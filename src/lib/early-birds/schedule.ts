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
}): EarlyBirdsPeriod[] {
  const lookback = input.lookbackPeriods ?? EARLY_BIRDS_BACKFILL_PERIODS;
  const due: EarlyBirdsPeriod[] = [];

  for (const period of listRecentEarlyBirdsPeriods(input.todayIso, lookback + 1)) {
    if (!isEarlyBirdsPeriodClosed(period, input.todayIso)) continue;
    if (input.snapshottedPeriodKeys.has(period.periodKey)) continue;

    const isFirstDayAfterClose = input.todayIso === addDaysIso(period.endIso, 1);
    if (isFirstDayAfterClose && input.minutesSinceMidnight < EARLY_BIRDS_CLOSE_EARLIEST_CAIRO_MINUTES) {
      continue;
    }

    due.push(period);
    if (due.length >= lookback) break;
  }

  return due;
}

/** The day rank #1 is crowned automatically if the manager still has not decided. */
export function earlyBirdsAutoApproveDateIso(period: EarlyBirdsPeriod): string {
  return addDaysIso(period.endIso, EARLY_BIRDS_AUTO_APPROVE_AFTER_DAYS);
}

/**
 * The rep is never punished for his manager's inaction, and the award always lands while it still
 * feels current. The manager is told it happened rather than it being silent.
 */
export function isEarlyBirdsAutoApproveDue(period: EarlyBirdsPeriod, todayIso: string): boolean {
  return todayIso >= earlyBirdsAutoApproveDateIso(period);
}

/**
 * The national winner is crowned once every district has settled, or at the auto-approve deadline —
 * whichever comes first. Waiting only on "all settled" would stall forever behind one district with
 * no eligible rep; waiting only on the deadline would delay a fortnight everyone had already
 * decided.
 */
export function isEarlyBirdsNationalCrownDue(input: {
  period: EarlyBirdsPeriod;
  todayIso: string;
  openDistrictCount: number;
}): boolean {
  if (input.openDistrictCount === 0) return true;
  return isEarlyBirdsAutoApproveDue(input.period, input.todayIso);
}
