import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { isImportedHistoryTrip, PHOENIX_OUTSTATION_APPROVALS_START } from "@/lib/outstation/imported-history";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { compactHrKey } from "@/lib/payroll/copilot/feeders";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  expenseMonthGaps,
  expenseMonthWasTypedByHand,
  reconcileExpenses,
  type ExpenseMonthFacts,
  type ExpenseReconciliationReport,
  type ExpenseTripFact,
} from "./expense-reconciliation.ts";
import { automatedPayrollRunIdFromBatchFileName, heldDraftHrIds, readPublishedHoldRecord } from "./published-holds.ts";

/**
 * The reads behind the expenses check. Read-only, and any failed read THROWS: the screen and the
 * command then say they could not read, because a failed read shown as zero would call every trip
 * unpaid. The access decision is the caller's: this module asserts nothing and is reached only from the
 * Expense Command page's guard and the command line.
 */

const PAGE_SIZE = 500;
/** The batch statuses a payslip shows from (payslip-center.ts). */
const PUBLISHED_BATCH_STATUSES = ["approved", "locked"];

export type ExpensePeriod = { month: number; year: number };

export type ExpenseReconciliationResult =
  | { status: "not_published"; period: ExpensePeriod; undecidedApproved: number }
  | {
      status: "published";
      period: ExpensePeriod;
      report: ExpenseReconciliationReport;
      typedByHand: boolean;
      importedHistoryTrips: number;
      heldCount: number;
    };

function keyOf(hrId: string | null | undefined): string {
  return compactHrKey(canonicalHrIdKey(hrId) ?? "");
}

type TripRow = {
  hr_id: string | null;
  expense_date: string | null;
  total: number | null;
  approved_amount: number | null;
  hr_approved: boolean | null;
  status: string | null;
};

/** Every trip of one payout period. Stamped trips included: the stamp is not what says paid. */
async function readTrips(period: ExpensePeriod): Promise<TripRow[]> {
  const rows: TripRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await getSupabaseAdmin()
      .from("outstation_expenses")
      .select("hr_id,expense_date,total,approved_amount,hr_approved,status")
      .eq("payout_month", period.month)
      .eq("payout_year", period.year)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read the month's trips: ${error.message}`);
    const page = (data ?? []) as TripRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function tripFacts(rows: readonly TripRow[]): ExpenseTripFact[] {
  return rows.map((row) => ({
    compact: keyOf(row.hr_id),
    payable: payableExpenseAmount(row.approved_amount, row.total),
    state: expenseApprovalState({ hrApproved: row.hr_approved, status: row.status }),
  }));
}

type PublishedBatch = { id: string; fileName: string | null };

async function readPublishedBatch(period: ExpensePeriod): Promise<PublishedBatch | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("salary_batches")
    .select("id,file_name")
    .eq("month", period.month)
    .eq("year", period.year)
    .in("status", PUBLISHED_BATCH_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not read the month's salary batch: ${error.message}`);
  const row = ((data ?? []) as Array<{ id: string; file_name: string | null }>)[0];
  return row ? { fileName: row.file_name, id: row.id } : null;
}

/** Only these three columns: this check has no business reading anyone's salary. */
async function readPaid(batchId: string): Promise<ExpenseMonthFacts["paid"]> {
  const rows: Array<{ hr_id: string | null; full_name: string | null; expenses: number | null }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await getSupabaseAdmin()
      .from("salary_records")
      .select("hr_id,full_name,expenses")
      .eq("batch_id", batchId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read the published payslips: ${error.message}`);
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows.map((row) => ({
    compact: keyOf(row.hr_id),
    expenses: Number(row.expenses ?? 0),
    fullName: String(row.full_name ?? "").trim(),
  }));
}

function addMonths(period: ExpensePeriod, offset: number): ExpensePeriod {
  const index = period.year * 12 + (period.month - 1) + offset;
  return { month: (index % 12) + 1, year: Math.floor(index / 12) };
}

/** A neighbouring month's gaps, or nothing when it has not published. Only words a row. */
async function neighbourGaps(period: ExpensePeriod): Promise<Map<string, number>> {
  const batch = await readPublishedBatch(period);
  if (!batch) return new Map();
  const [trips, paid] = await Promise.all([readTrips(period), readPaid(batch.id)]);
  return expenseMonthGaps({ paid, trips: tripFacts(trips) });
}

export async function loadExpenseReconciliation(period: ExpensePeriod): Promise<ExpenseReconciliationResult> {
  const [batch, tripRows] = await Promise.all([readPublishedBatch(period), readTrips(period)]);
  const trips = tripFacts(tripRows);
  if (!batch) {
    const undecidedApproved = trips.filter((trip) => trip.state === "approved").reduce((sum, trip) => sum + trip.payable, 0);
    return { period, status: "not_published", undecidedApproved };
  }

  const runId = automatedPayrollRunIdFromBatchFileName(batch.fileName);
  const [paid, previousGaps, nextGaps, holdRecord, heldDraft, directory] = await Promise.all([
    readPaid(batch.id),
    neighbourGaps(addMonths(period, -1)),
    neighbourGaps(addMonths(period, 1)),
    runId ? readPublishedHoldRecord(runId) : Promise.resolve(null),
    runId ? heldDraftHrIds(runId) : Promise.resolve<string[]>([]),
    getEmployeeDirectoryRows({ includeInactive: true }),
  ]);

  const heldCompacts = new Set<string>(
    [...(holdRecord?.held ?? []).map((entry) => keyOf(entry.hrId)), ...heldDraft.map(keyOf)].filter(Boolean),
  );
  const names = new Map(directory.map((employee) => [keyOf(employee.hrId), employee.fullName]));
  const leftCompacts = new Set(
    directory.filter((employee) => isTerminalEmploymentStatus(employee.employmentStatus)).map((employee) => keyOf(employee.hrId)),
  );

  return {
    heldCount: heldCompacts.size,
    importedHistoryTrips: tripRows.filter((row) => isImportedHistoryTrip(row.expense_date)).length,
    period,
    report: reconcileExpenses({ heldCompacts, leftCompacts, month: { paid, trips }, names, nextGaps, previousGaps }),
    status: "published",
    typedByHand: expenseMonthWasTypedByHand(period.month, period.year),
  };
}

/** The months this check covers: from when Phoenix approvals began to the current Cairo month. */
export function expenseReconciliationMonths(now: Date = new Date()): ExpensePeriod[] {
  const [startYear, startMonth] = PHOENIX_OUTSTATION_APPROVALS_START.split("-").map(Number);
  const [year, month] = new Intl.DateTimeFormat("en-CA", { month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" })
    .format(now)
    .split("-")
    .map(Number);
  const out: ExpensePeriod[] = [];
  for (let index = startYear * 12 + startMonth - 1; index <= year * 12 + month - 1; index += 1) {
    out.push({ month: (index % 12) + 1, year: Math.floor(index / 12) });
  }
  return out.reverse();
}

/** The newest month with a published batch, the screen's opening month. */
export async function newestPublishedExpenseMonth(): Promise<ExpensePeriod | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("salary_batches")
    .select("month,year")
    .in("status", PUBLISHED_BATCH_STATUSES)
    .order("year", { ascending: false })
    .order("month", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not read the published months: ${error.message}`);
  const row = ((data ?? []) as Array<{ month: number; year: number }>)[0];
  return row ? { month: Number(row.month), year: Number(row.year) } : null;
}
