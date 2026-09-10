import { roundCurrency } from "@/lib/payroll/money";

import type { AssembledRow } from "./assemble.ts";
import type { ReconciliationTotals } from "./types.ts";

/**
 * Live reconciliation snapshot (accuracy booster). Sums the run and — critically — asserts that
 * the First/Second split still adds up to what the locked engine says the month owes, surfacing
 * any split drift instantly, plus any Part-1-overpaid rows carried forward.
 *
 * The assertion changed on 2026-09-10. It used to compare First + Second against Month Salary,
 * which assembleParts defines as First + Second — a value against itself, unable to fail. See the
 * comment on the check itself.
 */
export function reconcile(rows: AssembledRow[]): ReconciliationTotals {
  const totals: ReconciliationTotals = {
    headcount: rows.length,
    joiners: 0,
    leavers: 0,
    held: 0,
    oneParts: 0,
    twoParts: 0,
    totalFirstPart: 0,
    totalSecondPart: 0,
    totalMonthSalary: 0,
    totalNet: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    splitMismatches: [],
    overpaid: [],
  };

  for (const entry of rows) {
    const { row } = entry;
    if (entry.lifecycle === "joiner") totals.joiners += 1;
    if (entry.lifecycle === "leaver") totals.leavers += 1;
    if (entry.onHold) totals.held += 1;
    if (row.paymentMode === "one_part") totals.oneParts += 1;
    else totals.twoParts += 1;

    totals.totalFirstPart += row.firstPart;
    totals.totalSecondPart += row.secondPart;
    totals.totalMonthSalary += row.monthSalary;
    totals.totalNet += row.netSalary;
    totals.totalAdditions += row.totalAdditions;
    totals.totalDeductions += row.totalDeductions;

    // THE SPLIT AGAINST THE ENGINE, not against itself.
    //
    // What this checked before was `firstPart + secondPart === monthSalary`. assembleParts defines
    // `monthSalary = roundCurrency(firstPart + secondPart)` on the line it returns, so the two sides
    // were the same expression: the check could only ever pass. Every real defect in the split — a
    // wrong frozen first instalment, a deduction the engine took that the split did not, a clamp
    // that lost money — recomputes monthSalary from the same two wrong numbers and sails through.
    //
    // `totalPayable` is the locked engine's own answer for what the month owes, computed from net,
    // additions and deductions without reference to the split. The identity that must hold is:
    //
    //     firstPart + secondPart - overpaidResidual === totalPayable
    //
    // The residual term is not a fudge. When Part-2 deductions exceed the already-paid first
    // instalment, secondPart is clamped to 0 and the shortfall is recorded as overpaidResidual
    // instead of being paid; adding it back is what makes the identity exact in BOTH branches
    // rather than only in the ordinary one.
    const splitAgainstEngine = roundCurrency(row.firstPart + row.secondPart - entry.overpaidResidual);
    if (splitAgainstEngine !== roundCurrency(entry.totalPayable)) {
      totals.splitMismatches.push({
        hrId: row.hrId,
        firstPart: row.firstPart,
        secondPart: row.secondPart,
        monthSalary: row.monthSalary,
        overpaidResidual: entry.overpaidResidual,
        totalPayable: entry.totalPayable,
      });
    }
    if (entry.overpaidResidual > 0) {
      totals.overpaid.push({ hrId: row.hrId, residual: entry.overpaidResidual });
    }
  }

  totals.totalFirstPart = roundCurrency(totals.totalFirstPart);
  totals.totalSecondPart = roundCurrency(totals.totalSecondPart);
  totals.totalMonthSalary = roundCurrency(totals.totalMonthSalary);
  totals.totalNet = roundCurrency(totals.totalNet);
  totals.totalAdditions = roundCurrency(totals.totalAdditions);
  totals.totalDeductions = roundCurrency(totals.totalDeductions);
  return totals;
}
