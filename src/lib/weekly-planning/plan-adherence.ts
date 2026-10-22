// ─────────────────────────────────────────────────────────────────────────────
// Did the week actually go the way it was planned?
//
// THE OWNER'S ASK, 2026-08-28: "I want to be shown on every plan its score, and
// on everyone's overview dashboard have this score. And when he presses on it, it
// redirects him to a popup or a page telling him where is the mismatch and how to
// keep his score a hundred percent in this module."
//
// So this file answers three questions about one plan, and the second and third
// are the ones that matter:
//
//   1. a number      — kept ÷ what could be checked
//   2. WHERE it broke — item by item, with the day and the person
//   3. WHAT TO DO    — one plain instruction per miss
//
// A score with no (2) and (3) is a scolding. The verdicts below carry both.
//
// PURE. Reads live in plan-adherence-data.ts, for the same reason rep-visits.ts
// is kept apart from rep-visits-data.ts: this stays testable without a database.
//
// ── WHAT THE PLAN MODULE ACTUALLY IS ───────────────────────────────────────────
// Measured on production 2026-08-28: 105 plans, 20 people, and every one of them
// a MANAGER — District Sales Manager, National Sales Manager, Training Manager,
// Product Manager, Group Product Manager. No medical rep has ever filed one. So
// the thing being scored is a manager's week, and the evidence is the CRM's own
// record of where he was.
//
// 640 plan items break down as: Double Visit 314, Office 177, Field 59, National
// Vacation 28, Meeting 19, Meeting with Team 10, Vacation 8, Travel 8, Admin 6,
// Training 5, Other 3, Event 3. Only the first and third leave a trace in the CRM,
// which is why only those two are scored — see `isCheckableActivity`.
// ─────────────────────────────────────────────────────────────────────────────

import { cairoTodayIso } from "@/lib/crm/dates";

/**
 * What happened to one planned item.
 *
 * The miss verdicts are deliberately NOT one "missed" bucket. They have different
 * causes and different fixes, and collapsing them would leave the screen saying
 * "you missed 90" with no way to act on it:
 *
 *   wrong_partner   he WAS out that day — with somebody else. COUNTS AS KEPT (see below).
 *   partner_alone   the rep he named worked; he was not with him.
 *   no_trace        neither of them logged anything. The day did not happen as written.
 */
export type PlanAdherenceVerdict =
  | "kept"
  | "wrong_partner"
  | "partner_alone"
  | "no_trace"
  | "not_yet_due"
  | "not_checkable";

/** The verdicts that reach the DENOMINATOR — the days the CRM can answer for. */
const SCORED_VERDICTS: ReadonlySet<PlanAdherenceVerdict> = new Set<PlanAdherenceVerdict>([
  "kept",
  "wrong_partner",
  "partner_alone",
  "no_trace",
]);

/**
 * The verdicts that reach the NUMERATOR — the days that count as kept.
 *
 * OWNER RULE, 2026-08-28, asked and answered in plain words: a partner swap agreed on the day
 * counts as KEPT. He went to the field on the day he committed to; which colleague ended up beside
 * him is a scheduling detail the CRM cannot distinguish from a verbal agreement, and scoring it as
 * a failure punishes a manager for a day he actually worked.
 *
 * `wrong_partner` therefore survives as its own verdict rather than being folded into `kept` — the
 * swap is still worth SEEING ("you went with Esraa, not Aya"), it is simply not worth DEDUCTING.
 * Keeping the two sets separate is the whole point: what is measurable and what is creditable are
 * different questions, and the next verdict added has to answer both deliberately.
 *
 * Do not "fix" this back to a miss without asking him again.
 */
const KEPT_VERDICTS: ReadonlySet<PlanAdherenceVerdict> = new Set<PlanAdherenceVerdict>([
  "kept",
  "wrong_partner",
]);

export function isScoredVerdict(verdict: PlanAdherenceVerdict): boolean {
  return SCORED_VERDICTS.has(verdict);
}

export function countsAsKept(verdict: PlanAdherenceVerdict): boolean {
  return KEPT_VERDICTS.has(verdict);
}

/**
 * Activity types the CRM can confirm or deny.
 *
 * A day in the office, a meeting, a training day or a vacation leaves NO trace in
 * the visit feed, so there is nothing to check and scoring one would invent a
 * failure out of an ordinary Tuesday. They are reported as `not_checkable` and
 * excluded from the denominator — never counted as a miss, never silently dropped.
 */
const CHECKABLE_ACTIVITIES: ReadonlySet<string> = new Set(["double visit", "field"]);

export function isCheckableActivity(activityType: string | null | undefined): boolean {
  return CHECKABLE_ACTIVITIES.has(String(activityType ?? "").trim().toLowerCase());
}

function isDoubleVisit(activityType: string | null | undefined): boolean {
  return String(activityType ?? "").trim().toLowerCase() === "double visit";
}

/** One row of a plan, as the scorer needs it. */
export type PlanItemForAdherence = {
  id: string;
  activityDate: string | null;
  activityType: string | null;
  activityTitle: string | null;
  /** The rep the manager said he would go out with. Null on a Field day. */
  partnerHrId: string | null;
  partnerName: string | null;
};

/**
 * What the CRM knows about the days this plan covers.
 *
 * Four indexes rather than a row list, because the scorer asks four different
 * questions per item and a linear scan per item would be quadratic on a page that
 * renders a whole team's plans.
 */
export type PlanAdherenceEvidence = {
  /** date -> hr ids (lower-cased) the plan owner was out with that day, in either role. */
  ownerPartnersByDate: ReadonlyMap<string, ReadonlySet<string>>;
  /** Dates the plan owner appears on any visit at all. Answers a Field day. */
  ownerActiveDates: ReadonlySet<string>;
  /** `${date}|${lowerHrId}` for anyone who logged a visit that day. Tells "rep alone" from "no trace". */
  personActiveDayKeys: ReadonlySet<string>;
  /** lower-cased hr id -> the person's real name. Owner's standing rule: never show a raw id. */
  nameByHrId: ReadonlyMap<string, string>;
};

export function emptyPlanAdherenceEvidence(): PlanAdherenceEvidence {
  return {
    nameByHrId: new Map(),
    ownerActiveDates: new Set(),
    ownerPartnersByDate: new Map(),
    personActiveDayKeys: new Set(),
  };
}

export type PlanAdherenceItem = {
  id: string;
  activityDate: string | null;
  activityType: string | null;
  activityTitle: string | null;
  plannedPartnerName: string | null;
  verdict: PlanAdherenceVerdict;
  /** Who he was actually out with, by name, when the plan named somebody else. */
  actualPartnerNames: readonly string[];
  /** One plain instruction. Null when nothing needs doing. */
  advice: string | null;
};

export type PlanAdherenceScore = {
  /** kept ÷ checkable, 0-100, rounded. NULL when nothing could be checked. */
  scorePct: number | null;
  kept: number;
  /** The denominator: items that could be checked and whose day has passed. */
  checkable: number;
  /** Planned, checkable, but the day has not happened yet. Excluded from the score. */
  notYetDue: number;
  /** Office, meetings, vacation, training — nothing for the CRM to confirm. */
  notCheckable: number;
  /**
   * FALSE when this plan has nothing measurable in it.
   *
   * Copied deliberately from `hasMeasurablePlan` in crm/rep-doctor-lists.ts: a
   * manager whose week was five office days is not a 0% performer, and ranking him
   * as one is how a scoreboard starts lying. Every consumer must check this before
   * rendering a number or sorting on one.
   */
  measurable: boolean;
  /** The day the score was computed through — items after it are not yet due. */
  scoredThrough: string;
  items: readonly PlanAdherenceItem[];
};

/**
 * The instruction that turns a miss into something a person can act on.
 *
 * Written as a sentence a manager can read at 4am and know what to do next, not as
 * a category name. The owner asked for "how to keep his score a hundred percent" —
 * this is that, per row, rather than a link to a policy nobody opens.
 */
function adviceFor(verdict: PlanAdherenceVerdict, plannedName: string | null, actualNames: readonly string[]): string | null {
  const planned = plannedName ?? "the rep you named";
  switch (verdict) {
    // Not corrective. This day already counts as kept, so the line records what happened and says
    // so plainly — telling a manager to fix a day he is not being marked down for is how a score
    // stops being believed.
    case "wrong_partner":
      return actualNames.length > 0
        ? `Counted as kept — you were in the field that day, with ${actualNames.join(" and ")} rather than ${planned}. Revising the plan keeps the record straight, but it does not change your score.`
        : `Counted as kept — you were in the field that day, with somebody other than ${planned}. Revising the plan keeps the record straight, but it does not change your score.`;
    case "partner_alone":
      return `${planned} worked that day without you. Join them as planned, or move the double visit to a day you can make.`;
    case "no_trace":
      return `Nothing was logged that day, by you or by ${planned}. If the day moved, revise the plan before the week closes.`;
    default:
      return null;
  }
}

function dayKey(dateIso: string, hrId: string): string {
  return `${dateIso}|${hrId.toLowerCase()}`;
}

/**
 * Score one plan against what the CRM recorded.
 *
 * `today` is injected rather than read here so the whole thing stays pure and a
 * test can score a finished week and a running one with the same function. It
 * defaults to Africa/Cairo, which is the only clock this business runs on.
 */
export function scorePlanAdherence(
  items: readonly PlanItemForAdherence[],
  evidence: PlanAdherenceEvidence,
  options: { today?: string } = {},
): PlanAdherenceScore {
  const today = options.today ?? cairoTodayIso();
  const scored: PlanAdherenceItem[] = [];
  let kept = 0;
  let checkable = 0;
  let notYetDue = 0;
  let notCheckable = 0;

  for (const item of items) {
    const date = item.activityDate?.slice(0, 10) || null;
    const partnerHrId = item.partnerHrId?.trim().toLowerCase() || null;
    let verdict: PlanAdherenceVerdict;
    let actualPartnerNames: string[] = [];

    if (!date || !isCheckableActivity(item.activityType)) {
      // An office day, a meeting, a vacation — or a row with no date at all, which
      // cannot be checked against a day that does not exist.
      verdict = "not_checkable";
    } else if (date > today) {
      // A plan for next week has not been broken yet. Counting it as a miss would
      // make every freshly approved plan open at 0%.
      verdict = "not_yet_due";
    } else if (isDoubleVisit(item.activityType) && !partnerHrId) {
      // 11 of production's 314 double-visit rows name no rep. There is nothing to
      // confirm, so it is reported honestly rather than guessed at either way.
      verdict = "not_checkable";
    } else if (!isDoubleVisit(item.activityType)) {
      // A Field day. The question is only whether he was out at all — all 20 plan
      // owners appear in the visit feed, as agent and as double partner both.
      verdict = evidence.ownerActiveDates.has(date) ? "kept" : "no_trace";
    } else {
      const wasWith = evidence.ownerPartnersByDate.get(date) ?? new Set<string>();
      if (partnerHrId && wasWith.has(partnerHrId)) {
        verdict = "kept";
      } else if (wasWith.size > 0) {
        verdict = "wrong_partner";
        actualPartnerNames = [...wasWith]
          .map((id) => evidence.nameByHrId.get(id))
          .filter((name): name is string => Boolean(name))
          .sort();
      } else if (partnerHrId && evidence.personActiveDayKeys.has(dayKey(date, partnerHrId))) {
        verdict = "partner_alone";
      } else {
        verdict = "no_trace";
      }
    }

    // Both halves of the fraction are asked of a named set rather than re-decided here, so a
    // verdict added later cannot silently land in the score — or silently earn credit.
    if (isScoredVerdict(verdict)) {
      checkable += 1;
      if (countsAsKept(verdict)) kept += 1;
    } else if (verdict === "not_yet_due") notYetDue += 1;
    else notCheckable += 1;

    scored.push({
      activityDate: date,
      activityTitle: item.activityTitle,
      activityType: item.activityType,
      actualPartnerNames,
      advice: adviceFor(verdict, item.partnerName, actualPartnerNames),
      id: item.id,
      plannedPartnerName: item.partnerName,
      verdict,
    });
  }

  return {
    checkable,
    items: scored,
    kept,
    measurable: checkable > 0,
    notCheckable,
    notYetDue,
    scorePct: checkable > 0 ? Math.round((kept / checkable) * 100) : null,
    scoredThrough: today,
  };
}

/**
 * The colour band, matching the portal's existing KPI bands exactly.
 *
 * Taken from `portal-command-center.tsx` rather than invented, because a second
 * palette for the same idea is how two screens start disagreeing about whether 88%
 * is good. Null scores get the neutral tone — "not measured" is not "bad".
 */
export function planAdherenceTone(scorePct: number | null): string {
  if (scorePct == null) return "text-slate-400";
  if (scorePct >= 100) return "text-emerald-600";
  if (scorePct >= 90) return "text-amber-600";
  if (scorePct >= 70) return "text-orange-600";
  return "text-rose-600";
}

/** The one-line human label for a verdict. Never a raw code — owner's standing rule. */
export const PLAN_ADHERENCE_VERDICT_LABELS: ReadonlyMap<PlanAdherenceVerdict, string> = new Map([
  ["kept", "Kept"],
  // Leads with "Kept" because it now scores as kept — a label reading like a fault beside a number
  // that does not deduct for it is the kind of mismatch that makes people distrust the whole score.
  ["wrong_partner", "Kept — went with someone else"],
  ["partner_alone", "They went without you"],
  ["no_trace", "Nothing logged"],
  ["not_yet_due", "Still to come"],
  ["not_checkable", "Not tracked in CRM"],
]);

export function planAdherenceVerdictLabel(verdict: PlanAdherenceVerdict): string {
  return PLAN_ADHERENCE_VERDICT_LABELS.get(verdict) ?? verdict;
}

/**
 * One person's score history, newest first — the extra approvals tab the owner asked for.
 *
 * `measurable` rides along per period for the same reason it does on a single plan:
 * a week of pure office days must render as "not measured", not as a zero that drags
 * an average down and makes a manager look worse the more admin he was given.
 */
export type PlanAdherenceHistoryEntry = {
  planId: string;
  periodKey: string;
  periodStartDate: string;
  periodEndDate: string;
  status: string;
  scorePct: number | null;
  kept: number;
  checkable: number;
  measurable: boolean;
};

export type PlanAdherenceHistory = {
  entries: readonly PlanAdherenceHistoryEntry[];
  /** Weighted by items, not a mean of percentages — a 1-item week must not outweigh a 12-item one. */
  averagePct: number | null;
  totalKept: number;
  totalCheckable: number;
  /** How many periods actually carried something measurable. */
  measuredPeriods: number;
};

/**
 * Plans whose status keeps them OUT of a person's score history.
 *
 * - draft: a working note nobody has submitted; scoring it would put a red number against a manager
 *   for a week he has not committed to yet.
 * - cancelled: withdrawn by its owner.
 * - manager_rejected / ceo_rejected: dead ends. The database's active-period unique index already
 *   treats them as such, so the owner files a REPLACEMENT plan for the same period; scoring the
 *   rejected one as well scored it as "no trace" and counted one week twice.
 *
 * The returned statuses are deliberately NOT here: a returned plan is the same plan being reworked,
 * and its replacement is that very row, so it is scored once.
 */
export const PLAN_ADHERENCE_HISTORY_EXCLUDED_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "ceo_rejected",
  "draft",
  "manager_rejected",
]);

/** Whether a plan with this status is scored in the person's history. */
export function isScoredInAdherenceHistory(status: string | null | undefined): boolean {
  return !PLAN_ADHERENCE_HISTORY_EXCLUDED_STATUSES.has(String(status ?? "").toLowerCase());
}

/**
 * A district manager's history once he has Phoenix CRM weeks: each Phoenix week REPLACES the legacy
 * weekly plan whose dates it overlaps (owner, 2026-10-16: "his Phoenix CRM week REPLACES the legacy
 * plan once his team is live"). Concatenating the two scored one real week twice — Weaam Mahmoud,
 * Mina Farouk and Taha Mohamed each hold both for the week of 17 Oct 2026 (re-audit, 2026-10-22), so
 * the moment they send the Phoenix one the card would average the same week in twice. A legacy plan
 * that overlaps no Phoenix week — every week before the go-live — stays exactly as it was.
 */
export function mergeManagerPlanWeeks(
  legacy: readonly PlanAdherenceHistoryEntry[],
  phoenixWeeks: readonly PlanAdherenceHistoryEntry[],
): PlanAdherenceHistory {
  const overlapsPhoenixWeek = (entry: PlanAdherenceHistoryEntry) =>
    phoenixWeeks.some((week) => entry.periodStartDate <= week.periodEndDate && entry.periodEndDate >= week.periodStartDate);
  return buildPlanAdherenceHistory([...legacy.filter((entry) => !overlapsPhoenixWeek(entry)), ...phoenixWeeks]);
}

export function buildPlanAdherenceHistory(
  entries: readonly PlanAdherenceHistoryEntry[],
): PlanAdherenceHistory {
  const sorted = [...entries].sort((a, b) => (a.periodStartDate < b.periodStartDate ? 1 : -1));
  let totalKept = 0;
  let totalCheckable = 0;
  let measuredPeriods = 0;
  for (const entry of sorted) {
    if (!entry.measurable) continue;
    measuredPeriods += 1;
    totalKept += entry.kept;
    totalCheckable += entry.checkable;
  }
  return {
    averagePct: totalCheckable > 0 ? Math.round((totalKept / totalCheckable) * 100) : null,
    entries: sorted,
    measuredPeriods,
    totalCheckable,
    totalKept,
  };
}
