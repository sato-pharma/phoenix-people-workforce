import { findDayCollisions } from "@/lib/deductions/conflict";

import type { EmployeeDeductions } from "./deductions-source.ts";
import type { PopulationMember } from "./recommend.ts";

/**
 * One absence day, charged once.
 *
 * THE RULE ALREADY EXISTS, AND PAYROLL NEVER RAN IT. The Deductions module refuses to publish a
 * month in which two detectors claim the same employee-day — its own words to the reviewer are
 * "clear the wrong one or the month cannot be published" — and a database trigger backstops the
 * publication itself. Automated Payroll reads approved candidates straight out of that module and
 * deliberately never calls its publish step, so for the money that actually reaches a payslip the
 * rule was never enforced at all.
 *
 * Three of the five detectors avoid the overlap when they create a candidate: the vacation and
 * holiday-bridge connectors drop a day another live candidate already claims, and the no-record
 * connector only reports field-force days CRM did not already find. FINGERPRINT AND CRM ARE THE
 * PAIR THAT DOES NOT. Nothing between them stops one day being charged as both a late arrival and
 * a no-activity day.
 *
 * ARMED, NEVER FIRED. Applying the module's own rule to every approved candidate on production
 * finds zero real collisions today. The one overlapping pair is a manual entry whose "date" is a
 * placeholder rather than a day anybody was absent, which is exactly what `findDayCollisions`
 * skips — so it is correctly not a collision, and the skip is why the source system has to be
 * carried this far.
 *
 * WHY THE RULE IS BORROWED AND NOT RESTATED. `findDayCollisions` is the Deductions module's own
 * definition of what an overlap is, including which sources do not count. Writing a second
 * definition here is how the two would come to disagree, and a disagreement between them is
 * indistinguishable from a bug in either.
 *
 * WHAT IS DIFFERENT IS THE POPULATION. The module checks every live candidate. Payroll checks only
 * the ones it is actually going to charge — approved for payroll, on this run's roster. A clash
 * between two candidates where only one is approved costs nobody anything, and raising it here
 * would send HR to clear something that was never going to be charged twice.
 */

export type PayrollDayCollision = {
  hrId: string;
  fullName: string;
  /** The day two detectors both claim, as yyyy-mm-dd. */
  date: string;
  /** The categories claiming it, in a stable order. */
  categories: string[];
};

/**
 * Employee-days this run would charge more than once.
 *
 * Pure: the caller supplies the roster and the already-loaded deductions, so nothing here queries
 * anything and the rule is testable on its own.
 */
export function detectPayrollDayCollisions(input: {
  members: PopulationMember[];
  deductions: Map<string, EmployeeDeductions>;
}): PayrollDayCollision[] {
  const claims: Array<{
    employeeHrId: string;
    employeeName: string | null;
    employeeHrIdCompact: string;
    category: EmployeeDeductions["lines"][number]["category"];
    sourceSystem: string;
    dates: readonly string[];
  }> = [];

  for (const member of input.members) {
    // `lines` holds ONLY the candidates approved for payroll — the pending ones live in
    // `pendingLines` and are charged nothing, so they cannot collide with anything.
    for (const line of input.deductions.get(member.compact)?.lines ?? []) {
      if (line.dates.length === 0) continue;
      claims.push({
        employeeHrId: member.employee.hrId,
        employeeName: member.employee.fullName,
        employeeHrIdCompact: member.compact,
        category: line.category,
        sourceSystem: line.sourceSystem,
        dates: line.dates,
      });
    }
  }

  return findDayCollisions(claims)
    .map((collision) => ({
      hrId: collision.employeeHrId,
      fullName: collision.employeeName ?? collision.employeeHrId,
      date: collision.date,
      categories: [...collision.categories].sort(),
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName) || left.date.localeCompare(right.date));
}

/**
 * The sentence that stops a confirm.
 *
 * Names people, never HR codes, and says where to fix it — the run cannot resolve this itself,
 * because which of the two claims is the wrong one is a judgement about what the person was
 * actually doing that day.
 */
export function describePayrollDayCollisions(collisions: PayrollDayCollision[]): string {
  if (collisions.length === 0) return "No employee-day is charged twice.";
  const sample = collisions
    .slice(0, 6)
    .map((collision) => `${collision.fullName} on ${collision.date} (${collision.categories.join(" + ")})`);
  const more = collisions.length > 6 ? ` …and ${collisions.length - 6} more.` : "";
  return (
    `${collisions.length} employee-day(s) would be charged twice: ${sample.join("; ")}${more} ` +
    "Clear the wrong claim in the Deductions module — payroll cannot choose between them."
  );
}
