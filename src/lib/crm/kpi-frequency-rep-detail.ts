/**
 * ONE REP'S FREQUENCY, READ CLOSELY — the arithmetic behind the open rep's panel on the Frequency report
 * (premium pass of 9 November 2026; owner: "eyeball every report in My Team's Reports, premium polish big
 * work, every single component").
 *
 * What the pass found when a rep's doctors were opened on the Frequency page, read as the Regional Sales
 * Manager:
 *
 * - four tiles that said how many visits were asked for and made, and a verdict per doctor, but nothing that
 *   said HOW FAR below the norm the short doctors were: one visit short and three short read the same;
 * - nothing that said which doctors to go back to first, or how much one more visit each would move the
 *   figure;
 * - a by-grade list with no percentage and no owed visits, and nothing by speciality or by week.
 *
 * Pure: no database, no React, nothing server-side. IT ADDS NO MEASURE. Every count here is a count of the
 * doctor verdicts the server already stamped on this rep's list (`KpiCoverageDoctor.frequency`, see
 * `DoctorFrequency`), the very verdicts his row's percentage was counted from, so nothing here can disagree
 * with the row. A doctor PASSES exactly when his verdict is "exact" (the original rules, the only pass) or
 * "at-norm" (the Phoenix rules, rule 7). A doctor is JUDGED unless he is ungraded or not due yet.
 *
 * The one forward-looking line ("one more visit each to the doctors one visit short") applies the same pass
 * rule to the same list with those doctors' visits raised by one. It suggests where a visit counts most; it
 * changes nothing and scores nobody.
 */

import type { KpiCoverageDetail, KpiCoverageDoctor } from "@/lib/crm/kpis-board";
import {
  KPI_GRADE_GROUPS,
  KPI_NO_PLAN_WEEK,
  KPI_NO_SPECIALITY,
  kpiGradeGroupOf,
  kpiMonthWeekOf,
  kpiShortDay,
} from "@/lib/crm/kpi-coverage-rep-detail";
import type { DoctorFrequency, DoctorFrequencyStatus } from "@/lib/crm/phoenix-kpi-rules";

/** One doctor on the list, with the verdict the server stamped on him. */
export type KpiFrequencyRow = { doctor: KpiCoverageDoctor; frequency: DoctorFrequency };

/** The two verdicts that pass: exact on the plan, at the grade's norm. */
export function kpiFrequencyPasses(status: DoctorFrequencyStatus): boolean {
  return status === "exact" || status === "at-norm";
}

/** Every verdict but the two that cannot be judged yet: no grade, and every planned day still ahead. */
export function kpiFrequencyJudged(status: DoctorFrequencyStatus): boolean {
  return status !== "ungraded" && status !== "not-due";
}

/** The doctors on both lists who carry a verdict — the Frequency report's whole list for this rep. */
export function kpiFrequencyRowsOf(detail: Pick<KpiCoverageDetail, "covered" | "notCovered">): KpiFrequencyRow[] {
  return [...detail.covered, ...detail.notCovered].flatMap((doctor) =>
    doctor.frequency ? [{ doctor, frequency: doctor.frequency }] : [],
  );
}

/**
 * How far one doctor is from where the plan or the norm puts him: negative is short, positive is extra, zero
 * is on target, null where there is nothing to compare (not graded, or not due yet).
 *
 * On the plan basis the shortfall is measured against the calls that have COME DUE and the excess against the
 * WHOLE period's calls, for the reason `frequencyStatusOf` gives: a rep behind today's schedule can still
 * catch up, one who has gone past the month's total cannot undo it.
 */
export function kpiFrequencyGap(frequency: DoctorFrequency): number | null {
  if (frequency.required == null || frequency.status === "not-due" || frequency.status === "ungraded") return null;
  if (frequency.basis === "plan" && frequency.actual > frequency.required) return frequency.actual - frequency.required;
  return frequency.actual - (frequency.dueSoFar ?? frequency.required);
}

/** "2 short", "On target", "1 extra", "1 ahead" or "—" — the Gap column, the same words on screen and in the file. */
export function kpiFrequencyGapText(frequency: DoctorFrequency): string {
  const gap = kpiFrequencyGap(frequency);
  if (gap == null) return "—";
  if (gap === 0) return "On target";
  if (gap < 0) return `${Math.abs(gap)} short`;
  // Ahead of the schedule but inside the month's total: still exact, so it is not "extra".
  if (frequency.basis === "plan" && frequency.required != null && frequency.actual <= frequency.required) return `${gap} ahead`;
  return `${gap} extra`;
}

/** The visits a doctor is owed so far: what has come due and was not made. 0 when nothing is owed or nothing is asked. */
export function kpiFrequencyOwed(frequency: DoctorFrequency): number {
  if (frequency.required == null || frequency.status === "not-due" || frequency.status === "ungraded") return 0;
  return Math.max(0, (frequency.dueSoFar ?? frequency.required) - frequency.actual);
}

// ── The summary ──────────────────────────────────────────────────────────────────────────────

/** Every figure the panel's header prints, from the verdicts alone. */
export type KpiRepFrequencySummary = {
  /** Every doctor with a verdict. */
  doctors: number;
  /** Doctors who can be judged: everyone but the ungraded and the not due yet. */
  judged: number;
  passing: number;
  /** passing ÷ judged, rounded. Null when nobody can be judged yet — never 0%. */
  pct: number | null;
  /** Visits the plan or the norms ask for over the period, and how many of them have come due. */
  asked: number;
  due: number;
  /** Visits made to the doctors who are asked for something. */
  made: number;
  /** Visits due so far and not made. */
  owed: number;
  /** Visits beyond what was asked, over the doctors seen more often than asked. */
  extra: number;
  /** Doctors short of what has come due, and the doctors of them never visited at all. */
  short: number;
  neverVisited: number;
  ungraded: number;
  notDue: number;
  byStatus: ReadonlyMap<DoctorFrequencyStatus, number>;
};

/** Null when the rep has nobody on his list with a verdict — the panel then says so rather than 0%. */
export function kpiRepFrequencySummary(detail: Pick<KpiCoverageDetail, "covered" | "notCovered">): KpiRepFrequencySummary | null {
  const rows = kpiFrequencyRowsOf(detail);
  if (rows.length === 0) return null;
  let judged = 0;
  let passing = 0;
  let asked = 0;
  let due = 0;
  let made = 0;
  let owed = 0;
  let extra = 0;
  let short = 0;
  let neverVisited = 0;
  let ungraded = 0;
  let notDue = 0;
  const byStatus = new Map<DoctorFrequencyStatus, number>();
  for (const { frequency } of rows) {
    byStatus.set(frequency.status, (byStatus.get(frequency.status) ?? 0) + 1);
    if (frequency.status === "ungraded") ungraded += 1;
    if (frequency.status === "not-due") notDue += 1;
    if (kpiFrequencyJudged(frequency.status)) {
      judged += 1;
      if (kpiFrequencyPasses(frequency.status)) passing += 1;
    }
    if (frequency.required == null) continue;
    asked += frequency.required;
    due += frequency.dueSoFar ?? frequency.required;
    made += frequency.actual;
    const doctorOwed = kpiFrequencyOwed(frequency);
    owed += doctorOwed;
    if (doctorOwed > 0) {
      short += 1;
      if (frequency.actual === 0) neverVisited += 1;
    }
    extra += Math.max(0, frequency.actual - frequency.required);
  }
  return {
    doctors: rows.length,
    judged,
    passing,
    pct: judged > 0 ? Math.round((passing / judged) * 100) : null,
    asked,
    due,
    made,
    owed,
    extra,
    short,
    neverVisited,
    ungraded,
    notDue,
    byStatus,
  };
}

// ── How far short ────────────────────────────────────────────────────────────────────────────

export const KPI_SHORT_DEPTHS = ["one", "two", "three-plus", "never"] as const;
export type KpiShortDepth = (typeof KPI_SHORT_DEPTHS)[number];

export const KPI_SHORT_DEPTH_LABEL: Record<KpiShortDepth, string> = {
  one: "1 visit short",
  two: "2 visits short",
  "three-plus": "3 or more short",
  never: "Due and never visited",
};

/**
 * A short doctor's depth: never visited (the deepest — not one visit yet), or one, two, three or more visits
 * short of what has come due. Null for a doctor who owes nothing.
 */
export function kpiShortDepthOf(frequency: DoctorFrequency): KpiShortDepth | null {
  const owed = kpiFrequencyOwed(frequency);
  if (owed === 0) return null;
  if (frequency.actual === 0) return "never";
  if (owed === 1) return "one";
  if (owed === 2) return "two";
  return "three-plus";
}

export type KpiShortBucket = { depth: KpiShortDepth; label: string; rows: KpiFrequencyRow[]; owed: number };

/**
 * The short doctors in four depths, the closest to the pass first. Every short doctor lands in exactly one
 * bucket, so the counts add up to the summary's `short` and the owed visits to its `owed`.
 */
export function kpiShortDepths(detail: Pick<KpiCoverageDetail, "covered" | "notCovered">): KpiShortBucket[] {
  const buckets = new Map<KpiShortDepth, KpiFrequencyRow[]>(KPI_SHORT_DEPTHS.map((depth) => [depth, []]));
  for (const row of kpiFrequencyRowsOf(detail)) {
    const depth = kpiShortDepthOf(row.frequency);
    if (depth) buckets.get(depth)!.push(row);
  }
  return KPI_SHORT_DEPTHS.map((depth) => {
    const rows = buckets.get(depth)!;
    return { depth, label: KPI_SHORT_DEPTH_LABEL[depth], rows, owed: rows.reduce((sum, row) => sum + kpiFrequencyOwed(row.frequency), 0) };
  });
}

/**
 * ONE MORE VISIT EACH — what the rep's figure would read if every doctor exactly one visit short got that
 * visit, by the same pass rule over the same list. Null when nobody is one visit short, or nobody can be
 * judged. A doctor never visited is not in it: one visit to an A doctor asked for three does not pass him.
 */
export function kpiOneMoreVisitLift(summary: KpiRepFrequencySummary, buckets: readonly KpiShortBucket[]): { doctors: number; pct: number } | null {
  const one = buckets.find((bucket) => bucket.depth === "one");
  const never = buckets.find((bucket) => bucket.depth === "never");
  // A never-visited doctor asked for exactly one visit passes with one visit too, so he counts here.
  const neverOnOne = never ? never.rows.filter((row) => kpiFrequencyOwed(row.frequency) === 1).length : 0;
  const doctors = (one?.rows.length ?? 0) + neverOnOne;
  if (doctors === 0 || summary.judged === 0) return null;
  return { doctors, pct: Math.round(((summary.passing + doctors) / summary.judged) * 100) };
}

// ── Who to go back to first ──────────────────────────────────────────────────────────────────

function gradeRank(doctor: KpiCoverageDoctor): number {
  return (KPI_GRADE_GROUPS as readonly string[]).indexOf(kpiGradeGroupOf(doctor.grade));
}

export type KpiFrequencyStep = KpiFrequencyRow & {
  owed: number;
  /** The planned days still ahead of `asOf`, earliest first — when the plan already brings him back. */
  ahead: string[];
};

/**
 * WHO TO GO BACK TO FIRST — the short doctors in the order a manager would send the rep: the ones a single
 * visit passes first (the cheapest pass on the list), then by grade (A before B before C), then the most
 * owed, then by name. `limit` caps the list for the panel; the table below still holds every doctor.
 *
 * It suggests an order over his own list and changes nothing: the doctors and the visits asked for are his
 * plan's or his doctors' grades.
 */
export function kpiFrequencyFirstSteps(
  detail: Pick<KpiCoverageDetail, "covered" | "notCovered">,
  asOf: string,
  limit = 8,
): KpiFrequencyStep[] {
  return kpiFrequencyRowsOf(detail)
    .map((row) => ({
      ...row,
      owed: kpiFrequencyOwed(row.frequency),
      ahead: row.doctor.planDates.filter((day) => day > asOf).sort(),
    }))
    .filter((step) => step.owed > 0)
    .sort(
      (left, right) =>
        Number(left.owed !== 1) - Number(right.owed !== 1) ||
        gradeRank(left.doctor) - gradeRank(right.doctor) ||
        right.owed - left.owed ||
        (left.doctor.name ?? "~").localeCompare(right.doctor.name ?? "~"),
    )
    .slice(0, Math.max(0, limit));
}

/** "1 short · 2 of 3 made · next planned 12 Nov" — why this doctor is on the list, in one line. */
export function kpiFrequencyStepWhy(step: KpiFrequencyStep): string {
  const asked = step.frequency.dueSoFar ?? step.frequency.required ?? 0;
  const made = step.frequency.actual === 0 ? "never visited" : `${step.frequency.actual} of ${asked} made`;
  const next = step.ahead[0] ? `next planned ${kpiShortDay(step.ahead[0]) ?? step.ahead[0]}` : null;
  const last = step.doctor.lastVisitDate ? `last ${kpiShortDay(step.doctor.lastVisitDate) ?? step.doctor.lastVisitDate}` : null;
  return [`${step.owed} short`, made, next ?? last].filter(Boolean).join(" · ");
}

// ── The breakdowns ───────────────────────────────────────────────────────────────────────────

/** One group of the rep's doctors, with every figure the breakdown tables print. */
export type KpiFrequencyGroup = {
  label: string;
  doctors: number;
  judged: number;
  passing: number;
  /** passing ÷ judged, rounded; null when nobody in the group can be judged. */
  pct: number | null;
  asked: number;
  made: number;
  owed: number;
  short: number;
};

function emptyGroup(label: string): KpiFrequencyGroup {
  return { label, doctors: 0, judged: 0, passing: 0, pct: null, asked: 0, made: 0, owed: 0, short: 0 };
}

function addRow(group: KpiFrequencyGroup, { frequency }: KpiFrequencyRow): void {
  group.doctors += 1;
  if (kpiFrequencyJudged(frequency.status)) {
    group.judged += 1;
    if (kpiFrequencyPasses(frequency.status)) group.passing += 1;
  }
  if (frequency.required != null) {
    group.asked += frequency.required;
    group.made += frequency.actual;
  }
  const owed = kpiFrequencyOwed(frequency);
  group.owed += owed;
  if (owed > 0) group.short += 1;
}

function finishGroup(group: KpiFrequencyGroup): KpiFrequencyGroup {
  return { ...group, pct: group.judged > 0 ? Math.round((group.passing / group.judged) * 100) : null };
}

/**
 * The rep's doctors cut by `keyOf`. `order` fixes the order (grades A, B, C, none); without it the group with
 * the most owed visits leads, then the larger, then alphabetically. Every doctor is in exactly one group, so
 * the groups add up to the summary.
 */
export function kpiFrequencyGroups(
  rows: readonly KpiFrequencyRow[],
  keyOf: (doctor: KpiCoverageDoctor) => string,
  order?: readonly string[],
): KpiFrequencyGroup[] {
  const groups = new Map<string, KpiFrequencyGroup>();
  for (const row of rows) {
    const label = keyOf(row.doctor);
    const group = groups.get(label) ?? emptyGroup(label);
    addRow(group, row);
    groups.set(label, group);
  }
  const finished = [...groups.values()].map(finishGroup);
  if (order) {
    const rank = (label: string) => {
      const index = order.indexOf(label);
      return index === -1 ? order.length : index;
    };
    return finished.sort((left, right) => rank(left.label) - rank(right.label) || left.label.localeCompare(right.label));
  }
  return finished.sort(
    (left, right) => right.owed - left.owed || right.doctors - left.doctors || left.label.localeCompare(right.label),
  );
}

export function kpiFrequencyByGrade(detail: Pick<KpiCoverageDetail, "covered" | "notCovered">): KpiFrequencyGroup[] {
  return kpiFrequencyGroups(kpiFrequencyRowsOf(detail), (doctor) => kpiGradeGroupOf(doctor.grade), KPI_GRADE_GROUPS);
}

export function kpiFrequencyBySpeciality(detail: Pick<KpiCoverageDetail, "covered" | "notCovered">): KpiFrequencyGroup[] {
  return kpiFrequencyGroups(kpiFrequencyRowsOf(detail), (doctor) => doctor.speciality?.trim() || KPI_NO_SPECIALITY);
}

/** One week of the month with the doctors FIRST planned in it — the Coverage page's own weeks. */
export type KpiFrequencyWeek = KpiFrequencyGroup & { key: string; ahead: boolean };

/**
 * The rep's doctors by the week of their FIRST planned day, in calendar order, the doctors booked on no day
 * last — the same seven-day weeks as the Coverage page's week table and the Reps Plans period picker. A doctor
 * booked in several weeks counts once, in the first, so the weeks add up to the summary.
 */
export function kpiFrequencyByWeek(detail: Pick<KpiCoverageDetail, "covered" | "notCovered">, asOf: string): KpiFrequencyWeek[] {
  const weeks = new Map<string, KpiFrequencyWeek>();
  for (const row of kpiFrequencyRowsOf(detail)) {
    const first = [...row.doctor.planDates].sort()[0];
    const week = first ? kpiMonthWeekOf(first) : null;
    const key = week?.key ?? "none";
    const entry = weeks.get(key) ?? { ...emptyGroup(week?.label ?? KPI_NO_PLAN_WEEK), key, ahead: week ? week.from > asOf : false };
    addRow(entry, row);
    weeks.set(key, entry);
  }
  return [...weeks.values()]
    .map((week) => ({ ...week, ...finishGroup(week), key: week.key, ahead: week.ahead }))
    .sort((left, right) => (left.key === "none" ? 1 : right.key === "none" ? -1 : left.key.localeCompare(right.key)));
}

/**
 * The sentence under the rep's tiles: where he stands, in words a manager reads aloud. Never a pass mark —
 * frequency has no floor — only what is owed and what one more visit each would do.
 */
export function kpiFrequencySentence(
  summary: KpiRepFrequencySummary,
  lift: { doctors: number; pct: number } | null,
  phoenix: boolean,
): string {
  const doctors = (count: number) => `${count} doctor${count === 1 ? "" : "s"}`;
  const visits = (count: number) => `${count} visit${count === 1 ? "" : "s"}`;
  if (summary.judged === 0) {
    return phoenix
      ? "Nobody on this list can be judged yet: every planned doctor is ungraded."
      : "Nobody on this list can be judged yet: every planned day is still ahead.";
  }
  const pass = phoenix ? "at their grade's norm" : "visited exactly as planned";
  const head = `${summary.passing} of ${doctors(summary.judged)} judged are ${pass}.`;
  if (summary.short === 0) {
    return summary.extra > 0 && !phoenix
      ? `${head} Nobody is short; the deviations are doctors seen more often than planned.`
      : `${head} Nobody is short of what has come due.`;
  }
  const owedLine = `${doctors(summary.short)} ${summary.short === 1 ? "is" : "are"} short, ${visits(summary.owed)} owed in all${
    summary.neverVisited > 0 ? `, ${summary.neverVisited} of them never visited` : ""
  }.`;
  if (!lift) return `${head} ${owedLine}`;
  return `${head} ${owedLine} One more visit each to the ${doctors(lift.doctors)} one visit short lifts frequency to ${lift.pct}%.`;
}
