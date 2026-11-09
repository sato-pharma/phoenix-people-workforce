/**
 * What one weekly plan is made of, for the charts above its doctors table on the Reps Weekly Plans tab — pure, so the
 * arithmetic is pinned by a test rather than trusted from a screenshot.
 *
 * A manager asked to verify a week reads three things before he signs it: whether the doctors are the rep's own (a
 * doctor planned off the list is a thing to ask about), whether the week is spent on the A doctors the grade rules
 * call for, and — once days have ended — how much of it was kept. Each is counted on the unit that makes it honest:
 *
 * - The list and the grades count DOCTORS, once each. A doctor planned AM and PM is one doctor and two calls, and a
 *   grade mix counted on calls would let one doctor seen twice outweigh two seen once.
 * - Kept counts CALLS, on days that have ended and whose visits could be read — the day headings' own figures added
 *   up, so the week's bar and the day bars can never disagree. A day still ahead is not a day anyone failed.
 */

import type { PlanDoctorDay } from "@/lib/crm/plan-doctors";

/** The grade a doctor carries on the plan, or on his contact record when the plan left it blank. */
const NO_GRADE = "No grade";

/** The grades in the order a manager reads them; anything else the CRM sends follows, alphabetically. */
const GRADE_ORDER = ["A", "B", "C", "D"];

export type PlanWeekMix = {
  /** The grades over distinct doctors, in GRADE_ORDER, then any other grade, then No grade last. */
  grades: { count: number; grade: string }[];
  /** Calls on ended, readable days: kept on the day, kept another day, not seen. */
  kept: { missed: number; moved: number; visited: number };
  /** Distinct doctors on the plan that are on the rep's own list. */
  onList: number;
  /** Distinct doctors on the plan that are not on his current list. */
  offList: number;
};

/** One doctor's identity across the week: the CRM contact when it has one, else the name the plan carries. */
function doctorKey(row: PlanDoctorDay["rows"][number]): string {
  const id = row.entry.contactCrmId;
  return id != null ? `id:${id}` : `name:${row.entry.contactName.trim().toLowerCase()}`;
}

function gradeOf(row: PlanDoctorDay["rows"][number]): string {
  const grade = row.entry.grade?.trim() || row.contact?.contact.grade?.trim() || "";
  return grade ? grade.toUpperCase() : NO_GRADE;
}

function gradeRank(grade: string): number {
  if (grade === NO_GRADE) return GRADE_ORDER.length + 1;
  const index = GRADE_ORDER.indexOf(grade);
  return index >= 0 ? index : GRADE_ORDER.length;
}

export function planWeekMix(days: readonly PlanDoctorDay[]): PlanWeekMix {
  // A doctor is on the list if ANY of his rows joined to it: the join is per row, and a doctor matched once is his.
  const doctors = new Map<string, { grade: string; onList: boolean }>();
  const kept = { missed: 0, moved: 0, visited: 0 };
  for (const day of days) {
    for (const row of day.rows) {
      const key = doctorKey(row);
      const seen = doctors.get(key);
      if (seen) {
        seen.onList ||= row.contact != null;
        if (seen.grade === NO_GRADE) seen.grade = gradeOf(row);
      } else {
        doctors.set(key, { grade: gradeOf(row), onList: row.contact != null });
      }
    }
    if (day.actual && !day.actual.upcoming) {
      kept.visited += day.actual.visited;
      kept.moved += day.actual.moved;
      kept.missed += day.actual.missed;
    }
  }
  const byGrade = new Map<string, number>();
  let onList = 0;
  for (const doctor of doctors.values()) {
    byGrade.set(doctor.grade, (byGrade.get(doctor.grade) ?? 0) + 1);
    if (doctor.onList) onList += 1;
  }
  const grades = [...byGrade.entries()]
    .map(([grade, count]) => ({ count, grade }))
    .sort((left, right) => gradeRank(left.grade) - gradeRank(right.grade) || left.grade.localeCompare(right.grade));
  return { grades, kept, offList: doctors.size - onList, onList };
}
