// Who is on the Head Office cycle (owner, 2026-10-26) — the one database read the pure rules in
// cycle.ts need. Shared by the collection run and the Employee Day Report, so both answer "is this
// person paid in one part?" from the same field.

import { compactDeductionsHrId } from "./candidate-key.ts";

/**
 * The compact HR ids of every employee paid in ONE part — the Head Office cycle's population.
 * Read from the employee directory's `salaryPaymentMode`, the same field payroll splits the salary
 * on (unknown → two parts, so an unknown employee stays on the calendar month, as payroll treats him).
 *
 * Fails CLOSED: a read that throws, or that returns nobody at all, refuses the run. Guessing an empty
 * one-part set would put every one-part employee back on the calendar month, and a calendar run would
 * then charge days the office cycle already charged.
 */
export async function loadOnePartEmployeeCompacts(): Promise<Set<string>> {
  const { getEmployeeDirectoryRows } = await import("@/lib/employees/employee-directory");
  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      "Validation: the employee directory returned nobody, so who is paid in one part cannot be told. " +
        "Nothing was collected — re-run once the directory reads.",
    );
  }
  const onePart = new Set<string>();
  for (const row of rows) {
    if (row.salaryPaymentMode !== "one_part") continue;
    const compact = compactDeductionsHrId(row.hrId);
    if (compact) onePart.add(compact);
  }
  return onePart;
}
