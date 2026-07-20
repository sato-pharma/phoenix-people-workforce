import { roundCurrency } from "@/lib/payroll/money";

import type { AssembledRow } from "./assemble.ts";
import type { ReconciliationTotals } from "./types.ts";

/**
 * Live reconciliation snapshot (accuracy booster). Sums the run and — critically
 * — asserts First Part + Second Part === Month Salary for every row, surfacing
 * any split drift instantly, plus any Part-1-overpaid rows carried forward.
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

    if (roundCurrency(row.firstPart + row.secondPart) !== roundCurrency(row.monthSalary)) {
      totals.splitMismatches.push({
        hrId: row.hrId,
        firstPart: row.firstPart,
        secondPart: row.secondPart,
        monthSalary: row.monthSalary,
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
