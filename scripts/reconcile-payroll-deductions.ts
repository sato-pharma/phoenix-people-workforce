// Does a payroll run charge what the Deductions module approved? Read-only.
//
//   node --env-file-if-exists=.env.local --experimental-strip-types \
//     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
//     scripts/reconcile-payroll-deductions.ts [YYYY-MM | <run id>] [--all]
//
// Or: pnpm run payroll:reconcile-deductions                  (the newest run of the current month)
//     pnpm run payroll:reconcile-deductions -- 2026-09       (that month's newest run)
//     pnpm run payroll:reconcile-deductions -- <run uuid>    (one named run)
//     pnpm run payroll:reconcile-deductions -- 2026-09 --all (every comparison, matches included)
//     pnpm run payroll:reconcile-deductions -- 2026-09 --gate (exit 1 when anything differs)
//
// The Deductions module is the one source of a deduction (owner rule 2026-08-04), so every approved
// figure should reach a salary column. `module-drift.ts` already answers a NARROWER question — has
// the module moved SINCE the step was confirmed — and deliberately stays quiet about a figure
// somebody set below a proposal that never moved. This answers the plain one, with the Part 1 /
// Part 2 routing applied.
//
// 🔴 A PLAIN RUN ALWAYS EXITS 0, EVEN WHEN FIGURES DIFFER. It is a REPORT, and a report that
// answers correctly has not failed: exiting 1 made pnpm print "[ELIFECYCLE] Command failed with
// exit code 1" under a perfectly good September 2026 answer, which reads as the tool being broken
// rather than as the month having three figures the owner decided himself. Only `--gate` exits 1,
// for a cron that needs to alarm; nothing in this repo calls it that way today.
//
// 🔴 A DIFFERENCE IS NOT A DEFECT, AND THIS SCRIPT NEVER REPAIRS ONE. The owner trims a proposal
// deliberately — two September 2026 figures are his own decision (2026-10-09). Read the list, name
// the rows, and leave the money alone.
//
// It writes nothing, anywhere. With `.env.local` loaded it READS production.

import { cairoTimeLabel } from "@/lib/automated-payroll/cell-history-labels";
import {
  describeReconciliation,
  reconcileDeductions,
  type ReconciliationReport,
  type ReconciliationRow,
} from "@/lib/automated-payroll/deduction-reconciliation";
import { loadConfirmedDeductions } from "@/lib/automated-payroll/deductions-source";
import { findLatestRun, getRunById, listDraftRows } from "@/lib/automated-payroll/draft-store";
import { resolvePayrollPopulationAndSources } from "@/lib/automated-payroll/recommend";
import type { MonthlySalaryRun } from "@/lib/automated-payroll/types";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { compactHrKey } from "@/lib/payroll/copilot/feeders";

const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH = /^(\d{4})-(\d{2})$/;

const VERDICT_LABEL: Record<ReconciliationRow["verdict"], string> = {
  matches: "MATCHES",
  "charged less": "CHARGED LESS",
  "charged more": "CHARGED MORE",
  "not comparable by design": "NOT COMPARABLE",
  "not in the population": "NOT IN POPULATION",
  "not on this run": "NOT ON THIS RUN",
};

function printRow(row: ReconciliationRow): void {
  console.log(
    `  ${VERDICT_LABEL[row.verdict].padEnd(18)}` +
      ` ${row.fullName.padEnd(38)} ${row.label.padEnd(58)}` +
      ` module ${money(row.moduleAmount).padStart(12)}` +
      `  run ${money(row.runAmount).padStart(12)}` +
      `  diff ${money(row.difference).padStart(12)}`,
  );
}

function printReport(run: MonthlySalaryRun, report: ReconciliationReport, verbose: boolean): void {
  const confirmed = run.part1ConfirmedAt
    ? `Part 1 confirmed ${cairoTimeLabel(run.part1ConfirmedAt)} Cairo`
    : "Part 1 NOT confirmed";
  console.log(`\n── ${run.monthKey}  run ${run.id}  phase ${run.phase}  (${confirmed})`);

  // The routing depends on isSettledInPart1, which is frozen onto the draft row at the Part 1
  // confirm and computed live before it. A missing stamp on an ALREADY-CONFIRMED run means that
  // row was not in the population when the stamp was written — worth saying out loud, because the
  // split the report used for them is today's answer rather than the one the sheet is built on.
  if (report.provisionalRouting > 0) {
    const whose = run.part1ConfirmedAt
      ? "were not in the population when Part 1 was confirmed, so their split was read LIVE"
      : "have no Part 1 routing stamp yet, so their split was read LIVE and can still move";
    console.log(`  ! ${report.provisionalRouting} employee(s) ${whose}.`);
  }

  for (const row of report.rows) {
    if (!verbose && (row.verdict === "matches" || report.unreachable.includes(row))) continue;
    printRow(row);
  }

  if (report.unreachable.length > 0) {
    console.log(
      `\n  ${report.unreachable.length} employee(s) have approved deductions that NO step on this` +
        ` run can carry — no draft row, or not in this run's population. Not payable here, and not` +
        ` a shortfall:`,
    );
    for (const row of report.unreachable) {
      console.log(
        `    ${row.fullName.padEnd(38)} ${money(row.moduleAmount).padStart(12)} approved — ${row.label}`,
      );
    }
  }

  console.log(`\n  ${describeReconciliation(report)}`);
}

async function reconcileRun(run: MonthlySalaryRun) {
  const period = { month: run.month, year: run.year };
  const [population, deductions, draftRows, directory] = await Promise.all([
    resolvePayrollPopulationAndSources(period),
    loadConfirmedDeductions(period),
    listDraftRows(run.id),
    // Names for anybody the population leaves out — the owner's standing rule is names, never
    // codes, and those rows are precisely the ones with no population name to fall back on.
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);
  const names = new Map(
    directory.map((employee) => [compactHrKey(employee.hrId), employee.fullName]),
  );
  return reconcileDeductions({
    members: population.members,
    sources: population.sources,
    deductions,
    draftRows,
    names,
  });
}

async function resolveRun(target: string | null): Promise<MonthlySalaryRun | null> {
  if (target && UUID.test(target)) return getRunById(target);
  const match = target ? MONTH.exec(target) : null;
  if (match) return findLatestRun(Number(match[2]), Number(match[1]));
  // Cairo, not the host's zone: at 01:30 on the 1st those are different months, and asking for the
  // wrong one silently reconciles a run nobody asked about.
  const [cairoYear, cairoMonth] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date())
    .split("-")
    .map(Number);
  return findLatestRun(cairoMonth, cairoYear);
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("--all");
  // Opt-in, never the default — see the header. A human reading the report is the normal caller.
  const gate = args.includes("--gate");
  const target = args.find((argument) => UUID.test(argument) || MONTH.test(argument)) ?? null;

  const run = await resolveRun(target);
  console.log("\nPAYROLL RUN vs DEDUCTIONS MODULE   (the module is the source of a deduction)");
  if (!run) {
    console.log(
      `\nNo payroll run found for ${target ?? "the current month"} — nothing to reconcile.\n`,
    );
    return;
  }

  const report = await reconcileRun(run);
  printReport(run, report, verbose);

  if (report.differences.length === 0) {
    console.log(
      `\nRECONCILED — ${report.rows.length} comparison(s), every approved figure charged.\n`,
    );
    return;
  }
  console.log(
    gate
      ? ""
      : "  (Reported, not judged — this run makes no change and exits 0. Pass --gate for a cron.)\n",
  );
  if (gate) process.exitCode = 1;
}

main().catch((error) => {
  console.error("payroll deduction reconciliation failed to run:", error);
  process.exit(2);
});
