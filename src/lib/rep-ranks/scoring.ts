// Phoenix Ranks — the scoring rule. PURE: no database, no clock, no async.
//
// OWNER, 2026-10-05: one board shared by every medical rep "whatever was the line", scoring
// "accuracy, timing, number of visits, KPIs, sticking to plan" and making it "perfectly clear to the
// rep himself why I am not number one, why I am number one". His answers the same day:
//   * EQUAL WEIGHTS, printed on the page.
//   * Field accuracy IS scored and IS visible — as ONE score. "Don't put metrics … the metrics keep
//     in your back end or show it to the admin account. But for the reps, only accuracy score."
//   * Sales are NOT part of the rank ("Never — field work only"); Sales Rankings stays where it is.
//   * Every rep sees every other rep's whole breakdown.
//   * "also am start time" — the AM start is its own pillar.
//
// FAIR ACROSS LINES BY CONSTRUCTION: every pillar is a percentage of the rep's OWN target or plan,
// so a CNS rep and a Pedia rep compete on discipline, never on list size.
//
// PHOENIX CRM ONLY (owner, 2026-10-05: "all data in phoenix crm not ever any data from old crm").
// Every count is Phoenix CRM's own — its countable visits, its lists and grade targets, its plans,
// the rep's own "I started working" press, its place check. Nothing from iReports360, the KPIs
// board or Early Birds reaches this file. The call-rate targets are Phoenix CRM's locked settings
// (AM 2, PM 10), kept APART as two pillars and never averaged. Coverage and frequency are monthly
// ideas measured over ANY duration ("we can measure it by weekly … it thinks monthly"): the month's
// expectation is prorated to the rep's own working days in the window (rank-facts.ts).

import { qualityScores, type RankQualityFacts } from "@/lib/rep-ranks/field-quality";

// Version 4 (owner, 2026-10-05): the five deeper measures from field-quality.ts join the average.
export const REP_RANKS_SCORING_VERSION = 4;

export type RankPillarKey =
  | "amCallRate"
  | "pmCallRate"
  | "coverage"
  | "frequency"
  | "plan"
  | "amStart"
  | "consistency"
  | "fieldAccuracy"
  | "visitGaps"
  | "productsPerVisit"
  | "visitNotes"
  | "gpsPrecision"
  | "integrity";

export type RankPillarDefinition = {
  key: RankPillarKey;
  label: string;
  /** One sentence the rep reads: what earns the points. */
  explains: string;
  /** A bonus on top of the average rather than one of the averaged measures. */
  bonus?: true;
};

/**
 * The order every screen prints them in: the seven measures first ranked on, the five deeper ones the
 * owner added the same day (each worth exactly the same), then the bonus.
 */
export const RANK_PILLARS: readonly RankPillarDefinition[] = [
  { key: "amCallRate", label: "AM call rate", explains: "AM visits per working day against the target of 2. Two a day is full marks." },
  { key: "pmCallRate", label: "PM call rate", explains: "PM visits per working day against the target of 10. Ten a day is full marks." },
  { key: "coverage", label: "Coverage", explains: "Share of your AM and PM list visited at least once, against the share a month's pace asks for by now." },
  { key: "frequency", label: "Frequency", explains: "Visits each graded customer received against what the grade asks for, at a month's pace. Extra visits beyond the grade earn nothing." },
  { key: "plan", label: "Sticking to plan", explains: "Planned visits made on their planned day, out of the planned visits due. No plan scores zero." },
  { key: "consistency", label: "Days in the field", explains: "Working days with a visit logged, out of your working days in the period. Approved leave and holidays are not counted." },
  { key: "fieldAccuracy", label: "Field accuracy", explains: "How accurately visits are recorded in the field." },
  {
    key: "visitGaps",
    label: "Time between visits",
    explains:
      "The time from one visit to the next against what it should take: the walk between the two places, a 10 to 30 minute wait and a 5 to 10 minute visit. Much faster or much slower scores less. Breaks over 3 hours and the change from AM to PM are not counted.",
  },
  { key: "productsPerVisit", label: "Products per visit", explains: "Products discussed per doctor visit. Three a visit is full marks." },
  { key: "visitNotes", label: "Visit notes", explains: "Share of doctor visits saved with a written comment or a voice note." },
  {
    key: "gpsPrecision",
    label: "GPS precision",
    explains: "How precise your phone's location is when you save a visit. 20 metres or better is full marks; 200 metres or worse earns none.",
  },
  // Owner, 2026-10-05: integrity is in the score and "admin sees detail". The rep reads this one
  // number and this one sentence, never which check a save failed: naming the check teaches what to
  // defeat (location-integrity.ts, "the rep is never told").
  { key: "integrity", label: "Integrity", explains: "Whether your visit records pass the system's checks for genuine field work. A clean record is full marks." },
  // Last on every screen: the twelve averaged measures read together, then the bonus on top of them.
  {
    key: "amStart",
    label: "AM start bonus",
    explains: "Up to 5 points on top of the average. Each working day you press I started working by 08:00 earns its full share; 12:00 earns none. A day without a press costs nothing.",
    bonus: true,
  },
];

export const RANK_PILLAR_LABELS: Record<RankPillarKey, string> = Object.fromEntries(
  RANK_PILLARS.map((pillar) => [pillar.key, pillar.label]),
) as Record<RankPillarKey, string>;

/**
 * AM START IS A BONUS, NOT AN AVERAGED MEASURE (owner, 2026-10-05, on seeing that pressing lowered a
 * rep's score: "suppose that he forgot, but he made his visits. So give it a bonus, but do not make
 * it zero for the whole AM"). The press is optional, so it can only ADD: up to this many points on
 * top of the average of the other measures, earned day by day; a day without a press earns nothing and
 * takes nothing away. 08:00 scores 100, 12:00 scores 0 — Early Birds' span, on the rep's own press.
 */
export const RANK_START_BONUS_MAX = 5;
/** A 0-100 AM start score as the bonus points it adds, one decimal: 46 → 2.3. */
export function startBonusPoints(score: number | null): number {
  return score === null ? 0 : Math.round((score / 100) * RANK_START_BONUS_MAX * 10) / 10;
}
export const RANK_START_BEST_MINUTES = 8 * 60;
export const RANK_START_WORST_MINUTES = 12 * 60;

/** Fewest days with field work before a window ranks anyone. Below it the rep is listed, unranked. */
export const RANK_MIN_ACTIVE_DAYS: Record<"day" | "week" | "month" | "quarter" | "semester", number> = {
  day: 1,
  week: 2,
  month: 5,
  quarter: 12,
  semester: 24,
};

/** What one rep brings to one window, all from Phoenix CRM. Raw counts — the admin twin prints them, the rep never sees them. */
export type RankRepFacts = {
  hrIdKey: string;
  repName: string;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  /** Working days (Sat-Wed, holidays out) from the rep's start, less full days of approved leave. */
  owedDays: number;
  targets: { am: number; pm: number };
  /** Countable visits to validated customers on owed days. */
  amVisits: number;
  pmVisits: number;
  /** Owed days with at least one AM or PM visit. */
  fieldDays: number;
  /** Prorated coverage; null when there is no owed day. */
  coverage: { pct: number; listed: number; covered: number } | null;
  /** Prorated frequency; null when no listed customer carries a grade target. */
  frequency: { pct: number; required: number; met: number } | null;
  plan: { planned: number; kept: number };
  /** The presses on owed days: their median clock, how many, and the sum of their 0-100 start scores. */
  start: { medianMinutes: number | null; days: number; scoreSum: number };
  /** Visits measured against their place (`location_flag` ok/far/weak_gps), and those at the place. */
  accuracy: { located: number; atPlace: number };
  /** The deeper facts: gaps, products, notes, GPS fixes, integrity (field-quality.ts). */
  quality: RankQualityFacts;
};

export type RankPillarScores = Record<RankPillarKey, number | null>;

export type RankUnrankedReason = "no_field_work" | "too_few_days" | "no_working_days";

export const RANK_UNRANKED_REASON_TEXT: Record<RankUnrankedReason, string> = {
  no_field_work: "No field work logged in this period.",
  too_few_days: "Too few days in the field in this period to rank fairly.",
  no_working_days: "No working day in this period yet.",
};

export type RankStanding = {
  hrIdKey: string;
  repName: string;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  pillars: RankPillarScores;
  /** Mean of the scored pillars, 0-100, two decimals. Null when unranked. */
  total: number | null;
  ranked: boolean;
  unrankedReason: RankUnrankedReason | null;
  companyPosition: number | null;
  companyCount: number;
  linePosition: number | null;
  lineCount: number;
  facts: RankRepFacts;
};

const clamp100 = (value: number): number => (value < 0 ? 0 : value > 100 ? 100 : value);
const round0 = (value: number): number => Math.round(value);
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function startScore(medianStartMinutes: number | null): number {
  if (medianStartMinutes === null || !Number.isFinite(medianStartMinutes)) return 0;
  const span = RANK_START_WORST_MINUTES - RANK_START_BEST_MINUTES;
  return clamp100(((RANK_START_WORST_MINUTES - medianStartMinutes) / span) * 100);
}

/**
 * The thirteen pillar scores, each 0-100.
 *
 * A missing measure is NOT a free pass — no plan scores 0 on the plan, no list scores 0 on coverage.
 * Field accuracy with no visit measured against a place is left OUT of the mean: nothing to judge,
 * and so is each deeper measure with nothing to judge (no pair of stops, no fix).
 * AM start is never in the mean at all: it is the bonus share (RANK_START_BONUS_MAX).
 */
export function pillarScores(facts: RankRepFacts): RankPillarScores {
  const owed = facts.owedDays;
  const rate = (visits: number, target: number) => (owed > 0 && target > 0 ? round0(clamp100((visits / (target * owed)) * 100)) : null);
  return {
    amCallRate: rate(facts.amVisits, facts.targets.am),
    pmCallRate: rate(facts.pmVisits, facts.targets.pm),
    coverage: owed > 0 && facts.coverage ? round0(clamp100(facts.coverage.pct)) : null,
    frequency: owed > 0 && facts.frequency ? round0(clamp100(facts.frequency.pct)) : null,
    plan: owed > 0 ? (facts.plan.planned > 0 ? round0(clamp100((facts.plan.kept / facts.plan.planned) * 100)) : 0) : null,
    // Share of the bonus earned: the day-by-day start scores over the owed days, a day with no press at 0.
    amStart: owed > 0 ? round0(clamp100(facts.start.scoreSum / owed)) : null,
    consistency: owed > 0 ? round0(clamp100((facts.fieldDays / owed) * 100)) : null,
    fieldAccuracy: facts.accuracy.located > 0 ? round0(clamp100((facts.accuracy.atPlace / facts.accuracy.located) * 100)) : null,
    ...qualityScores(facts.quality),
  };
}

const isBonus = (key: string): boolean => RANK_PILLARS.some((pillar) => pillar.key === key && pillar.bonus);

/** Points the AM start bonus adds to the total. */
export function startBonusOf(pillars: RankPillarScores): number {
  return round2(((pillars.amStart ?? 0) / 100) * RANK_START_BONUS_MAX);
}

/** The mean of the scored measures (equal weights), plus the AM start bonus; never above 100. */
export function totalOf(pillars: RankPillarScores): number | null {
  const scored = Object.entries(pillars)
    .filter(([key, value]) => !isBonus(key) && value !== null)
    .map(([, value]) => value as number);
  if (scored.length === 0) return null;
  return round2(Math.min(100, scored.reduce((sum, value) => sum + value, 0) / scored.length + startBonusOf(pillars)));
}

/** How many measures the average is over — the bonus is not one of them. */
export function scoredPillarCount(pillars: RankPillarScores): number {
  return Object.entries(pillars).filter(([key, value]) => !isBonus(key) && value !== null).length;
}

function unrankedReasonOf(facts: RankRepFacts, windowKind: keyof typeof RANK_MIN_ACTIVE_DAYS): RankUnrankedReason | null {
  if (facts.owedDays <= 0) return "no_working_days";
  if (facts.amVisits + facts.pmVisits === 0) return "no_field_work";
  // A rep who started part-way through a window owes fewer days; the bar is never above what they owed.
  if (facts.fieldDays < Math.min(RANK_MIN_ACTIVE_DAYS[windowKind], facts.owedDays)) return "too_few_days";
  return null;
}

/** Higher total first; then PM call rate, AM call rate, and finally the name, so nothing is random. */
export function compareStandings(a: RankStanding, b: RankStanding): number {
  const total = (b.total ?? -1) - (a.total ?? -1);
  if (total !== 0) return total;
  const pm = (b.pillars.pmCallRate ?? -1) - (a.pillars.pmCallRate ?? -1);
  if (pm !== 0) return pm;
  const am = (b.pillars.amCallRate ?? -1) - (a.pillars.amCallRate ?? -1);
  if (am !== 0) return am;
  return a.repName.localeCompare(b.repName);
}

export const LINE_NOT_RECORDED = "Line not recorded";

/**
 * Scores and ranks one window. Ranked reps first in rank order, then the unranked by name. Company
 * position is over every ranked rep; line position over the ranked reps of the same line.
 */
export function rankWindow(
  allFacts: readonly RankRepFacts[],
  windowKind: keyof typeof RANK_MIN_ACTIVE_DAYS,
): RankStanding[] {
  const standings: RankStanding[] = allFacts.map((facts) => {
    const pillars = pillarScores(facts);
    const unrankedReason = unrankedReasonOf(facts, windowKind);
    return {
      hrIdKey: facts.hrIdKey,
      repName: facts.repName,
      lineName: facts.lineName,
      areaName: facts.areaName,
      regionName: facts.regionName,
      pillars,
      total: unrankedReason ? null : totalOf(pillars),
      ranked: unrankedReason === null,
      unrankedReason,
      companyPosition: null,
      companyCount: 0,
      linePosition: null,
      lineCount: 0,
      facts,
    };
  });

  const ranked = standings.filter((standing) => standing.ranked).sort(compareStandings);
  const unranked = standings.filter((standing) => !standing.ranked).sort((a, b) => a.repName.localeCompare(b.repName));

  const lineCounts = new Map<string, number>();
  for (const standing of ranked) {
    const line = standing.lineName ?? LINE_NOT_RECORDED;
    lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  }
  const lineSeen = new Map<string, number>();
  ranked.forEach((standing, index) => {
    const line = standing.lineName ?? LINE_NOT_RECORDED;
    const position = (lineSeen.get(line) ?? 0) + 1;
    lineSeen.set(line, position);
    standing.companyPosition = index + 1;
    standing.companyCount = ranked.length;
    standing.linePosition = position;
    standing.lineCount = lineCounts.get(line) ?? 0;
  });
  for (const standing of unranked) {
    standing.companyCount = ranked.length;
    standing.lineCount = lineCounts.get(standing.lineName ?? LINE_NOT_RECORDED) ?? 0;
  }
  return [...ranked, ...unranked];
}

/** Median of a list of minutes, or null. */
export function medianMinutes(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** "08:42" from minutes past midnight. */
export function clockOf(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}
