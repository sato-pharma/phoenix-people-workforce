/**
 * PLAN VERSUS ACTUAL, per planned row — the pure half.
 *
 * The Reps Weekly Plans tab shows what a rep said he would do. This says what happened. Until
 * 2026-09-03 the two were on different screens: a manager verifying last week's plan could read
 * every doctor on it and had no way, on that page, to see which of them the rep actually reached.
 *
 * ## THE FIVE VERDICTS, AND WHY "MISSED" IS THE CAREFUL ONE
 *
 * Every one of these is an accusation about a named person, so each has to be exactly as strong as
 * the evidence behind it and no stronger:
 *
 * - `visited`  — a regular visit to that doctor, on that planned day. The plan was kept.
 * - `moved`    — a regular visit to that doctor inside the plan's window, on a DIFFERENT day. The
 *                work was done; the route slipped. Calling that "missed" is the single easiest way
 *                to make this feature untrustworthy, because it is wrong in the rep's favour to
 *                nobody and wrong against him constantly — reps reshuffle days routinely.
 * - `missed`   — no regular visit to that doctor anywhere in the window, and the day has ENDED.
 * - `upcoming` — the planned day is today or later. Nothing has failed yet, and a red mark on a
 *                Thursday plan read on Monday is a fabrication.
 * - `unknown`  — the row cannot be judged: no contact id, no date, or the actuals could not be read.
 *
 * ## ONLY `visit_type = 0` CAN SATISFY A PLANNED CALL
 *
 * A campaign row (`-8`) names no doctor at all, so it can never match a planned one. That is the
 * standing rule and it is also the standing TRAP: a rep who spent the day on a campaign has visits,
 * has worked, and matches nothing — which is why the day summary carries his campaign count
 * separately instead of letting an all-campaign day read as an idle one.
 *
 * Public holiday (`-5`) and casual leave (`-6`) are WORKING days by the owner's rule and never
 * absence, but neither is a doctor call either — they simply do not appear among the actuals, and a
 * doctor planned on such a day is `missed` like any other. That is correct: the plan named him.
 *
 * ## THE DAY IS JUDGED BY THE DATE, NEVER BY THE CLOCK
 *
 * `today` is passed in (Cairo, ISO) and compared as a string. No `Date` is constructed anywhere in
 * this file, so no timezone can shift a day — the trap that makes a Cairo evening read as tomorrow.
 */

/** One actual visit, reduced to the two fields a plan row can be matched on. */
export type PlanActualVisit = {
  /** Null on a campaign row, which is what makes a campaign call unmatchable by construction. */
  contactCrmId: number | null;
  /** ISO `YYYY-MM-DD`. */
  dateIso: string | null;
  /** True for a campaign call — counted for the day, never matched to a doctor. */
  campaign: boolean;
};

export type PlanRowVerdict = "visited" | "moved" | "missed" | "upcoming" | "unknown";

/**
 * What actually happened in one plan's window.
 *
 * Built once per plan and read per row. `null` is a legitimate value at the call site and means the
 * actuals could NOT be read — every verdict is then `unknown` and the screen shows no marks at all,
 * rather than marking a whole week missed because one query failed. Those two states look identical
 * to a reader who is only shown red, which is exactly why they must not render the same.
 */
export type PlanActuals = {
  /** ISO date -> the contacts he made a regular visit to that day. */
  regularByDate: ReadonlyMap<string, ReadonlySet<number>>;
  /** Every contact he made a regular visit to anywhere in the window. */
  regularContacts: ReadonlySet<number>;
  /** ISO date -> how many campaign calls he logged that day. */
  campaignByDate: ReadonlyMap<string, number>;
  /** Cairo today, ISO. A planned day on or after this is not judgeable yet. */
  today: string;
};

/** What one planned DAY came to. Null on a day nothing can be said about. */
export type PlanDayActual = {
  /** Planned calls on this day — a doctor planned AM and PM is two. */
  planned: number;
  visited: number;
  moved: number;
  missed: number;
  /** Campaign calls he logged that day. Never matched to a plan row; see the header. */
  campaignCalls: number;
  /** True while the day is today or still ahead — the counts above are then all `upcoming`. */
  upcoming: boolean;
};

export function buildPlanActuals(visits: readonly PlanActualVisit[], today: string): PlanActuals {
  const regularByDate = new Map<string, Set<number>>();
  const regularContacts = new Set<number>();
  const campaignByDate = new Map<string, number>();

  for (const visit of visits) {
    const date = visit.dateIso;
    if (!date) continue;
    if (visit.campaign) {
      campaignByDate.set(date, (campaignByDate.get(date) ?? 0) + 1);
      continue;
    }
    if (visit.contactCrmId == null) continue;
    let sameDay = regularByDate.get(date);
    if (!sameDay) {
      sameDay = new Set<number>();
      regularByDate.set(date, sameDay);
    }
    sameDay.add(visit.contactCrmId);
    regularContacts.add(visit.contactCrmId);
  }

  return { campaignByDate, regularByDate, regularContacts, today };
}

/**
 * The verdict for one planned row.
 *
 * Order matters and is not arbitrary: `visited` is checked before the day is judged, because a
 * doctor already seen TODAY is a kept plan and calling it `upcoming` would hide the rep's own work
 * on the day he is doing it.
 */
export function planRowVerdict(
  actuals: PlanActuals | null,
  row: { contactCrmId: number | null; date: string | null },
): PlanRowVerdict {
  if (!actuals) return "unknown";
  if (row.contactCrmId == null || !row.date) return "unknown";
  if (actuals.regularByDate.get(row.date)?.has(row.contactCrmId)) return "visited";
  // Today counts as not-yet-judged. A plan for this afternoon has not been broken by lunchtime.
  if (row.date >= actuals.today) return "upcoming";
  if (actuals.regularContacts.has(row.contactCrmId)) return "moved";
  return "missed";
}

/** The same judgement over a whole day's rows. `null` when the actuals could not be read. */
export function planDayActual(
  actuals: PlanActuals | null,
  date: string | null,
  rows: readonly { verdict: PlanRowVerdict }[],
): PlanDayActual | null {
  if (!actuals || !date) return null;
  const upcoming = date >= actuals.today;
  return {
    campaignCalls: actuals.campaignByDate.get(date) ?? 0,
    missed: rows.filter((row) => row.verdict === "missed").length,
    moved: rows.filter((row) => row.verdict === "moved").length,
    planned: rows.length,
    upcoming,
    visited: rows.filter((row) => row.verdict === "visited").length,
  };
}

/**
 * The chip's words. Short enough for a table cell, and each one a statement somebody could defend.
 *
 * `unknown` and `upcoming` return null on purpose — a row nothing can be said about must show
 * NOTHING rather than a grey "unknown" badge, which reads as a fault in the data and invites
 * somebody to go looking for one.
 */
export const PLAN_VERDICT_LABEL: Record<PlanRowVerdict, string | null> = {
  missed: "Not seen",
  moved: "Seen another day",
  unknown: null,
  upcoming: null,
  visited: "Seen",
};

/** The full sentence, for the chip's `title` and the export column. */
export const PLAN_VERDICT_MEANING: Record<PlanRowVerdict, string | null> = {
  missed: "No visit to this doctor anywhere in the plan's week, and the planned day has ended.",
  moved: "Visited inside this plan's week, but on a different day than the one planned.",
  unknown: null,
  upcoming: null,
  visited: "Visited on the day this plan named.",
};
