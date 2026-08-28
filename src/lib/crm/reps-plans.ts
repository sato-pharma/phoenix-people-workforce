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
  countCallRateWorkingDays,
  type CallRateReport,
  type CallRateSlice,
  type RepCallRate,
} from "@/lib/crm/call-rate";
import {
  orgHrKey,
  placementMatches,
  type OrgCell,
  type OrgPlacement,
  type OrgPlacementTree,
} from "@/lib/crm/org-placement";
import { crmTerritoryFrom } from "@/lib/crm/rep-name";

/** `{ code, name }` — the shape both pickers render. */
export type RepsPlansOption = { code: string; name: string };

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
  /** Last day scored — capped at today while the window is still running. */
  dateTo: string;
  /** The month's real last day, whether or not it has arrived. */
  monthEnd: string;
  isCurrentMonth: boolean;
  /** The period in force: `month`, `w1`…`w5`, or an explicit `from..to`. */
  periodKey: string;
  /** "Whole month", "Week 1 · 1–7 Aug", "3–16 Aug" — what the screen prints. */
  periodLabel: string;
  /** The window's own last day BEFORE the today-cap, so the screen can say it was capped. */
  windowEnd: string;
  /** True when the whole month is in view — the default, and the only case with no extra caption. */
  isWholeMonth: boolean;
  /** True when the window has not begun. Every rate is null and the screen says so, never "0.00". */
  notStarted: boolean;
};

const MONTH_SHORT_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The calendar day before this one.
 *
 * Used for ONE thing: making a window that has not begun genuinely empty. `dateFrom > dateTo` is the
 * shape `countCallRateWorkingDays` already documents as answering 0, and the reader fetches no rows
 * for it — so a future week scores null everywhere instead of dividing real work by a day nobody has
 * worked yet. UTC-only construction, and only the date STRING is read back out.
 */
function previousDay(dateIso: string): string {
  const cursor = new Date(`${dateIso}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);
  return cursor.toISOString().slice(0, 10);
}

/** "2026-08-03" -> "3 Aug". Read straight off the string — see {@link monthBounds} on why no Date. */
function shortDayLabel(dateIso: string): string {
  const month = MONTH_SHORT_NAMES[Number(dateIso.slice(5, 7)) - 1] ?? dateIso.slice(5, 7);
  return `${Number(dateIso.slice(8, 10))} ${month}`;
}

/** "1–7 Aug", or "29 Jul – 4 Aug" when the two ends fall in different months. */
function spanLabel(from: string, to: string): string {
  if (from === to) return shortDayLabel(from);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    return `${Number(from.slice(8, 10))}–${shortDayLabel(to)}`;
  }
  return `${shortDayLabel(from)} – ${shortDayLabel(to)}`;
}

/** One selectable window. */
export type RepsPlansPeriodOption = {
  key: string;
  label: string;
  from: string;
  to: string;
  /** Sat–Wed days inside it — the denominator this window would divide by. */
  workingDays: number;
  /** True once the window has begun; a future week is offered but marked. */
  started: boolean;
};

const RANGE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

/**
 * A real calendar day, not merely a digit-shaped one.
 *
 * The shape check alone is not enough and the difference is a 500: `2026-13-01` passes any regex
 * written for `YYYY-MM-DD`, and `new Date("2026-13-01T00:00:00Z")` is an Invalid Date whose
 * `toISOString()` THROWS. This period rides in the URL, so a hand-edited or bookmarked link is a
 * user-reachable input and the page has to answer it rather than crash on it.
 *
 * Round-tripped rather than range-checked, so 31 February is rejected too — Date rolls it forward to
 * 3 March, which would silently score a window nobody asked for.
 */
function isRealCalendarDay(dateIso: string): boolean {
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dateIso;
}

/**
 * The month cut into 7-day blocks: 1–7, 8–14, 15–21, 22–28, 29–end.
 *
 * DAY BLOCKS, not Saturday-anchored calendar weeks. "The plan of the first week" means the first
 * seven days of the month to the person asking; anchoring on Saturday would make a week 1 that holds
 * two days of this month and five of the last, which is not what anybody plans against. Every label
 * carries its real dates, so no reader has to know which convention was chosen.
 *
 * The block's own working-day count comes with it, because that is the number the rate divides by
 * and a 5-day block and a 3-day tail are not the same denominator.
 */
export function repsPlansWeeks(month: string, todayIso: string): RepsPlansPeriodOption[] {
  const { to: monthEnd } = monthBounds(month);
  const lastDay = Number(monthEnd.slice(8, 10));
  const options: RepsPlansPeriodOption[] = [];
  for (let index = 0; index * 7 < lastDay; index += 1) {
    const startDay = index * 7 + 1;
    const endDay = Math.min(startDay + 6, lastDay);
    const from = `${month}-${String(startDay).padStart(2, "0")}`;
    const to = `${month}-${String(endDay).padStart(2, "0")}`;
    options.push({
      key: `w${index + 1}`,
      label: `Week ${index + 1} · ${spanLabel(from, to)}`,
      from,
      to,
      workingDays: countCallRateWorkingDays(from, todayIso < to ? todayIso : to),
      started: todayIso >= from,
    });
  }
  return options;
}

/**
 * The scored window — a month, one of its weeks, or any explicit range.
 *
 * OWNER, 2026-08-28: *"if this is the plan of the first week, then you must calculate the call rate
 * on the first week only, not all the month. And if you are calculating two weeks, then the two
 * weeks."* The rate itself was already per working day, so the arithmetic was never the problem —
 * the problem was that the window could only ever be a whole month, so a week's work was always
 * divided by a month's days and every rep read as failing by a factor of four.
 *
 * IT STILL STOPS AT TODAY, for the same reason it always did: the denominator is the CALENDAR count
 * of Sat–Wed, so scoring a window through days that have not happened shows the field force failing
 * for not having worked them yet. A window that has not begun at all is marked `notStarted` and
 * every rate is null — never a zero, which on this board reads as "did nothing".
 */
export function repsPlansRange(month: string, todayIso: string, period?: string | null): RepsPlansRange {
  const { from: monthStart, to: monthEnd } = monthBounds(month);
  // Plain string comparison — YYYY-MM-DD sorts correctly as text, and parsing to a Date would move
  // the Cairo day this was resolved from.
  const isCurrentMonth = todayIso >= monthStart && todayIso <= monthEnd;

  let windowStart = monthStart;
  let windowEnd = monthEnd;
  let periodKey = "month";
  let periodLabel = "Whole month";

  const requested = (period ?? "").trim();
  const explicit = RANGE_PATTERN.exec(requested);
  if (explicit && explicit[1] <= explicit[2] && isRealCalendarDay(explicit[1]) && isRealCalendarDay(explicit[2])) {
    windowStart = explicit[1];
    windowEnd = explicit[2];
    periodKey = `${windowStart}..${windowEnd}`;
    periodLabel = spanLabel(windowStart, windowEnd);
  } else if (/^w[1-5]$/.test(requested)) {
    const week = repsPlansWeeks(month, todayIso).find((option) => option.key === requested);
    if (week) {
      windowStart = week.from;
      windowEnd = week.to;
      periodKey = week.key;
      periodLabel = week.label;
    }
  }

  // ONLY a sub-month window can be "not started". Picking a future MONTH is a deliberate "show me
  // December" and is scored whole with no data — the behaviour this board has always had, pinned by
  // crm-reps-plans.test.ts. Picking week 4 on the 10th is the opposite: it is a window inside the
  // month you are already looking at, and scoring it whole would divide a rep's nothing by days that
  // have not happened.
  const notStarted = periodKey !== "month" && todayIso < windowStart;
  // Capped at today ONLY while today falls inside the window. A window entirely in the past is
  // scored to its own end, and one entirely in the future must not be dragged back to today — that
  // would score December as "1 Dec to 12 Aug", an empty range dressed up as a month.
  const running = todayIso >= windowStart && todayIso < windowEnd;
  const dateTo = running ? todayIso : windowEnd;
  return {
    dateFrom: windowStart,
    // A window that has not begun is scored as EMPTY, not as its first day: `dateFrom > dateTo` is
    // the shape countCallRateWorkingDays answers 0 for, so every rate comes back null and the screen
    // says the week has not started rather than printing 0.00 against a target of 2.
    dateTo: notStarted ? previousDay(windowStart) : dateTo,
    monthEnd,
    isCurrentMonth,
    periodKey,
    periodLabel,
    windowEnd,
    isWholeMonth: periodKey === "month",
    notStarted,
  };
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

/**
 * One (line, region) a person covers, from the organogram. Re-exported under the board's own name
 * so the components have one import; the resolution lives in `org-placement.ts`.
 */
export type RepsPlansTerritory = OrgCell;

/**
 * Attainment against the target the rate is measured on, 0-100. 100% is the standard here, not a
 * stretch: two AM accounts and ten PM clinics is the day, so anything under it is a miss.
 */
export function attainmentTone(value: number | null): RepsPlansTone {
  if (value == null) return undefined;
  if (value >= 100) return "emerald";
  if (value >= 70) return "amber";
  return "rose";
}

/**
 * Tile tone: a colour is a claim about whether a number is good, so it belongs with the rules and
 * not in the markup. Both are exported so a test can pin them — a tone that lies is invisible to
 * every other kind of check.
 *
 * HIGHER is better: a share of something going right, 0-100. Bands are deliberately conservative,
 * because green has to be earned. What matters is not the exact thresholds but that a tile is never
 * green while the number under it is bad: `repsOnTarget > 0 ? "emerald" : "rose"` painted 5 reps out
 * of 87 the same green as a finished job.
 */
export function shareTone(value: number | null): RepsPlansTone {
  if (value == null) return undefined;
  if (value >= 70) return "emerald";
  if (value >= 30) return "amber";
  return "rose";
}

/**
 * LOWER is better: a share of something going wrong, 0-100. Inverted on purpose, and banded rather
 * than binary — 17% of reported calls having nothing to confirm them is the entire subject of this
 * page, and it rendered in the same green as "Proved" because the single threshold sat at 25.
 */
export function riskTone(value: number | null): RepsPlansTone {
  if (value == null) return undefined;
  if (value < 10) return "emerald";
  if (value < 25) return "amber";
  return "rose";
}

/** The tones a KPI tile can take. `undefined` is "no claim" — used when a number does not exist. */
export type RepsPlansTone = "amber" | "emerald" | "rose" | undefined;

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
  /**
   * Every (line, region) this person covers, from the organogram. EMPTY means the organogram has no
   * seat for him at all — he is shown MARKED rather than dropped. See {@link buildRepsPlansBoard}.
   */
  territories: RepsPlansTerritory[];
  /** Raw organogram tier, or null when he holds no seat. */
  seatTier: string | null;
  /** "District Manager", "Medical Rep" — readable, never the raw code. Null when unplaced. */
  seatTierLabel: string | null;
  /**
   * The HR directory's job title, consulted ONLY when the organogram has no seat for the person.
   *
   * `au_v_org_tree` is the SALES seat model, so head office is legitimately off it — all three of
   * production's Product Managers are, by design. Naming such a person by his real job title is the
   * whole difference between "Product Manager" and an amber badge reading "Not in organogram", which
   * is the wording the owner objected to. Null when the directory has no title either, which is the
   * only case where there is genuinely nothing to say about where someone sits.
   *
   * A LABEL, never a KPI input: {@link RepsPlansRepRow.scored} is decided by the seat tier alone.
   */
  jobTitle: string | null;
  /**
   * Whether the 2 AM / 10 PM target applies to this person.
   *
   * OWNER'S RULE, 2026-08-28: the KPI is a MEDICAL REP'S. A manager is listed with his territory
   * and his real activity and is measured against nothing — his AM/PM percentages read "—", and he
   * is in no tile on the page. Someone with no seat at all is likewise never scored: there is no
   * evidence he is a rep, so inventing a target for him would be a guess printed as a fact.
   */
  scored: boolean;
};

function repKeyOf(rep: RepCallRate): string {
  if (rep.agentCrmId != null) return `crm:${rep.agentCrmId}`;
  if (rep.agentHrId) return `hr:${rep.agentHrId}`;
  return `name:${rep.agentName}`;
}

/**
 * What a rep is CALLED on this board.
 *
 * THE DIRECTORY NAMES THE PERSON; THE CRM NAMES THE TERRITORY — the owner's instruction of
 * 2026-08-27, applied to Doctor Coverage in #2480 and to this board here. The CRM's `agent_name`
 * is a LOGIN HANDLE with a territory bolted on ("Adel.Srour ( Down-town / C )"), so showing it
 * whole breaks the standing rule that a human-readable name is always shown, while dropping it
 * whole throws away the territory a manager reads to tell two reps apart.
 *
 * Measured on this board's own live August window before the fix: 84 of 87 rendered rep labels
 * were login handles.
 *
 * The waterfall, in order:
 *  1. the employee directory, keyed on hr id, plus the CRM's territory when it carries one;
 *  2. the CRM name unchanged — for an agent with no hr id, and for the hr-keyed agent whose
 *     directory row is missing. A name is not the place to start throwing;
 *  3. the hr id itself, upper-cased, which at least identifies a person;
 *  4. the crm id spelled out in words. Never a bare code (owner's standing rule).
 *
 * Keyed LOWER-cased on both sides. Hr ids reach this module in whatever case the CRM mirror
 * carries, which is mixed (AGENTS.md §2.1), and one person occupying two keys is exactly how a rep
 * silently becomes two rows. Rep Doctor Lists keys the same directory UPPER-cased for its own
 * reasons — the two maps are not interchangeable.
 */
function repNameFor(rep: RepCallRate, repNameByHrId?: ReadonlyMap<string, string>): string {
  const fromCrm = rep.agentName.trim();
  const hrId = rep.agentHrId?.trim();
  if (hrId) {
    const fromDirectory = repNameByHrId?.get(hrId.toLowerCase())?.trim();
    if (fromDirectory) {
      const territory = crmTerritoryFrom(fromCrm);
      return territory ? `${fromDirectory} ( ${territory} )` : fromDirectory;
    }
  }
  if (fromCrm) return fromCrm;
  if (hrId) return hrId.toUpperCase();
  return `Unnamed rep ${rep.agentCrmId ?? ""}`.trim();
}

/**
 * The HR job title for a person the organogram has no seat for. Lower-cased on both sides, for the
 * same mixed-case reason as {@link repNameFor} above.
 */
function jobTitleFor(rep: RepCallRate, jobTitleByHrId?: ReadonlyMap<string, string>): string | null {
  const hrId = rep.agentHrId?.trim();
  if (!hrId) return null;
  return jobTitleByHrId?.get(hrId.toLowerCase())?.trim() || null;
}

export function toRepsPlansRow(
  rep: RepCallRate,
  placement?: OrgPlacement | null,
  repNameByHrId?: ReadonlyMap<string, string>,
  jobTitleByHrId?: ReadonlyMap<string, string>,
): RepsPlansRepRow {
  const am = toSession(rep.am);
  const pm = toSession(rep.pm);
  const verifiedCalls = am.verified + pm.verified;
  const reportedCalls = am.reported + pm.reported + rep.unspecified;
  const campaignCalls = am.campaign + pm.campaign;
  const worst = rep.campaignOverLimitDays[0] ?? null;
  return {
    repKey: repKeyOf(rep),
    repName: repNameFor(rep, repNameByHrId),
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
    territories: placement?.cells ?? [],
    seatTier: placement?.tier ?? null,
    seatTierLabel: placement?.tierLabel ?? null,
    // Only asked when the organogram had no answer. A seated person's title is his SEAT — reading
    // the directory over it would let a stale HR job title contradict the chart the owner maintains.
    jobTitle: placement ? null : jobTitleFor(rep, jobTitleByHrId),
    scored: placement?.scored ?? false,
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
 *
 * `rows` MUST already be the SCORED rows only. The owner's rule of 2026-08-28 is that the target
 * belongs to medical reps, so a manager's coaching and double visits have no business inside a
 * number that is read against 2 and 10 — they would move the company's rate without ever being
 * measured by it. `buildRepsPlansBoard` is the only caller and it filters first; the assertion is
 * kept there rather than here so this stays a plain fold.
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

/** What the viewer picked in the geography cascade. Blank at a level means "all". */
export type RepsPlansGeography = { line?: string | null; region?: string | null };

export type RepsPlansBoard = {
  month: string;
  monthLabel: string;
  dateFrom: string;
  dateTo: string;
  isCurrentMonth: boolean;
  /** `month`, `w1`…`w5`, or `from..to` — what the period picker is showing as chosen. */
  periodKey: string;
  /** "Whole month", "Week 1 · 1–7 Aug", "3–16 Aug". */
  periodLabel: string;
  /** False when a week or a range is in view — the screen then names the window over every number. */
  isWholeMonth: boolean;
  /** True when the chosen window has not begun. Every rate is null and the screen says why. */
  notStarted: boolean;
  /** True when the window's own end is later than the day it was scored through. */
  cappedAtToday: boolean;
  /** The weeks offered for this month, each with the working days it would divide by. */
  weekOptions: RepsPlansPeriodOption[];
  workingDays: number;
  campaignLimit: number;
  amTarget: number;
  pmTarget: number;
  totals: RepsPlansTotals;
  reps: RepsPlansRepRow[];
  repOptions: Array<{ repKey: string; repName: string }>;
  appliedRepKey: string | null;
  /** Every line, always — the top of the cascade is never narrowed from below. */
  lineOptions: RepsPlansOption[];
  /** Regions that exist ON the chosen line. Unnarrowed when no line is chosen. */
  regionOptions: RepsPlansOption[];
  appliedLine: string | null;
  appliedRegion: string | null;
  /** "CNS · Delta (1)" — names only, never codes. Null when nothing is picked. */
  geographyLabel: string | null;
  /**
   * Listed but in NO tile because the target is not theirs: managers, and anyone the organogram has
   * no seat for. Always counted, filtered or not — the rule is about who the KPI belongs to, not
   * about which filter is on.
   */
  managersShown: number;
  unplacedShown: number;
  /** False when the organogram could not be read — the two pickers are then hidden, not empty. */
  geographyAvailable: boolean;
};

/**
 * Shape a report for the screen.
 *
 * ── Two filters that behave DIFFERENTLY, on purpose ──────────────────────────
 * The REP filter applies AFTER the totals are built: the tiles answer "how is
 * this team doing", and they must not change meaning because someone opened one
 * person. The sibling boards in this shell behave the same way.
 *
 * LINE and REGION do the opposite — they RECOMPUTE the tiles (owner, 2026-08-28).
 * "How is CNS doing in Delta" is the actual question, and it cannot be answered
 * by tiles that still describe the whole country.
 *
 * ── The target belongs to MEDICAL REPS ──────────────────────────────────────
 * Owner's rule, 2026-08-28, in his words: "the KPI is two AM, ten PM, for
 * medical reps. Don't restrict the managers on AM and PM coverage. Make their
 * account appear, but not restrict them on any of this."
 *
 * So a District Manager, an Acting DM, an RSM or an NSM is LISTED — with his
 * real line and region and his real activity — and scored on nothing. He is in
 * no tile, and his own two percentages read "—" rather than a red number he was
 * never meant to be measured by. A DM's field day is coaching and double visits,
 * not his own call rate; folding it into the company rate moves a number he is
 * not accountable for.
 *
 * This holds whether or not a filter is on. It is a rule about whose KPI it is.
 *
 * ── Nobody is ever dropped ──────────────────────────────────────────────────
 * Owner's decision the same day. Someone the organogram has no seat for stays
 * listed and MARKED rather than filtered away: those rows are mostly the
 * ZERO-PROVED ones, so hiding them would hide precisely what this page exists to
 * expose. `managersShown` and `unplacedShown` say how many are listed but
 * uncounted, so the gap is stated rather than implied.
 */
export function buildRepsPlansBoard(
  report: CallRateReport,
  options: {
    month: string;
    isCurrentMonth: boolean;
    /**
     * The window in view. Supplied by the page from {@link repsPlansRange}, whose `dateFrom`/`dateTo`
     * ALSO bounded the fetch — so the numbers and the caption describing them can never disagree.
     * Optional so a test about naming or geography does not have to build one; a board without it
     * reads as the whole month, which is what this page did before the period picker existed.
     */
    range?: RepsPlansRange;
    /** Every week this month offers, for the picker. Same optionality, same reason. */
    weekOptions?: RepsPlansPeriodOption[];
    repKey?: string | null;
    /** The organogram. Null when it could not be read. */
    tree?: OrgPlacementTree | null;
    geography?: RepsPlansGeography;
    /** hr id (LOWER-cased) -> the person's real name, from the employee directory. The page always
     *  supplies it; it is optional only so a test asserting something other than naming does not
     *  have to build one. */
    repNameByHrId?: ReadonlyMap<string, string>;
    /** hr id (LOWER-cased) -> HR job title, read ONLY for someone the organogram has no seat for.
     *  Same optionality, and for the same reason. */
    jobTitleByHrId?: ReadonlyMap<string, string>;
  },
): RepsPlansBoard {
  const tree = options.tree ?? null;
  const index = tree?.index ?? new Map();

  const placementOf = (hrId: string | null): OrgPlacement | null => {
    const key = orgHrKey(hrId);
    return (key ? index.get(key) : undefined) ?? null;
  };
  // The organogram could not be read at all — not "this person has no seat", but "nothing is known
  // about anyone". Scoring nobody would then blank every tile on the page and turn a Supabase blip
  // into a KPI outage, so the board falls back to exactly how it read before this feature existed:
  // everyone scored, no geography column, no pickers.
  const orgAvailable = tree != null;
  const allRows = report.reps.map((rep) => {
    const row = toRepsPlansRow(rep, placementOf(rep.agentHrId), options.repNameByHrId, options.jobTitleByHrId);
    return orgAvailable ? row : { ...row, scored: true };
  });

  // ── The Line -> Region cascade ────────────────────────────────────────────
  // Deliberately the reverse of the shared coverage bar's Region -> Line. The owner asked for line
  // first and he is right: Beni Suef and Fayoum sit in DIFFERENT regions depending on the line, so
  // region-first offers a pairing no rep satisfies.
  const lineNames = new Map((tree?.lines ?? []).map((option) => [option.code, option.name]));
  const regionNames = new Map((tree?.regions ?? []).map((option) => [option.code, option.name]));
  const optionsOf = (codes: Iterable<string>, names: Map<string, string>): RepsPlansOption[] =>
    [...new Set(codes)]
      .map((code) => ({ code, name: names.get(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name));

  const cells = tree?.cells ?? [];
  const lineOptions = optionsOf(
    cells.map((cell) => cell.lineCode),
    lineNames,
  );

  const take = (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  // Pruned top-down, never rejected: a bookmarked or hand-edited URL keeps as much as still makes
  // sense instead of silently dumping the viewer back to everything.
  const appliedLine = lineOptions.some((option) => option.code === take(options.geography?.line))
    ? take(options.geography?.line)
    : null;
  const regionOptions = optionsOf(
    cells.filter((cell) => !appliedLine || cell.lineCode === appliedLine).map((cell) => cell.regionCode),
    regionNames,
  );
  const appliedRegion = regionOptions.some((option) => option.code === take(options.geography?.region))
    ? take(options.geography?.region)
    : null;

  const geographyActive = Boolean(appliedLine || appliedRegion);
  // Matched on the person's CELLS, so a manager is reached exactly as a rep is — that is the whole
  // point of resolving every tier. Someone with no seat matches nothing and is added back below.
  const matches = (row: RepsPlansRepRow): boolean =>
    !geographyActive ||
    placementMatches(placementOf(row.agentHrId) ?? undefined, { line: appliedLine, region: appliedRegion });

  const inScope = allRows.filter(matches);
  const unplacedOutOfScope = geographyActive ? allRows.filter((row) => row.territories.length === 0) : [];
  const visibleRows = geographyActive ? [...inScope, ...unplacedOutOfScope] : allRows;

  // ONLY the scored rows. A manager in scope is visible above and absent here, by the owner's rule.
  const totals = totalsOf(inScope.filter((row) => row.scored), report.workingDays);
  // Both are 0 with no organogram: "37 people hold no seat" would be a claim about a chart nothing
  // managed to read, and the note under the tiles states these as facts about the org.
  const managersShown = orgAvailable ? visibleRows.filter((row) => !row.scored && row.territories.length > 0).length : 0;
  const unplacedShown = orgAvailable ? visibleRows.filter((row) => row.territories.length === 0).length : 0;

  const repOptions = visibleRows
    .map((row) => ({ repKey: row.repKey, repName: row.repName }))
    .sort((a, b) => a.repName.localeCompare(b.repName));
  const appliedRepKey =
    options.repKey && repOptions.some((option) => option.repKey === options.repKey) ? options.repKey : null;

  const geographyLabel =
    [
      appliedLine ? (lineNames.get(appliedLine) ?? appliedLine) : null,
      appliedRegion ? (regionNames.get(appliedRegion) ?? appliedRegion) : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ") || null;

  // The report's OWN dates, not the range's — the caption must describe the rows that were counted.
  // If the two ever disagree the fetch is what happened, and saying otherwise is the exact class of
  // "hilarious misleading" this picker was built to end.
  const range = options.range ?? null;
  return {
    month: options.month,
    monthLabel: monthLabelOfKey(options.month),
    dateFrom: report.dateFrom,
    dateTo: report.dateTo,
    isCurrentMonth: options.isCurrentMonth,
    periodKey: range?.periodKey ?? "month",
    periodLabel: range?.periodLabel ?? "Whole month",
    isWholeMonth: range?.isWholeMonth ?? true,
    notStarted: range?.notStarted ?? false,
    cappedAtToday: range ? !range.notStarted && report.dateTo < range.windowEnd : false,
    weekOptions: options.weekOptions ?? [],
    workingDays: report.workingDays,
    campaignLimit: report.campaignLimit,
    amTarget: AM_CALL_RATE_TARGET,
    pmTarget: PM_CALL_RATE_TARGET,
    totals,
    reps: appliedRepKey ? visibleRows.filter((row) => row.repKey === appliedRepKey) : visibleRows,
    repOptions,
    appliedRepKey,
    lineOptions,
    regionOptions,
    appliedLine,
    appliedRegion,
    geographyLabel,
    managersShown,
    unplacedShown,
    geographyAvailable: lineOptions.length > 0,
  };
}
