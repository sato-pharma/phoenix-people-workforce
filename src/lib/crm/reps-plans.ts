// ─────────────────────────────────────────────────────────────────────────────
// Reps Plans — the board behind /admin/reps-plans.
//
// PURE. It takes a CallRateReport from crm/call-rate.ts and shapes it into the
// rows, totals and labels the screen needs. There is no database import here on
// purpose, so every rule below is testable without one; the fetch lives in
// crm/call-rate-service.ts and the page wires the two together.
//
// WHAT THE PAGE IS FOR. The owner's KPI is two rates — two AM accounts and ten
// PM clinics on every working day. Until now the only way to read that was to
// count rows, and a campaign call is a row: a date, a rep, an AM/PM flag and a
// sentence, with no customer, no location and no check-in that anyone can
// verify. So the raw rate can be met without a single provable visit. This board
// shows the two numbers side by side — what the rep reported, and what can be
// proved — and never collapses them into one.
//
// The date maths below is a deliberate local copy. The sibling board's
// monthBounds/monthLabelOf live inside crm/rep-doctor-lists.ts, which imports the
// Supabase reader; a pure module cannot pull that chain in for four lines of
// arithmetic. Both are string-only and neither ever builds a displayed instant.
// ─────────────────────────────────────────────────────────────────────────────

import {
  AM_CALL_RATE_TARGET,
  PM_CALL_RATE_TARGET,
  type CallRateReport,
  type CallRateSlice,
  type RepCallRate,
} from "@/lib/crm/call-rate";

export const REPS_PLANS_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** First and last day of a month key, inclusive. */
function monthBounds(monthKey: string): { from: string; to: string } {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one. UTC-only construction, and only the day
  // NUMBER is read back out — no instant derived from it ever reaches a stored or displayed value.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${String(lastDay).padStart(2, "0")}` };
}

export function monthLabelOfKey(monthKey: string): string {
  const monthIndex = Number(monthKey.slice(5, 7)) - 1;
  return `${MONTH_NAMES[monthIndex] ?? monthKey} ${monthKey.slice(0, 4)}`;
}

/** Anything unparseable falls back to the Cairo month we are in. */
export function resolveRepsPlansMonth(month: string | undefined, todayIso: string): string {
  if (month && REPS_PLANS_MONTH_PATTERN.test(month)) return month;
  return todayIso.slice(0, 7);
}

export type RepsPlansRange = {
  dateFrom: string;
  /** Last day scored — today for the live month, the month's own last day otherwise. */
  dateTo: string;
  /** The month's real last day, whether or not it has arrived. */
  monthEnd: string;
  isCurrentMonth: boolean;
};

/**
 * The scored window.
 *
 * For a LIVE month it stops at today, deliberately. The denominator is the
 * CALENDAR count of Sat–Wed, so scoring the whole of August on the 12th divides
 * a third of a month's work by a full month of days and shows the entire field
 * force failing. Capping the window keeps the rate comparable on any day of the
 * month; the screen says which day it was scored through.
 */
export function repsPlansRange(month: string, todayIso: string): RepsPlansRange {
  const { from, to } = monthBounds(month);
  // Plain string comparison — YYYY-MM-DD sorts correctly as text, and parsing to a Date would move
  // the Cairo day this was resolved from.
  const isCurrentMonth = todayIso >= from && todayIso <= to;
  return { dateFrom: from, dateTo: isCurrentMonth ? todayIso : to, monthEnd: to, isCurrentMonth };
}

const round2 = (value: number | null): number | null => (value == null ? null : Math.round(value * 100) / 100);
const roundPct = (value: number | null): number | null => (value == null ? null : Math.round(value));

/** One session as the table shows it — proved and reported kept apart. */
export type RepsPlansSession = {
  verified: number;
  unverified: number;
  campaign: number;
  /** verified + unverified + campaign — what a row count alone would report. */
  reported: number;
  /** verified / working days. The headline. */
  verifiedRate: number | null;
  /** reported / working days — the same rep's number if nobody checks. */
  reportedRate: number | null;
  target: number;
  /** verifiedRate as a percentage of target. */
  attainmentPct: number | null;
};

function toSession(slice: CallRateSlice): RepsPlansSession {
  return {
    verified: slice.verified,
    unverified: slice.unverified,
    campaign: slice.campaign,
    reported: slice.total,
    verifiedRate: round2(slice.verifiedRate),
    reportedRate: round2(slice.totalRate),
    target: slice.target,
    attainmentPct: roundPct(slice.attainmentPct),
  };
}

export type RepsPlansRepRow = {
  repKey: string;
  repName: string;
  agentHrId: string | null;
  agentCrmId: number | null;
  workingDays: number;
  am: RepsPlansSession;
  pm: RepsPlansSession;
  /** Rows the CRM left with no AM/PM flag — in neither session, so shown on its own. */
  unspecified: number;
  /** AM + PM verified. */
  verifiedCalls: number;
  /** AM + PM reported, plus the unflagged rows. */
  reportedCalls: number;
  campaignCalls: number;
  /** Campaign share of this rep's field work, 0–100. */
  campaignSharePct: number;
  /**
   * Share of reported calls that nothing can prove — campaign calls plus real
   * visits with no check-in. This is the column that separates a rep who worked
   * from a rep whose number was made of rows.
   */
  unprovenPct: number | null;
  /** Days over the daily campaign limit. */
  flaggedDays: number;
  /** The worst single day, for the card line beside the count. */
  worstCampaignDay: string | null;
  worstCampaignCalls: number;
  /** Days with campaign calls and not one verified visit. */
  campaignOnlyDays: number;
};

function repKeyOf(rep: RepCallRate): string {
  if (rep.agentCrmId != null) return `crm:${rep.agentCrmId}`;
  if (rep.agentHrId) return `hr:${rep.agentHrId}`;
  return `name:${rep.agentName}`;
}

export function toRepsPlansRow(rep: RepCallRate): RepsPlansRepRow {
  const am = toSession(rep.am);
  const pm = toSession(rep.pm);
  const verifiedCalls = am.verified + pm.verified;
  const reportedCalls = am.reported + pm.reported + rep.unspecified;
  const campaignCalls = am.campaign + pm.campaign;
  const worst = rep.campaignOverLimitDays[0] ?? null;
  return {
    repKey: repKeyOf(rep),
    // Never a raw code (owner's standing rule). A rep the mirror has no name for still has to be
    // identifiable, so the id is spelled out in words rather than shown bare.
    repName: rep.agentName.trim() || `Unnamed rep ${rep.agentCrmId ?? rep.agentHrId ?? ""}`.trim(),
    agentHrId: rep.agentHrId,
    agentCrmId: rep.agentCrmId,
    workingDays: rep.workingDays,
    am,
    pm,
    unspecified: rep.unspecified,
    verifiedCalls,
    reportedCalls,
    campaignCalls,
    campaignSharePct: Math.round(rep.campaignShare * 100),
    unprovenPct: reportedCalls > 0 ? Math.round(((reportedCalls - verifiedCalls) / reportedCalls) * 100) : null,
    flaggedDays: rep.campaignOverLimitDays.length,
    worstCampaignDay: worst ? worst.day : null,
    worstCampaignCalls: worst ? worst.campaignCalls : 0,
    campaignOnlyDays: rep.campaignOnlyDays,
  };
}

export type RepsPlansTotals = {
  reps: number;
  workingDays: number;
  am: RepsPlansSession;
  pm: RepsPlansSession;
  unspecified: number;
  campaignCalls: number;
  campaignSharePct: number;
  unprovenPct: number | null;
  /** Rep-days over the campaign limit, across the whole field force. */
  flaggedDays: number;
  /** Reps carrying at least one flagged day. */
  repsWithFlaggedDays: number;
  /** Rep-days made of campaign calls and no verified visit at all. */
  campaignOnlyDays: number;
  /** Reps whose AM and PM verified rates BOTH clear their target. */
  repsOnTarget: number;
};

/**
 * Field-force totals.
 *
 * The company rate is per rep per working day — total verified divided by
 * (working days x reps) — so it stays on the same scale as the two targets
 * printed beside it. Averaging the rep rates instead gives a different number
 * whenever reps differ, and this row is read directly against 2 and 10.
 */
function totalsOf(rows: readonly RepsPlansRepRow[], workingDays: number): RepsPlansTotals {
  const denominator = workingDays * rows.length;
  const blank = (target: number): RepsPlansSession => ({
    verified: 0,
    unverified: 0,
    campaign: 0,
    reported: 0,
    verifiedRate: null,
    reportedRate: null,
    target,
    attainmentPct: null,
  });
  const am = blank(AM_CALL_RATE_TARGET);
  const pm = blank(PM_CALL_RATE_TARGET);
  let unspecified = 0;
  let flaggedDays = 0;
  let repsWithFlaggedDays = 0;
  let campaignOnlyDays = 0;
  let repsOnTarget = 0;

  for (const row of rows) {
    for (const [into, from] of [
      [am, row.am],
      [pm, row.pm],
    ] as const) {
      into.verified += from.verified;
      into.unverified += from.unverified;
      into.campaign += from.campaign;
      into.reported += from.reported;
    }
    unspecified += row.unspecified;
    flaggedDays += row.flaggedDays;
    if (row.flaggedDays > 0) repsWithFlaggedDays += 1;
    campaignOnlyDays += row.campaignOnlyDays;
    if ((row.am.verifiedRate ?? 0) >= row.am.target && (row.pm.verifiedRate ?? 0) >= row.pm.target) repsOnTarget += 1;
  }

  for (const session of [am, pm]) {
    if (denominator > 0) {
      session.verifiedRate = round2(session.verified / denominator);
      session.reportedRate = round2(session.reported / denominator);
      session.attainmentPct = roundPct((session.verified / denominator / session.target) * 100);
    }
  }

  const reportedCalls = am.reported + pm.reported + unspecified;
  const verifiedCalls = am.verified + pm.verified;
  const campaignCalls = am.campaign + pm.campaign;
  return {
    reps: rows.length,
    workingDays,
    am,
    pm,
    unspecified,
    campaignCalls,
    campaignSharePct: reportedCalls > 0 ? Math.round((campaignCalls / reportedCalls) * 100) : 0,
    unprovenPct: reportedCalls > 0 ? Math.round(((reportedCalls - verifiedCalls) / reportedCalls) * 100) : null,
    flaggedDays,
    repsWithFlaggedDays,
    campaignOnlyDays,
    repsOnTarget,
  };
}

export type RepsPlansBoard = {
  month: string;
  monthLabel: string;
  dateFrom: string;
  dateTo: string;
  isCurrentMonth: boolean;
  workingDays: number;
  campaignLimit: number;
  amTarget: number;
  pmTarget: number;
  totals: RepsPlansTotals;
  reps: RepsPlansRepRow[];
  repOptions: Array<{ repKey: string; repName: string }>;
  appliedRepKey: string | null;
};

/**
 * Shape a report for the screen.
 *
 * The rep filter applies AFTER the totals are built, deliberately: the tiles
 * above the table answer "how is the field force doing", and they must not
 * change meaning because someone opened one rep. The sibling boards in this
 * shell behave the same way.
 */
export function buildRepsPlansBoard(
  report: CallRateReport,
  options: { month: string; isCurrentMonth: boolean; repKey?: string | null },
): RepsPlansBoard {
  const allRows = report.reps.map(toRepsPlansRow);
  const totals = totalsOf(allRows, report.workingDays);
  const repOptions = allRows
    .map((row) => ({ repKey: row.repKey, repName: row.repName }))
    .sort((a, b) => a.repName.localeCompare(b.repName));
  const appliedRepKey =
    options.repKey && repOptions.some((option) => option.repKey === options.repKey) ? options.repKey : null;

  return {
    month: options.month,
    monthLabel: monthLabelOfKey(options.month),
    dateFrom: report.dateFrom,
    dateTo: report.dateTo,
    isCurrentMonth: options.isCurrentMonth,
    workingDays: report.workingDays,
    campaignLimit: report.campaignLimit,
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
    totals,
    reps: appliedRepKey ? allRows.filter((row) => row.repKey === appliedRepKey) : allRows,
    repOptions,
    appliedRepKey,
  };
}
