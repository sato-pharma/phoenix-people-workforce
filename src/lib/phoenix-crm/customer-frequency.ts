import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmSettings } from "@/lib/phoenix-crm/types";

/**
 * Phoenix CRM Wave 2 — how often each customer was actually seen, against the two things that could
 * be meant by "should have been".
 *
 * 🔴 TWO COLUMNS, APART, NEVER BLENDED (owner, 2026-09-30, asked which basis he wanted and choosing
 * both): visits against his A/B/C GRADE TARGET, and visits against how often he was PLANNED. They
 * answer different questions and they routinely disagree — a customer planned four times and
 * visited four times kept every plan and can still be over his grade. Averaging them, or showing
 * whichever looks worse, hides exactly the gap the report exists to show.
 *
 * 🔴 THE TARGET IS PHOENIX CRM'S OWN `grade_targets`, AND NOTHING ELSE. The first cut of this module
 * scored against `DoctorCoverageNorms` from `src/lib/crm/doctor-coverage-config` — the iReports360
 * side — keyed by the customer's SPECIALITY. That was wrong twice over, and the browser would never
 * have shown it: Phoenix CRM's own targets live in `phoenix_crm_settings.grade_targets`, they are
 * keyed by LIST TYPE and then grade, and the Super Admin edits them on the Settings tab. On
 * production today they read PM A 3 · B 2 · C 1 and AM A 1, where the other table says A 2 — so the
 * coverage figure and the frequency figure would have disagreed about the same customer on the same
 * screen, with nothing to say which was right. `gradeTarget` in `coverage.ts` is the one reader.
 *
 * 🔴 AND A TARGET THAT IS NOT SET IS `null`, EXACTLY LIKE NO GRADE. AM B and AM C are unset on
 * production right now. Writing 0 there would report every one of those customers as permanently
 * over-visited and put a red number against work the company never asked for.
 *
 * 🔴 OVER IS A DEVIATION TOO, NEVER A BONUS — the owner's standing rule of 2026-08-21, reaffirmed
 * 2026-09-04, which `coverage.ts` already carries: frequency counts customers EXACTLY on their
 * grade's number, and reports under and over beside each other. So this report ranks by the SIZE of
 * the gap, not by its sign. Sorting by `visits − target` ascending, as the first cut did, put the
 * most over-visited customers at the bottom as though they were the healthiest rows on the page.
 *
 * Pure rules, no I/O.
 */

export type CustomerFrequencyInput = {
  customerId: string;
  name: string;
  /**
   * 🔴 AM OR PM — the customer's own list type, which is what Phoenix CRM's targets are keyed by.
   * Never a speciality: the company sets how often an AM customer and a PM customer are seen, and
   * those two tables hold different numbers.
   */
  listType: PhoenixCrmListType;
  grade: PhoenixCrmGrade | null;
  /** Visits that COUNT — the caller reads `phoenix_crm_countable_visits`, never a raw visit table. */
  visits: number;
  /**
   * How many times he was placed on a plan that was actually sent — less the times on a day HR
   * approved the rep's leave when he was not seen that day (`plannedOutsideLeave`).
   */
  planned: number;
  /**
   * Those leave-day plannings, counted apart and never against the plan (owner, 2026-10-01: "fix
   * missed visits on leave days in plan vs actual"). Absent means none.
   */
  plannedOnLeave?: number;
};

/** One row, with both comparisons kept whole and separate. */
export type CustomerFrequencyRow = CustomerFrequencyInput & {
  plannedOnLeave: number;
  /** The grade's own monthly number, or null when he has no grade or the company set none. */
  gradeTarget: number | null;
  /** visits − gradeTarget. Null when there is no target to compare against. */
  againstGrade: number | null;
  /** visits − planned. Never null: a customer planned zero times is a real, meaningful zero. */
  againstPlan: number;
  /** "On the grade" · "Under by 2" · "Over by 1" · "No target set" — for the screen and the sheet. */
  gradeVerdict: string;
};

export function frequencyGradeTarget(
  settings: Pick<PhoenixCrmSettings, "gradeTargets">,
  listType: PhoenixCrmListType,
  grade: PhoenixCrmGrade | null,
): number | null {
  return gradeTarget(settings, listType, grade);
}

function verdictOf(against: number | null): string {
  if (against === null) return "No target set";
  if (against === 0) return "On the grade";
  return against < 0 ? `Under by ${Math.abs(against)}` : `Over by ${against}`;
}

export function customerFrequencyRow(
  input: CustomerFrequencyInput,
  settings: Pick<PhoenixCrmSettings, "gradeTargets">,
): CustomerFrequencyRow {
  const target = frequencyGradeTarget(settings, input.listType, input.grade);
  const againstGrade = target === null ? null : input.visits - target;
  return {
    ...input,
    plannedOnLeave: input.plannedOnLeave ?? 0,
    againstGrade,
    againstPlan: input.visits - input.planned,
    gradeTarget: target,
    gradeVerdict: verdictOf(againstGrade),
  };
}

/**
 * How many times a customer counts as PLANNED: every planning on a sent plan, except one on a day HR
 * approved the rep's leave when he was not seen that day — that one is on leave, never a time he owed
 * (`plan-leave.ts`, the rule all three plan reports read). One he WAS seen on, that day, still counts:
 * the visit happened, and taking the planning away would turn a kept plan into a visit above it.
 */
export function plannedOutsideLeave(input: {
  planDays: readonly string[];
  visitDays: readonly string[];
  isLeaveDay: (day: string) => boolean;
}): { planned: number; onLeave: number } {
  const seen = new Set(input.visitDays);
  let onLeave = 0;
  for (const day of input.planDays) if (input.isLeaveDay(day) && !seen.has(day)) onLeave += 1;
  return { planned: input.planDays.length - onLeave, onLeave };
}

/**
 * The report, worst first.
 *
 * "Worst" is the BIGGEST deviation from the grade, in either direction, because over-visiting is a
 * deviation too. Under comes before over at the same size — a customer nobody saw is more urgent
 * than one seen once too often — and a row with no target sorts last: it is not a finding, it is a
 * customer the company never set a number for, and putting those at the top would bury the real
 * gaps under them.
 */
export function buildCustomerFrequencyReport(
  inputs: readonly CustomerFrequencyInput[],
  settings: Pick<PhoenixCrmSettings, "gradeTargets">,
): CustomerFrequencyRow[] {
  return inputs
    .map((input) => customerFrequencyRow(input, settings))
    .sort((left, right) => {
      if (left.againstGrade === null && right.againstGrade !== null) return 1;
      if (right.againstGrade === null && left.againstGrade !== null) return -1;
      const bySize = Math.abs(right.againstGrade ?? 0) - Math.abs(left.againstGrade ?? 0);
      if (bySize !== 0) return bySize;
      // Same size: under first, then the wider plan gap, then the name so the order never wobbles.
      const bySign = (left.againstGrade ?? 0) - (right.againstGrade ?? 0);
      return bySign || Math.abs(right.againstPlan) - Math.abs(left.againstPlan) || left.name.localeCompare(right.name);
    });
}

/** The month's own tallies, for the header — under, on and over kept apart, never one score. */
export function customerFrequencyTotals(rows: readonly CustomerFrequencyRow[]): {
  customers: number;
  under: number;
  onTarget: number;
  over: number;
  noTarget: number;
} {
  const totals = { customers: rows.length, noTarget: 0, onTarget: 0, over: 0, under: 0 };
  for (const row of rows) {
    if (row.againstGrade === null) totals.noTarget += 1;
    else if (row.againstGrade < 0) totals.under += 1;
    else if (row.againstGrade === 0) totals.onTarget += 1;
    else totals.over += 1;
  }
  return totals;
}
