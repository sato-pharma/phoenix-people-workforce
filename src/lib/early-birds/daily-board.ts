// Who won each day of the fortnight, replayed through the SAME function that renders the daily
// board a District Manager actually looked at.
//
// This is the most important consistency property in the module. If the fortnightly "6 first
// places" figure were computed by a second, parallel implementation of "who was earliest", the two
// would eventually disagree and the award would be indefensible the first time a rep counted his
// own wins. So this calls buildNsmCrmCompliance once per day rather than reimplementing it.

import {
  buildNsmCrmCompliance,
  type CrmPerson,
  type NsmCrmCheckinRow,
  type NsmCrmVisitRow,
} from "@/lib/employee-portal/nsm-crm-compliance";
import { normalizeHrIdForAccess } from "@/lib/hr-id";
import {
  EARLY_BIRDS_MIN_SUBMITTERS_FOR_DAILY_WIN,
  isPlausibleEarlyBirdsStart,
} from "@/lib/early-birds/scoring";
import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";
import { earlyBirdsPeriodDays } from "@/lib/early-birds/period";

export type EarlyBirdsDailyWinners = {
  /** Cairo day -> the winning rep's canonical key, or null when the day was not contested. */
  winnersByDate: Map<string, string | null>;
  contestedDays: number;
};

/**
 * A day only crowns a winner when it was genuinely won:
 *
 * - at least {@link EARLY_BIRDS_MIN_SUBMITTERS_FOR_DAILY_WIN} people submitted, so being the only
 *   rep who worked that day is not a "win"; and
 * - the leader has a real clock. `buildNsmCrmCompliance` deliberately still ranks a submitter whose
 *   visit carried no vendor timestamp — it sorts them last — which means on a quiet day the top of
 *   the list can be someone with `at === null`. Counting that as a first place would award the
 *   fortnight on the strength of a missing timestamp.
 *
 * Days that fail either test are excluded from `contestedDays` too, so they cannot dilute anyone's
 * first-place ratio.
 */
export function buildEarlyBirdsDailyWinners(input: {
  period: EarlyBirdsPeriod;
  reps: readonly CrmPerson[];
  visitsByDate: ReadonlyMap<string, readonly NsmCrmVisitRow[]>;
  checkinsByDate: ReadonlyMap<string, readonly NsmCrmCheckinRow[]>;
  throughIso?: string;
}): EarlyBirdsDailyWinners {
  const winnersByDate = new Map<string, string | null>();
  let contestedDays = 0;

  for (const dateIso of earlyBirdsPeriodDays(input.period, input.throughIso)) {
    const visits = input.visitsByDate.get(dateIso) ?? [];
    if (visits.length === 0) {
      winnersByDate.set(dateIso, null);
      continue;
    }

    const board = buildNsmCrmCompliance({
      date: dateIso,
      reps: [...input.reps],
      dsms: [],
      visits: [...visits],
      checkins: [...(input.checkinsByDate.get(dateIso) ?? [])],
      limit: Number.POSITIVE_INFINITY,
    });

    const leader = board.earlyBirds[0];
    // `at` is a vendor timestamp whose UTC clock reading IS the Cairo wall clock (see the
    // vendor-timestamp invariant in crm/vendor-row-types.ts), so the hours/minutes can be read straight off it.
    const leaderMinutes = leader?.at
      ? new Date(leader.at).getUTCHours() * 60 + new Date(leader.at).getUTCMinutes()
      : null;
    const contested =
      board.earlyBirds.length >= EARLY_BIRDS_MIN_SUBMITTERS_FOR_DAILY_WIN &&
      // A day cannot be "won" on a 00:30 write-up of yesterday's work.
      isPlausibleEarlyBirdsStart(leaderMinutes);

    if (!contested || !leader) {
      winnersByDate.set(dateIso, null);
      continue;
    }

    // Symbols stripped, so this key matches the roster keys the scorer builds — canonicalHrIdKey
    // keeps hyphens and would silently never match a stored "B-100" against a canonical "B100".
    winnersByDate.set(dateIso, normalizeHrIdForAccess(leader.hrId));
    contestedDays += 1;
  }

  return { winnersByDate, contestedDays };
}
