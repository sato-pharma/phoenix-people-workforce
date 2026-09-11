import type { DraftRow } from "./types.ts";

/**
 * ONE DEDUCTION, IN ONE INSTALMENT.
 *
 * Every Part 1 deduction column has a Part 2 twin, and `isSettledInPart1` is what keeps the two
 * populations disjoint: an employee takes their loan, CRM or unpaid vacation on the Part 1 tabs or
 * the Part 2 steps, never both. Money in both columns of a pair therefore means the routing changed
 * underneath somebody, and the same deduction is charged twice on one payslip.
 *
 * From `confirmPart1` onward the routing is stamped onto the draft row, so this can no longer be
 * created. This check exists for the rows that predate the stamp and for whatever other route into
 * the same state nobody has thought of yet — the failure is silent otherwise, because the
 * double-deduction warning is switched off on every Part 1 deduction step.
 *
 * It reads the draft row, not the deductions module, on purpose: what a person is CHARGED is the
 * figure sitting in the column, whatever produced it.
 */

export type PartSplitConflict = {
  hrId: string;
  what: string;
  part1: number;
  part2: number;
};

/** A pair of columns that must never both carry money for the same employee. */
const TWINS: ReadonlyArray<{
  what: string;
  part1: (row: DraftRow) => number;
  part2: (row: DraftRow) => number;
}> = [
  {
    what: "CRM deduction",
    part1: (row) => num(row.p1odCrmValue),
    part2: (row) => num(row.crm),
  },
  {
    what: "unpaid vacation",
    part1: (row) => num(row.p1odVacationValue),
    part2: (row) => num(row.unpaidVacations),
  },
  {
    // The Part 1 tabs split loan and other into their own columns; Part 2 carries both in one.
    what: "loan / other deduction",
    part1: (row) => num(row.p1odLoanValue) + num(row.p1odOtherValue),
    part2: (row) => num(row.manualOtherDeductions),
  },
];

function num(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

/** Rows charged for the same thing in both instalments. Empty is the healthy answer. */
export function findPartSplitConflicts(rows: DraftRow[]): PartSplitConflict[] {
  const conflicts: PartSplitConflict[] = [];
  for (const row of rows) {
    if (row.excluded) continue;
    for (const twin of TWINS) {
      const part1 = round(twin.part1(row));
      const part2 = round(twin.part2(row));
      if (part1 > 0 && part2 > 0) {
        conflicts.push({ hrId: row.employeeHrId, what: twin.what, part1, part2 });
      }
    }
  }
  return conflicts;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** What HR reads. Names the people and both figures, because the fix is a judgement about which. */
export function describePartSplitConflicts(conflicts: PartSplitConflict[]): string {
  const listed = conflicts
    .slice(0, 6)
    .map((one) => `${one.hrId} (${one.what}: ${one.part1.toFixed(2)} in Part 1 and ${one.part2.toFixed(2)} in Part 2)`)
    .join("; ");
  const rest = conflicts.length > 6 ? `, and ${conflicts.length - 6} more` : "";
  return (
    `${conflicts.length} employee deduction(s) are charged in BOTH instalments: ${listed}${rest}. ` +
    "Each of these is the same deduction taken twice on one payslip. Clear whichever instalment " +
    "should not carry it, then confirm again."
  );
}
