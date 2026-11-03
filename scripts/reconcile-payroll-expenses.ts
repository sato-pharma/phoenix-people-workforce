// Did the payslips pay the expenses that were approved? Read-only.
//
//   pnpm run payroll:reconcile-expenses                  (the newest published month)
//   pnpm run payroll:reconcile-expenses -- 2026-09       (that month)
//
// The rules are in src/lib/automated-payroll/expense-reconciliation.ts, and the Expense Command page's
// third tab shows the same report. A difference is not a defect and this never repairs one. A plain run
// exits 0 whatever it finds, for the reason reconcile-payroll-deductions.ts gives; a read that fails
// exits 2, because that is the tool saying it does not know.
//
// It writes nothing, anywhere. With `.env.local` loaded it READS production.

import {
  loadExpenseReconciliation,
  newestPublishedExpenseMonth,
  type ExpensePeriod,
} from "@/lib/automated-payroll/expense-reconciliation-server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

refuseUnknownFlags({ name: "reconcile-payroll-expenses", entry: import.meta.url, known: [] });

const MONTH = /^(\d{4})-(\d{2})$/;
const money = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

async function resolvePeriod(target: string | undefined): Promise<ExpensePeriod | null> {
  const match = target ? MONTH.exec(target) : null;
  if (match) return { month: Number(match[2]), year: Number(match[1]) };
  return newestPublishedExpenseMonth();
}

async function main() {
  const target = process.argv.slice(2).find((argument) => MONTH.test(argument));
  const period = await resolvePeriod(target);
  console.log("\nAPPROVED EXPENSES vs PUBLISHED PAYSLIPS");
  if (!period) {
    console.log("\nNo published month found.\n");
    return;
  }
  const label = `${period.year}-${String(period.month).padStart(2, "0")}`;
  const result = await loadExpenseReconciliation(period);
  if (result.status === "not_published") {
    console.log(`\n${label} is not published yet. Approved so far: ${money(result.undecidedApproved)}.\n`);
    return;
  }
  const { report } = result;
  console.log(`\n── ${label}   approved ${money(report.approvedTotal)}   on the payslips ${money(report.paidTotal)}   undecided ${money(report.pendingTotal)}`);
  if (result.typedByHand) console.log("  This month's figures were typed into the sheet by hand, so differences are expected.");
  if (result.importedHistoryTrips > 0) console.log(`  ${result.importedHistoryTrips} trip(s) are imported history.`);
  if (result.heldCount > 0) console.log(`  ${result.heldCount} person(s) held at publish.`);
  for (const row of report.rows) {
    console.log(
      `  ${row.finding.toUpperCase().padEnd(28)} ${row.fullName.padEnd(38)}` +
        ` approved ${money(row.approved).padStart(11)}  payslip ${money(row.paid).padStart(11)}  gap ${money(row.gap).padStart(11)}`,
    );
    if (row.note) console.log(`    ${row.note}`);
  }
  console.log(`\n  ${report.matches} match, ${report.rows.length} to look at. Reported, not judged: this makes no change.\n`);
}

main().catch((error) => {
  console.error("expense reconciliation failed to run:", error);
  process.exit(2);
});
