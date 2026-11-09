/**
 * ONE REP'S COVERAGE, READ CLOSELY — the arithmetic behind the open rep's panel on the Coverage report
 * (premium pass of 9 November 2026; owner: "eyeball every report in My Team's Reports, premium polish big
 * work, every single component").
 *
 * What the pass found when a rep's doctors were opened, read as the Regional Sales Manager:
 *
 * - four tiles that said where he IS (coverage, covered, late, not due yet) and one sentence that said how
 *   far he is from the 95% floor, but nothing that said WHO he has to see to get there;
 * - a "Late" figure with no age: a doctor whose only planned day was yesterday and one planned three weeks
 *   ago read the same;
 * - the grade breakdown in alphabetical order with no late count, so "Grade A · 80%" could not say whether
 *   the missing fifth were overdue or simply planned for next week;
 * - nothing by week, so a rep who covered the first fortnight and stopped looked the same as one who
 *   spread his misses across the month.
 *
 * Pure: no database, no React, nothing server-side. IT ADDS NO MEASURE. Every count is a count of the two
 * lists the server built for this rep (`KpiCoverageDetail`), the same lists whose lengths are his row's
 * Covered and Not reached, so nothing here can disagree with the row. A doctor is LATE exactly when the
 * list says `due` and he has no visit; NOT DUE YET exactly when every planned day is still ahead. The floor
 * is the board's own `coverageFloorPct`.
 */

import type { KpiCoverageDetail, KpiCoverageDoctor } from "@/lib/crm/kpis-board";
import { KPI_DOCTOR_NO_SPECIALITY_LABEL, kpiDoctorGradeGroup } from "@/lib/crm/kpis-doctor-filters";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Dates, by string arithmetic ──────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier), or null when either is not a
 * date. Both sides are read as UTC midnight, so no time zone can move a day: the answer is the same on
 * the laptop in Cairo, on Railway in Europe and in CI.
 */
export function kpiDaysBetween(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  const from = ISO_DAY.exec(fromIso ?? "");
  const to = ISO_DAY.exec(toIso ?? "");
  if (!from || !to) return null;
  const start = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]));
  const end = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]));
  return Math.round((end - start) / 86_400_000);
}

/** "3 Nov" — the board's own short day, never with the year (the header names the month). */
export function kpiShortDay(iso: string | null | undefined): string | null {
  const match = ISO_DAY.exec(iso ?? "");
  if (!match) return null;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]}`;
}

/** The planned days that have come by `asOf`, earliest first. Those are the days a late doctor missed. */
export function kpiMissedPlanDays(doctor: Pick<KpiCoverageDoctor, "planDates">, asOf: string): string[] {
  return doctor.planDates.filter((day) => day <= asOf).sort();
}

// ── The summary ──────────────────────────────────────────────────────────────────────────────

/** Every figure the panel's header prints, from the two lists alone. */
export type KpiRepCoverageSummary = {
  planned: number;
  covered: number;
  /** Not covered, with a planned day already passed. */
  late: number;
  /** Not covered, every planned day still ahead. */
  notDue: number;
  /** covered ÷ planned, rounded — the figure on his row. */
  pct: number;
  floorPct: number;
  /** The fewest covered doctors that clear the floor: ⌈planned × floor ÷ 100⌉. */
  floorTarget: number;
  /** How many more he must cover to clear it. 0 once he has. */
  needed: number;
  meetsFloor: boolean;
  /**
   * How many LATE doctors he must still catch up even if he sees every doctor not due yet. 0 means the
   * doctors still ahead of him are enough on their own; more than 0 means the floor now needs him to go
   * back for doctors he already missed.
   */
  catchUp: number;
  /** Every visit to a covered doctor in the window. */
  visits: number;
  /** Covered doctors seen exactly once, twice, and three times or more. Adds up to `covered`. */
  seenOnce: number;
  seenTwice: number;
  seenThreePlus: number;
};

/** Null when the rep planned nobody — there is no denominator, and the panel says so rather than 0%. */
export function kpiRepCoverageSummary(detail: KpiCoverageDetail, floorPct: number): KpiRepCoverageSummary | null {
  const planned = detail.covered.length + detail.notCovered.length;
  if (planned === 0) return null;
  const covered = detail.covered.length;
  const notDue = detail.notCovered.filter((doctor) => !doctor.due).length;
  const late = detail.notCovered.length - notDue;
  const floorTarget = Math.ceil((planned * floorPct) / 100);
  const needed = Math.max(0, floorTarget - covered);
  let visits = 0;
  let seenOnce = 0;
  let seenTwice = 0;
  let seenThreePlus = 0;
  for (const doctor of detail.covered) {
    visits += doctor.visits;
    if (doctor.visits >= 3) seenThreePlus += 1;
    else if (doctor.visits === 2) seenTwice += 1;
    else seenOnce += 1;
  }
  return {
    planned,
    covered,
    late,
    notDue,
    pct: Math.round((covered / planned) * 100),
    floorPct,
    floorTarget,
    needed,
    meetsFloor: needed === 0,
    catchUp: Math.max(0, needed - notDue),
    visits,
    seenOnce,
    seenTwice,
    seenThreePlus,
  };
}

/** The sentence under the tiles: where he stands against the floor, in words a manager reads aloud. */
export function kpiFloorSentence(summary: KpiRepCoverageSummary): string {
  const { covered, floorPct, floorTarget, needed, notDue, catchUp, planned } = summary;
  if (needed === 0) {
    const spare = covered - floorTarget;
    return spare > 0
      ? `Clears the ${floorPct}% floor: ${covered} of ${planned} covered, ${spare} more than the ${floorTarget} it takes.`
      : `Clears the ${floorPct}% floor exactly: ${covered} of ${planned} covered.`;
  }
  const doctors = (count: number) => `${count} doctor${count === 1 ? "" : "s"}`;
  const head = `${doctors(needed)} short of the ${floorPct}% floor (${floorTarget} of ${planned}).`;
  if (catchUp === 0) {
    return needed === notDue
      ? `${head} Seeing every doctor still due clears it.`
      : `${head} Seeing ${needed} of the ${notDue} doctors still due clears it.`;
  }
  if (notDue === 0) return `${head} Every planned day has passed, so the late list is the only way there.`;
  const stillDue = notDue === 1 ? "the one doctor still due" : notDue === 2 ? "both doctors still due" : `all ${notDue} doctors still due`;
  return `${head} Even with ${stillDue}, ${doctors(catchUp)} must come from the late list.`;
}

// ── How late ─────────────────────────────────────────────────────────────────────────────────

export const KPI_LATE_AGES = ["this-week", "last-week", "older"] as const;
export type KpiLateAge = (typeof KPI_LATE_AGES)[number];

export const KPI_LATE_AGE_LABEL: Record<KpiLateAge, string> = {
  "this-week": "Missed in the last 7 days",
  "last-week": "Missed 8 to 14 days ago",
  older: "Missed more than 14 days ago",
};

/**
 * A late doctor's age: the days since the LAST planned day that has come — his most recent missed
 * chance. 0 is today, 6 is a week ago. Null for a doctor who is not late.
 */
export function kpiLateDays(doctor: KpiCoverageDoctor, asOf: string): number | null {
  if (doctor.visits > 0 || !doctor.due) return null;
  const missed = kpiMissedPlanDays(doctor, asOf);
  const last = missed.at(-1);
  if (!last) return null;
  return kpiDaysBetween(last, asOf);
}

export function kpiLateAgeOf(days: number): KpiLateAge {
  if (days <= 6) return "this-week";
  if (days <= 13) return "last-week";
  return "older";
}

export type KpiLateBucket = { age: KpiLateAge; label: string; doctors: KpiCoverageDoctor[] };

/**
 * The late doctors in three ages, freshest first. Every late doctor lands in exactly one bucket, so the
 * three counts add up to the Late tile. A late doctor whose planned days cannot be read (no date the list
 * could parse) counts as the oldest, never as fresh — a missing date must not soften a miss.
 */
export function kpiLateAgeing(detail: KpiCoverageDetail, asOf: string): KpiLateBucket[] {
  const buckets = new Map<KpiLateAge, KpiCoverageDoctor[]>(KPI_LATE_AGES.map((age) => [age, []]));
  for (const doctor of detail.notCovered) {
    if (!doctor.due) continue;
    const days = kpiLateDays(doctor, asOf);
    buckets.get(days == null ? "older" : kpiLateAgeOf(days))!.push(doctor);
  }
  return KPI_LATE_AGES.map((age) => ({ age, label: KPI_LATE_AGE_LABEL[age], doctors: buckets.get(age)! }));
}

// ── Who to see first ─────────────────────────────────────────────────────────────────────────

/** Grade A first, then B, then C, then a doctor with no grade on the plan. */
export const KPI_GRADE_GROUPS = ["Grade A", "Grade B", "Grade C", "No grade"] as const;

/**
 * A doctor's grade group — the doctor filter's own `kpiDoctorGradeGroup`, so a group row here and the
 * filter's Grade choice name the same doctors, and a link from one opens the other.
 */
export function kpiGradeGroupOf(grade: string | null | undefined): string {
  return kpiDoctorGradeGroup(grade ?? null);
}

function gradeRank(doctor: KpiCoverageDoctor): number {
  return (KPI_GRADE_GROUPS as readonly string[]).indexOf(kpiGradeGroupOf(doctor.grade));
}

export type KpiFloorPathStep = {
  doctor: KpiCoverageDoctor;
  /** True when this doctor is already late; false when his planned day is still ahead. */
  late: boolean;
  /** For a late doctor, the planned days he missed; for one not due yet, his next planned day. */
  days: string[];
};

/**
 * THE SHORTEST WAY TO THE FLOOR — exactly `needed` doctors from the not-covered list, in the order a
 * manager would send the rep: the doctors already late first (grade A before B before C, then the one
 * missed most often, then the oldest miss, then by name), and after them the doctors not due yet, by
 * their next planned day. Empty once he clears the floor.
 *
 * It suggests an order, it changes nothing: the doctors are his own plan's, and seeing any `needed` of
 * them clears the floor just as well.
 */
export function kpiFloorPath(detail: KpiCoverageDetail, summary: KpiRepCoverageSummary, asOf: string): KpiFloorPathStep[] {
  if (summary.needed === 0) return [];
  const late = detail.notCovered
    .filter((doctor) => doctor.due)
    .map((doctor) => ({ doctor, days: kpiMissedPlanDays(doctor, asOf) }))
    .sort(
      (left, right) =>
        gradeRank(left.doctor) - gradeRank(right.doctor) ||
        right.days.length - left.days.length ||
        (left.days[0] ?? "9999").localeCompare(right.days[0] ?? "9999") ||
        (left.doctor.name ?? "~").localeCompare(right.doctor.name ?? "~"),
    )
    .map((entry) => ({ ...entry, late: true }));
  const ahead = detail.notCovered
    .filter((doctor) => !doctor.due)
    .map((doctor) => ({ doctor, days: [...doctor.planDates].sort().slice(0, 1) }))
    .sort(
      (left, right) =>
        (left.days[0] ?? "9999").localeCompare(right.days[0] ?? "9999") ||
        gradeRank(left.doctor) - gradeRank(right.doctor) ||
        (left.doctor.name ?? "~").localeCompare(right.doctor.name ?? "~"),
    )
    .map((entry) => ({ ...entry, late: false }));
  return [...late, ...ahead].slice(0, summary.needed);
}

// ── The breakdowns ───────────────────────────────────────────────────────────────────────────

/** One group of the rep's planned doctors, with every figure the breakdown tables print. */
export type KpiCoverageGroup = {
  label: string;
  planned: number;
  covered: number;
  late: number;
  notDue: number;
  /** covered ÷ planned, rounded. A group is never empty, so this is never a division by zero. */
  pct: number;
};

function addTo(group: KpiCoverageGroup, doctor: KpiCoverageDoctor): void {
  group.planned += 1;
  if (doctor.visits > 0) group.covered += 1;
  else if (doctor.due) group.late += 1;
  else group.notDue += 1;
}

function finish(groups: Iterable<KpiCoverageGroup>): KpiCoverageGroup[] {
  return [...groups].map((group) => ({ ...group, pct: Math.round((group.covered / group.planned) * 100) }));
}

/**
 * The rep's planned doctors cut by `keyOf`. `order` fixes the order (grades A, B, C, none); without it the
 * biggest group leads and a tie goes alphabetically. Every doctor is in exactly one group, so the groups'
 * planned add up to his Planned and their covered to his Covered.
 */
export function kpiCoverageGroups(
  doctors: readonly KpiCoverageDoctor[],
  keyOf: (doctor: KpiCoverageDoctor) => string,
  order?: readonly string[],
): KpiCoverageGroup[] {
  const groups = new Map<string, KpiCoverageGroup>();
  for (const doctor of doctors) {
    const label = keyOf(doctor);
    const group = groups.get(label) ?? { label, planned: 0, covered: 0, late: 0, notDue: 0, pct: 0 };
    addTo(group, doctor);
    groups.set(label, group);
  }
  const rows = finish(groups.values());
  if (order) {
    const rank = (label: string) => {
      const index = order.indexOf(label);
      return index === -1 ? order.length : index;
    };
    return rows.sort((left, right) => rank(left.label) - rank(right.label) || left.label.localeCompare(right.label));
  }
  return rows.sort((left, right) => right.planned - left.planned || left.label.localeCompare(right.label));
}

/** What a doctor with no speciality on the plan is filed under: the doctor filter's own words. */
export const KPI_NO_SPECIALITY = KPI_DOCTOR_NO_SPECIALITY_LABEL;

export function kpiCoverageByGrade(detail: KpiCoverageDetail): KpiCoverageGroup[] {
  return kpiCoverageGroups([...detail.covered, ...detail.notCovered], (doctor) => kpiGradeGroupOf(doctor.grade), KPI_GRADE_GROUPS);
}

export function kpiCoverageBySpeciality(detail: KpiCoverageDetail): KpiCoverageGroup[] {
  return kpiCoverageGroups([...detail.covered, ...detail.notCovered], (doctor) => doctor.speciality?.trim() || KPI_NO_SPECIALITY);
}

// ── By the week he was planned ───────────────────────────────────────────────────────────────

/** What a doctor the plan booked on no day is filed under in the week table. */
export const KPI_NO_PLAN_WEEK = "No day on the plan";

/** One week of the month (days 1–7, 8–14, …, the Reps Plans weeks), with the doctors FIRST planned in it. */
export type KpiCoverageWeek = KpiCoverageGroup & {
  /** `w1`…`w5`, or `none` for doctors booked on no day. */
  key: string;
  /** True when the week has not begun by `asOf`. */
  ahead: boolean;
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The week of the month a day falls in, and its label: "Week 2 · 8–14 Nov". The same seven-day weeks the
 * Reps Plans period picker offers (days 1–7, 8–14, …), so the table and the picker name a week the same way.
 */
export function kpiMonthWeekOf(iso: string): { key: string; label: string; from: string; to: string } | null {
  const match = ISO_DAY.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const index = Math.floor((Number(match[3]) - 1) / 7);
  const startDay = index * 7 + 1;
  const endDay = Math.min(startDay + 6, daysInMonth(year, month));
  const prefix = `${match[1]}-${match[2]}`;
  return {
    key: `w${index + 1}`,
    label: `Week ${index + 1} · ${startDay}–${endDay} ${MONTHS[month - 1]}`,
    from: `${prefix}-${String(startDay).padStart(2, "0")}`,
    to: `${prefix}-${String(endDay).padStart(2, "0")}`,
  };
}

/**
 * The rep's planned doctors by the week of their FIRST planned day, in calendar order, with the doctors
 * booked on no day last. A doctor booked in several weeks counts once, in the first, so the weeks add up
 * to his Planned. A covered doctor counts as covered in that week whenever his visit came: coverage is
 * "seen at least once in the window", and this table only says WHEN he was meant to be seen first.
 */
export function kpiCoverageByWeek(detail: KpiCoverageDetail, asOf: string): KpiCoverageWeek[] {
  const weeks = new Map<string, KpiCoverageWeek>();
  for (const doctor of [...detail.covered, ...detail.notCovered]) {
    const first = [...doctor.planDates].sort()[0];
    const week = first ? kpiMonthWeekOf(first) : null;
    const key = week?.key ?? "none";
    const row =
      weeks.get(key) ??
      ({
        key,
        label: week?.label ?? KPI_NO_PLAN_WEEK,
        ahead: week ? week.from > asOf : false,
        planned: 0,
        covered: 0,
        late: 0,
        notDue: 0,
        pct: 0,
      } satisfies KpiCoverageWeek);
    addTo(row, doctor);
    weeks.set(key, row);
  }
  return [...weeks.values()]
    .map((week) => ({ ...week, pct: Math.round((week.covered / week.planned) * 100) }))
    .sort((left, right) => (left.key === "none" ? 1 : right.key === "none" ? -1 : left.key.localeCompare(right.key)));
}
