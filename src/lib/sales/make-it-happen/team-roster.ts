// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — who the "Your team" list names.
//
// The team list is built from every achievement row the planner reads, and those rows include the
// closed trend months before the selected period (they feed the pace forecast). So anyone who sold
// during the trend window used to be listed as a member of the selected period's team — with "No
// target" — even after resigning or declining their offer (26 Oct 2026: nine of the National Sales
// Manager's eighteen "No target" rows were people who had left).
//
// A person is listed when still employed, or when holding a target or sales in the selected
// period itself. Their past rows are NOT dropped by this: they keep feeding the lines, the totals and
// the pace, which this file never touches. Only the per-person list and its counts change.
// ─────────────────────────────────────────────────────────────────────────────

import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { pediaSplitApplies } from "@/lib/incentives/pedia-split";
import type { SemesterKey } from "@/lib/incentives/semester";
import type { LinePlanGroup, RepSatoHalf } from "@/lib/sales/make-it-happen/engine";
import { repPaceSatoHalf } from "@/lib/sales/make-it-happen/scenarios";
import type { AchievementRow } from "@/lib/sales/monthly-targets";

/** True when any of the rows, inside the selected months, carries a target or a sale. */
export function holdsTargetOrSalesInPeriod(repRows: readonly AchievementRow[], months: ReadonlySet<string>): boolean {
  return repRows.some(
    (row) =>
      months.has(row.period) &&
      ((row.targetValue ?? 0) > 0 || (row.targetUnits ?? 0) > 0 || row.actualUnits !== 0 || row.actualValue !== 0),
  );
}

/**
 * Whether a person belongs on the team list for the selected period. An unset employment status
 * counts as employed (the repo's one rule, `isTerminalEmploymentStatus`) so a person the employee
 * master does not know is never dropped by this filter.
 */
export function isListedOnTeam(input: {
  employmentStatus: string | null | undefined;
  repRows: readonly AchievementRow[];
  months: ReadonlySet<string>;
}): boolean {
  if (!isTerminalEmploymentStatus(input.employmentStatus)) return true;
  return holdsTargetOrSalesInPeriod(input.repRows, input.months);
}

/**
 * The Sato half a team row shows beside its total. A Pedia person with no Sato product in scope has
 * no half to measure, which used to leave that row on a single meter while every other Pedia row read
 * "Total" and "Sato" — so the row says "Sato · No target" instead, and the list reads the same down
 * the page. A line the Sato split does not apply to still returns null.
 */
export function teamRowSatoHalf(input: {
  repLines: readonly LinePlanGroup[];
  semester: SemesterKey | null;
  satoProductNames: string;
}): RepSatoHalf | null {
  const measured = repPaceSatoHalf(input.repLines);
  if (measured) return measured;
  const onPedia = input.repLines.some((group) => pediaSplitApplies({ line: group.lineCode, semester: input.semester }));
  return onPedia ? { productNames: input.satoProductNames, hasTarget: false, achievement: null } : null;
}
