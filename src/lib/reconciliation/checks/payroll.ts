import { getAdminCommandCenterData } from "@/lib/admin/command-center";
import { systemAccessContext } from "@/lib/auth/permissions";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  bankFileCompactKey,
  buildBankFileRows,
  type EmployeeBankInfo,
} from "@/lib/payroll/exports/bank-file";
import { roundCurrency } from "@/lib/payroll/money";
import { getPayrollDashboard, getSalaryBatchExport, listSalaryBatches } from "@/lib/payroll/service";
import type { SalaryBatch } from "@/lib/payroll/types";
import {
  diffSets,
  formatCount,
  formatList,
  formatMoney,
  formatRowsAndMoney,
  moneyMatches,
  MONEY_TOLERANCE_EGP,
} from "@/lib/reconciliation/compare";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * A batch in one of these two states can no longer be replaced (isReplaceableSalaryBatch blocks
 * it), so its salary_records row set is immutable. That is what makes these comparisons race-free:
 * nothing can legitimately change between reading the service and reading the rows. It is also
 * what makes any drift a bug by definition — there is no honest reason for the number of people on
 * a locked January payslip run to change in August.
 */
const IMMUTABLE_BATCH_STATUSES = new Set(["approved", "locked"]);

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable period, because a raw month number is not something the owner should decode. */
function batchLabel(batch: Pick<SalaryBatch, "month" | "year">): string {
  const short = MONTH_SHORT[batch.month - 1] ?? String(batch.month);
  return `${short}-${batch.year}`;
}

type SalaryRecordRow = {
  id: string;
  hr_id: string | null;
  net_salary: number | null;
  month_salary: number | null;
  base_salary: number | null;
  extra_cost_of_living: number | null;
  fuel_allowance: number | null;
};

/**
 * The right-hand side of every payroll check: the rows themselves, read straight from
 * salary_records with no service in the path. Paginated because PostgREST caps a response at
 * 1,000 rows and a truncated right-hand side would report a false breach on a healthy batch.
 */
async function loadBatchRows(batchId: string): Promise<SalaryRecordRow[]> {
  return fetchAllRows<SalaryRecordRow>(
    () =>
      getSupabaseAdmin()
        .from("salary_records")
        .select("id,hr_id,net_salary,month_salary,base_salary,extra_cost_of_living,fuel_allowance")
        .eq("batch_id", batchId),
    "id",
  );
}

async function immutableBatches(): Promise<SalaryBatch[]> {
  const batches = await listSalaryBatches();
  return batches.filter((batch) => IMMUTABLE_BATCH_STATUSES.has(String(batch.status ?? "").toLowerCase()));
}

function compactHrId(value: string | null | undefined): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function sum(values: readonly number[]): number {
  return roundCurrency(values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0));
}

/**
 * Check 1 — the Payroll dashboard against the very rows of the batch it is showing.
 *
 * getPayrollDashboard rebuilds a batch's membership from TODAY's employees.employment_status
 * (buildPayrollIneligibleHrIdSet), so a locked batch loses everyone who has since resigned or been
 * moved to a historical status — people who WERE employed and WERE paid in that month. Nothing in
 * the product announces the shortfall; the dashboard simply shows a smaller company.
 */
const dashboardMatchesOwnRecords: ReconciliationCheck = {
  id: "payroll-dashboard-matches-its-own-salary-records",
  title: "A batch's dashboard headcount and net total equal the sum of that batch's own salary_records rows",
  domain: "payroll",
  severity: "critical",
  expectation: "holds",
  // Was known-open until 2026-10-23: a batch's membership is fixed when it is built and only the viewer's access scope may drop a row (payroll/service.ts, PayrollAccessFilter); the roster-status filter this check measured is gone.
  async run(): Promise<ReconciliationOutcome> {
    const batches = await immutableBatches();
    const problems: string[] = [];
    let leftEmployees = 0;
    let leftNet = 0;
    let rightEmployees = 0;
    let rightNet = 0;

    for (const batch of batches) {
      const [dashboard, rows] = await Promise.all([
        getPayrollDashboard(batch.id, systemAccessContext),
        loadBatchRows(batch.id),
      ]);
      const dbNet = sum(rows.map((row) => Number(row.net_salary ?? 0)));
      const serviceNet = roundCurrency(dashboard.summary.totalNet);

      leftEmployees += dashboard.summary.totalEmployees;
      leftNet += serviceNet;
      rightEmployees += rows.length;
      rightNet += dbNet;

      if (dashboard.summary.totalEmployees !== dashboard.records.length) {
        problems.push(
          `${batchLabel(batch)}: the summary says ${formatCount(dashboard.summary.totalEmployees, "person", "people")} but only ${formatCount(dashboard.records.length, "record")} were returned`,
        );
      }
      if (dashboard.summary.totalEmployees !== rows.length || !moneyMatches(serviceNet, dbNet)) {
        problems.push(
          `${batchLabel(batch)} (${batch.status}): dashboard ${formatRowsAndMoney(dashboard.summary.totalEmployees, serviceNet, "person")} vs batch ${formatRowsAndMoney(rows.length, dbNet)} — ${formatCount(rows.length - dashboard.summary.totalEmployees, "person", "people")} and ${formatMoney(dbNet - serviceNet)} missing from the screen`,
        );
      }
    }

    return {
      left: {
        source: `getPayrollDashboard(batchId, systemAccessContext) over ${formatCount(batches.length, "approved/locked batch", "approved/locked batches")}`,
        value: formatRowsAndMoney(leftEmployees, roundCurrency(leftNet), "person"),
      },
      right: {
        source: "salary_records rows of those same batches, read directly",
        value: formatRowsAndMoney(rightEmployees, roundCurrency(rightNet)),
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `Every approved/locked batch's dashboard matches its own rows (${formatCount(batches.length, "batch", "batches")} checked).`
          : formatList(problems),
    };
  },
};

/**
 * Check 2 — the bank transfer file against the batch it is paying.
 *
 * Deliberately separate from check 1: this exercises a different service pair
 * (getSalaryBatchExport + buildBankFileRows) and a different money column (month_salary = first +
 * second part, which differs from net_salary on 74 of 691 production rows). A regression that
 * drops rows only in the export path — or that quietly filters missing-bank rows out of the file —
 * fires here even while the dashboard stays correct. A row missing from this file is a person the
 * bank was never asked to pay.
 */
const bankFilePaysWholeBatch: ReconciliationCheck = {
  id: "payroll-bank-file-payable-matches-batch",
  title: "The bank transfer file pays every row in the batch, for exactly the batch's payable total",
  domain: "payroll",
  severity: "critical",
  expectation: "holds",
  // Was known-open until 2026-10-23: the export path now shares the same access-only filter as the dashboard, so the transfer file pays the whole batch.
  async run(): Promise<ReconciliationOutcome> {
    const batches = await immutableBatches();
    const directory = await getEmployeeDirectory();
    // Exactly the map app/api/payroll/[id]/bank-file/route.ts builds, so the file this check
    // measures is byte-for-byte the file the bank receives.
    const bankByHrId = new Map<string, EmployeeBankInfo>();
    for (const employee of directory.employees) {
      bankByHrId.set(bankFileCompactKey(employee.hrId), {
        bankName: employee.bankName,
        bankAccount: employee.bankAccount,
        hasBankAccount: employee.hasBankAccount,
      });
    }

    const problems: string[] = [];
    let leftRows = 0;
    let leftPayable = 0;
    let rightRows = 0;
    let rightPayable = 0;

    for (const batch of batches) {
      const [exportData, rows] = await Promise.all([
        getSalaryBatchExport(batch.id, systemAccessContext),
        loadBatchRows(batch.id),
      ]);
      const bankRows = buildBankFileRows(exportData?.records ?? [], bankByHrId);
      const filePayable = sum(bankRows.map((row) => row.amount));
      const dbPayable = sum(rows.map((row) => Number(row.month_salary ?? 0)));

      leftRows += bankRows.length;
      leftPayable += filePayable;
      rightRows += rows.length;
      rightPayable += dbPayable;

      // Identity comparison, not a tally: the file can hold the right NUMBER of people and still
      // be paying a different set of them.
      const identities = diffSets(
        (exportData?.records ?? []).map((record) => compactHrId(record.hrId)),
        rows.map((row) => compactHrId(row.hr_id)),
      );
      if (!identities.identical || !moneyMatches(filePayable, dbPayable)) {
        problems.push(
          `${batchLabel(batch)} (${batch.status}): bank file ${formatRowsAndMoney(bankRows.length, filePayable)} vs batch ${formatRowsAndMoney(rows.length, dbPayable)}; ${formatCount(identities.onlyInRight.length, "person", "people")} in the batch are absent from the file`,
        );
      }
    }

    return {
      left: {
        source: "buildBankFileRows(getSalaryBatchExport(...).records) — the exact pair the bank-file route calls",
        value: formatRowsAndMoney(leftRows, roundCurrency(leftPayable)),
      },
      right: {
        source: "salary_records.month_salary of those same batches, read directly",
        value: formatRowsAndMoney(rightRows, roundCurrency(rightPayable)),
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `Every approved/locked batch's transfer file pays its whole batch (${formatCount(batches.length, "batch", "batches")} checked).`
          : formatList(problems),
    };
  },
};

type CommandCenterPeriod = { month: number; year: number };

/**
 * fetchPayrollSummary builds the card's label as `${month}/${year}` and nothing else — parsing it
 * back is the only way to learn WHICH month the card is showing, because the id never leaves that
 * function. A label that stops parsing is itself worth reporting: it means the two screens can no
 * longer be proven to be talking about the same month.
 */
function parseCommandCenterPeriod(label: string): CommandCenterPeriod | null {
  const match = /^(\d{1,2})\/(\d{4})$/.exec(String(label ?? "").trim());
  if (!match) return null;
  return { month: Number(match[1]), year: Number(match[2]) };
}

/**
 * Check 3 — the Command Center payroll card against the Payroll dashboard.
 *
 * command-center.ts holds TWO live definitions of "payroll cost this month": fetchPayrollSummary
 * sums salary_records straight from the database, fetchScopedPayrollSummary routes through
 * getPayrollDashboard, and line 807 picks between them BY ROLE. A second definition of one number
 * is how this whole class of defect starts, so this is the direct guard against it — no SQL on
 * either side, just two services that must agree.
 */
const commandCenterCardMatchesDashboard: ReconciliationCheck = {
  id: "payroll-command-center-card-matches-payroll-dashboard",
  title: "The Command Center payroll card and the Payroll dashboard report the same month, headcount and net",
  domain: "payroll",
  severity: "high",
  expectation: "holds",
  // Was known-open until 2026-10-23: both screens now read a batch's own membership, so the card and the dashboard agree for every role.
  async run(): Promise<ReconciliationOutcome> {
    // A payroll upload landing between the two reads would look exactly like a mismatch. Reading
    // both again and only reporting a period disagreement that SURVIVES the re-read removes that
    // race without weakening the check.
    const compareOnce = async () => {
      const [commandCenter, dashboard] = await Promise.all([
        getAdminCommandCenterData(systemAccessContext),
        getPayrollDashboard(undefined, systemAccessContext),
      ]);
      return { card: commandCenter.overview.payroll, dashboard };
    };

    let { card, dashboard } = await compareOnce();
    const samePeriod = () => {
      const cardPeriod = parseCommandCenterPeriod(card.batchLabel);
      if (!cardPeriod || !dashboard.batch) return false;
      return cardPeriod.month === dashboard.batch.month && cardPeriod.year === dashboard.batch.year;
    };
    if (!samePeriod()) ({ card, dashboard } = await compareOnce());

    const cardPeriod = parseCommandCenterPeriod(card.batchLabel);
    const dashboardPeriod = dashboard.batch ? batchLabel(dashboard.batch) : "no batch";
    const cardLabel = cardPeriod ? batchLabel(cardPeriod) : `unrecognised label "${card.batchLabel}"`;

    const problems: string[] = [];
    if (!samePeriod()) {
      problems.push(
        `The two screens are anchored to different months: card shows ${cardLabel}, dashboard shows ${dashboardPeriod}`,
      );
    }
    if (card.employees !== dashboard.summary.totalEmployees) {
      problems.push(
        `Headcount for ${dashboardPeriod}: card ${formatCount(card.employees, "person", "people")} vs dashboard ${formatCount(dashboard.summary.totalEmployees, "person", "people")}`,
      );
    }
    if (!moneyMatches(card.net, dashboard.summary.totalNet)) {
      problems.push(
        `Net for ${dashboardPeriod}: card ${formatMoney(card.net)} vs dashboard ${formatMoney(dashboard.summary.totalNet)}`,
      );
    }
    if (!moneyMatches(card.gross, dashboard.summary.totalGross)) {
      problems.push(
        `Gross for ${dashboardPeriod}: card ${formatMoney(card.gross)} vs dashboard ${formatMoney(dashboard.summary.totalGross)}`,
      );
    }

    return {
      left: {
        source: "getAdminCommandCenterData(systemAccessContext).overview.payroll",
        value: `${cardLabel} — ${formatRowsAndMoney(card.employees, roundCurrency(card.net), "person")} net`,
      },
      right: {
        source: "getPayrollDashboard(undefined, systemAccessContext).summary",
        value: `${dashboardPeriod} — ${formatRowsAndMoney(dashboard.summary.totalEmployees, roundCurrency(dashboard.summary.totalNet), "person")} net`,
      },
      holds: problems.length === 0,
      detail: problems.length === 0 ? `Both screens agree on ${dashboardPeriod}.` : formatList(problems),
    };
  },
};

/**
 * Check 4 — the net a payroll screen renders against the net stored on the row that was paid.
 *
 * salary_records.net_salary is the figure Finance approved and the payslip is built from, but no
 * screen shows it directly: mapRecord re-derives net from base_salary + extra_cost_of_living +
 * fuel_allowance on every read. If an import ever writes a base_salary inconsistent with the
 * sheet, every dashboard, export and payslip silently shows a net that is not the approved one —
 * the same read-path-recomputation shape as the membership defect, on the money column instead of
 * the row set. This pins the owner-locked formula in payroll/policy.ts against drift WITHOUT
 * importing from it or restating it: the check only consumes what the service already returned.
 */
const recordNetMatchesStoredNet: ReconciliationCheck = {
  id: "payroll-record-net-matches-policy-derivation",
  title: "Every net salary a payroll screen renders equals the net stored on the row that was paid",
  domain: "payroll",
  severity: "critical",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const batches = await immutableBatches();
    const problems: string[] = [];
    let compared = 0;
    let leftTotal = 0;
    let rightTotal = 0;

    for (const batch of batches) {
      const [exportData, rows] = await Promise.all([
        getSalaryBatchExport(batch.id, systemAccessContext),
        loadBatchRows(batch.id),
      ]);
      const storedById = new Map(rows.map((row) => [row.id, row]));
      for (const record of exportData?.records ?? []) {
        const stored = storedById.get(record.id);
        if (!stored) continue;
        compared += 1;
        leftTotal += record.netSalary;
        rightTotal += Number(stored.net_salary ?? 0);
        if (!moneyMatches(record.netSalary, Number(stored.net_salary ?? 0))) {
          problems.push(
            `${batchLabel(batch)} — ${record.fullName || record.hrId}: screen shows ${formatMoney(record.netSalary)}, the approved row holds ${formatMoney(Number(stored.net_salary ?? 0))}`,
          );
        }
      }
    }

    return {
      left: {
        source: "getSalaryBatchExport(...).records[].netSalary — net as every payroll screen derives it",
        value: formatRowsAndMoney(compared, roundCurrency(leftTotal)),
      },
      right: {
        source: "salary_records.net_salary — net as approved and paid",
        value: formatRowsAndMoney(compared, roundCurrency(rightTotal)),
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `All ${formatCount(compared, "salary row")} across ${formatCount(batches.length, "batch", "batches")} derive the approved net (tolerance ${MONEY_TOLERANCE_EGP.toFixed(2)} EGP).`
          : formatList(problems),
    };
  },
};

export const payrollReconciliationChecks: ReconciliationCheck[] = [
  dashboardMatchesOwnRecords,
  bankFilePaysWholeBatch,
  commandCenterCardMatchesDashboard,
  recordNetMatchesStoredNet,
];
