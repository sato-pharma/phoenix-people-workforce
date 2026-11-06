import type { AccessContext } from "@/lib/auth/permissions";
import {
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
// The old governance deduction feeders (listFingerprintDeductionCandidates,
// listCrmDeductionCandidates, syncCrmLiveMonthCandidates) are deliberately no
// longer imported. Fingerprint, CRM and unpaid vacation now read the Deductions
// module HR actually confirms in — see deductions-source.ts for why, and for
// the production numbers that proved the two systems had never been connected.
import { buildFeederStates, compactHrKey } from "@/lib/payroll/copilot/feeders.ts";
// computeResignationSettlement is no longer called here: resolveLeaverBasis in
// leaver-basis.ts owns it now, so both leaver tabs read one settlement instead
// of each computing its own.
import { computeJoinerPay, isInPeriod } from "@/lib/payroll/copilot/proration.ts";
import { deductionsCategoryLabel } from "@/lib/deductions/calculations";
// The whole-month settlement basis behind every step's four-figure summary.
// Value import into a module assemble.ts imports FROM — safe, and deliberately
// so: assemble.ts takes only `import type { PopulationMember }` back, which is
// erased at compile time, so there is no runtime cycle.
import { isResignationEmploymentStatus } from "@/lib/payroll/leaver-kind.ts";

import { assembleRows, settlementBasisFor } from "./assemble.ts";
import {
  linesFor,
  loadConfirmedDeductions,
  pendingLinesFor,
  withheldLineStatus,
  type DeductionLine,
  type EmployeeDeductions,
} from "./deductions-source.ts";
// The ONE leaver rule — days worked and the day rate — shared by the
// Resignations and Resignations CRM steps so they can never disagree again
// (owner, 2026-08-30: "the rule must be synced everywhere in the module").
import {
  leaverDayDeduction,
  prorateLeaverNet,
  resolveLeaverBasis,
} from "./leaver-basis.ts";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import {
  findDuplicateExpenseHolds,
  heldDuplicateTotal,
  type DuplicateExpenseHold,
} from "@/lib/automated-payroll/duplicate-expense-hold";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { isPayrollIneligibleEmployee } from "@/lib/payroll/eligibility.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { normalizePayrollPaymentMode, resolveFixedSalaryAmounts } from "@/lib/payroll/policy";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source-model.ts";
// The Field Workforce engine is deliberately NOT imported here: it is no longer a source of any
// DEDUCTION figure (owner rule 2026-08-04 — the Deductions module is the only source of truth),
// and the last reader of it in this file, the CRM leave-balance measurement, was retired on
// 2026-10-01 along with its loaders. The banned-call list in
// tests/automated-payroll-reads-deductions-module.test.ts keeps it out.
import { crmVisitTypeMeaningStrict } from "@/lib/crm/visit-type-meaning";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { listPriorMonthHolds } from "./draft-store.ts";
import { resolveHoldReason } from "./hold-reason.ts";
import { monthNameAndYear } from "./step-definitions.ts";
import { loadDisputeRefunds, type DisputeRefundsForEmployee } from "./dispute-refunds.ts";
import { loadStandingAdditions, type StandingAdditionsForEmployee } from "./standing-additions.ts";
import { notYetDue, type HeldBalance } from "./held-settlements.ts";
import type {
  DraftRow,
  PayrollPeriod,
  PriorHold,
  RowLifecycle,
  StepKey,
  StepRow,
  StepRowDetail,
} from "./types.ts";

/**
 * Builds each wizard step's recommendation table from the existing payroll
 * feeders (joiner/leaver proration, fingerprint/CRM/expense/vacation candidates),
 * then overlays any HR edits already saved to the run's draft rows. The wizard
 * confirms/edits these; the confirmed values become the single source of truth.
 */

export type PopulationMember = {
  employee: EmployeeDirectoryRow;
  compact: string;
  lifecycle: RowLifecycle;
  /**
   * Leaver only — the exit falls INSIDE this period, so this drives real
   * settlement proration in effectiveSalary. Deliberately stays null for anyone
   * leaving in a future month: see noticeLastWorkingDate.
   */
  lastWorkingDate: string | null;
  /**
   * Serving notice into a FUTURE month (owner case 2026-07-25, B-157: resigned
   * effective 31 Aug while being paid a normal full July salary).
   *
   * Kept strictly separate from `lastWorkingDate` because that field feeds
   * `computeResignationSettlement` — putting a future date there would prorate
   * this month's pay as though the employee had already left and UNDERPAY them.
   * This one is display-only: it exists so HR can see "resigned, leaving 31 Aug"
   * instead of the employee looking completely ordinary.
   */
  noticeLastWorkingDate: string | null;
  /** Leaver only — unpaid-leave days inside the settlement span (resignation Rule 1). */
  /**
   * On this month's sheet ONLY to be paid an earlier month's held salary (Held Salary Release, owner
   * 2026-10-26). Typically someone who resigned and was held: no longer in the payroll population, so
   * no step but the release step lists them, and assembly pays them the release and nothing else.
   */
  releaseOnly?: boolean;
};

/**
 * A person who is not in this month's population, put on the sheet only to receive a held-salary
 * release. Lifecycle "regular" with no exit date: nothing about this month is prorated for them,
 * because nothing about this month is paid to them except the release itself.
 */
export function releaseOnlyMember(employee: EmployeeDirectoryRow): PopulationMember | null {
  const compact = compactHrKey(employee.hrId);
  if (!compact) return null;
  return {
    employee,
    compact,
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
    releaseOnly: true,
  };
}

/**
 * Drops run-scoped-excluded employees (DraftRow.excluded, set via
 * excludeEmployeeFromRun) out of a run's population. Pure and separate from
 * `resolvePayrollPopulationAndSources` so it is unit-testable without a
 * database: the caller (loadRunContext in run-service.ts) supplies the members
 * and the set of excluded compact HR IDs drawn from that run's draft rows.
 */
export function filterExcludedMembers(
  members: PopulationMember[],
  excludedCompacts: ReadonlySet<string>,
): PopulationMember[] {
  if (excludedCompacts.size === 0) return members;
  return members.filter((member) => !excludedCompacts.has(member.compact));
}

function numberOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function moneyOrNull(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Splits an already-rounded total into `count` per-line amounts that sum back to
 * it EXACTLY, with the last line absorbing the rounding remainder.
 *
 * Needed because the row's money is computed once for the whole group (Base ÷ the
 * month's calendar days × days) while the new breakdown shows it per day.
 * Naively rounding total/count
 * per line makes 1,400.00 display as 3 × 466.67 = 1,400.01 — and a payroll
 * screen whose breakdown doesn't foot to its own total is worse than showing no
 * breakdown at all. Never changes the total itself. Exported for tests.
 */
export function distributeAmount(total: number, count: number): number[] {
  if (count <= 0) return [];
  const per = roundCurrency(total / count);
  const parts = Array.from({ length: count }, () => per);
  parts[count - 1] = roundCurrency(total - per * (count - 1));
  return parts;
}

/**
 * Mirrors getPayrollSalarySourcesByHrId's per-employee derivation exactly, but built
 * from an EmployeeDirectoryRow already in hand rather than re-fetching the directory.
 * Deliberately NOT calling the shared getPayrollSalarySourcesByHrId here: that function
 * always fetches the ACTIVE-ONLY directory internally, so a leaver would silently get no
 * salary source (base=0) even after the population fix below lets them through. This
 * keeps the fix fully self-contained to the Automated Payroll module — no edit to the
 * shared salary-source.ts file, per the "don't touch existing payroll files" rule.
 */
function buildSalarySource(employee: EmployeeDirectoryRow, period: PayrollPeriod): PayrollSalarySource {
  const standardAllowances = resolveStandardSalaryAllowances({
    departmentName: employee.departmentName,
    employeeHrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineName: employee.lineName,
    month: period.month,
    positionTitle: employee.positionTitle,
    year: period.year,
  });
  const extraCostOfLiving = standardAllowances.extraCostOfLiving;
  const fuelAllowance = standardAllowances.fuelAllowance;
  const socialInsurance = numberOrNull(employee.socialInsurance);
  const employmentIncomeTax = numberOrNull(employee.taxes);
  const fixedSalary = resolveFixedSalaryAmounts({
    baseSalary: numberOrNull(employee.baseSalary),
    basicSalary: numberOrNull(employee.basicSalary),
    employmentIncomeTax,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: numberOrNull(employee.grossSalary),
    netSalary: numberOrNull(employee.netSalary),
    socialInsurance,
  });
  const baseSalary = moneyOrNull(fixedSalary.baseSalary);
  // Raw, pre-derivation figures only — whether HR entered ANYTHING at all,
  // distinct from whether the derived base salary above landed above zero.
  // See PayrollSalarySource.hasAnyRawCompensationFigure's doc comment.
  const hasAnyRawCompensationFigure = [
    employee.baseSalary,
    employee.basicSalary,
    employee.grossSalary,
    employee.netSalary,
  ].some((value) => {
    const parsed = numberOrNull(value);
    return parsed !== null && parsed > 0;
  });
  return {
    baseSalary,
    employmentIncomeTax,
    extraCostOfLiving,
    fuelAllowance,
    grossSalary: baseSalary === null ? null : moneyOrNull(fixedSalary.grossSalary),
    hasAnyRawCompensationFigure,
    netSalary: baseSalary === null ? null : moneyOrNull(fixedSalary.netSalary),
    paymentMode: normalizePayrollPaymentMode(employee.salaryPaymentMode),
    paymentModeOnRecord: employee.salaryPaymentModeOnRecord !== false,
    socialInsurance,
  };
}

/**
 * The employees a run covers: every active + payroll-eligible employee, plus this
 * month's joiners and leavers (a leaver may already be terminal but must still be
 * settled). Shared by recommend + assemble so both see the exact same population.
 *
 * Uses getEmployeeDirectoryRows({includeInactive:true}) deliberately, not the plain
 * getEmployeeDirectory() — the latter is active-only and silently drops leavers before
 * this function's own isLeaver bypass ever runs (a leaver's employment_status is
 * typically already flipped to resigned by the time payroll processes their exit
 * month), which is exactly why the Resignations step showed no rows.
 */
/**
 * True when dateText's year-month is strictly AFTER the given period — i.e. still in
 * the future relative to the run being processed. Used to tell "already departed
 * before this period" apart from "departing later, still owed this period's pay."
 * Exported for tests.
 */
export function isAfterPeriod(dateText: string | null, period: PayrollPeriod): boolean {
  if (!dateText) return false;
  const match = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return false;
  return year > period.year || (year === period.year && month > period.month);
}

export async function resolvePayrollPopulation(period: PayrollPeriod): Promise<PopulationMember[]> {
  const { members } = await resolvePayrollPopulationAndSources(period);
  return members;
}

export async function resolvePayrollPopulationAndSources(period: PayrollPeriod): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  /** Every employee record, leavers included, by compact HR id — for the held-salary release. */
  directory: Map<string, EmployeeDirectoryRow>;
}> {
  const [employees, feeders] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    buildFeederStates(period),
  ]);
  const members: PopulationMember[] = [];
  const sources = new Map<string, PayrollSalarySource>();
  const directory = new Map<string, EmployeeDirectoryRow>();

  for (const employee of employees) {
    const compact = compactHrKey(employee.hrId);
    if (!compact) continue;
    if (!directory.has(compact)) directory.set(compact, employee);
    const feeder = feeders.get(compact);
    const leaverLastWorkingDate = feeder?.leaverLastWorkingDate ?? null;
    const isLeaver = Boolean(leaverLastWorkingDate);
    const isJoiner = !isLeaver && isInPeriod(employee.hireDate, period);
    // A resignation already SUBMITTED with a last working date in a LATER period is
    // still serving notice — not yet departed as of THIS period. employment_status
    // flips to a terminal value (e.g. "resigned") the moment the resignation is
    // approved, often well before the employee's actual last day, and
    // isPayrollIneligibleEmployee() alone can't distinguish "already left" from
    // "leaving later" — only `leaverLastWorkingDate` (scoped to THIS period by
    // buildFeederStates) can. Confirmed live 2026-07-25 against a real case: B-157
    // had employment_status=resigned for the July run but last_working_date=2026-08-31
    // — a full month of pay silently dropped from the entire population, every step,
    // with no error or empty-state to notice it by.
    const stillActiveThroughFutureExit = isAfterPeriod(employee.lastWorkingDate, period);

    // HIRED AFTER THIS PERIOD ENDED — not employed in this month at all, so they
    // cannot be on its sheet (owner-reported 2026-08-04: two people hired 2 Aug
    // were on the JULY sheet).
    //
    // The damage was worse than merely appearing. `isJoiner` is
    // isInPeriod(hireDate, period), which is FALSE for a future hire — an August
    // hire's month is not July — so they fell through to lifecycle "regular" and
    // were paid a FULL, UNPRORATED month they had not worked. A joiner at least
    // gets prorated; this population got the whole salary.
    //
    // Deliberately placed BEFORE the eligibility check: a future hire is
    // perfectly "active" and payroll-eligible today, so no eligibility rule
    // would ever have caught them.
    if (isAfterPeriod(employee.hireDate, period)) continue;

    // Include: active/eligible employees, a leaver this month (even if terminal now),
    // or someone serving notice into a future month (still owed this month's pay).
    if (isPayrollIneligibleEmployee(employee) && !isLeaver && !stillActiveThroughFutureExit) continue;

    members.push({
      employee,
      compact,
      lifecycle: isLeaver ? "leaver" : isJoiner ? "joiner" : "regular",
      lastWorkingDate: leaverLastWorkingDate,
      // Display-only. Never feeds proration — see the field's doc comment.
      noticeLastWorkingDate: stillActiveThroughFutureExit ? employee.lastWorkingDate : null,
    });

    const source = buildSalarySource(employee, period);
    for (const key of salarySourceLookupKeys(employee.hrId)) sources.set(key, source);
  }

  return { members, sources, directory };
}

function baseRow(member: PopulationMember): StepRow {
  return {
    hrId: member.employee.hrId,
    fullName: member.employee.fullName,
    jobTitle: member.employee.jobTitle,
    line: member.employee.lineName,
    context: {},
    values: {},
    recommended: {},
    reason: null,
    onHold: false,
    lifecycle: member.lifecycle,
  };
}

function draftMap(draftRows: DraftRow[]): Map<string, DraftRow> {
  return new Map(draftRows.map((row) => [row.employeeHrIdCompact, row]));
}

/** value from the draft when the HR already saved one, else the system recommendation. */
function pick(draftValue: number | null | undefined, recommended: number): number {
  return draftValue == null ? recommended : draftValue;
}

/** One reimbursable trip behind an employee's expense total (owner request 2026-08-01). */
export type PayoutExpenseTrip = {
  tripId: string;
  expenseDate: string;
  toDate: string;
  fromLocation: string;
  toLocation: string;
  tripType: string;
  transportationType: string;
  km: number;
  travelCost: number;
  meetingAmount: number;
  allowance: number;
  otherAmount: number;
  total: number;
  /** HR's approved payable figure. null = HR did not adjust the claim, so `total` is payable. */
  approvedAmount: number | null;
  hrApproved: boolean;
  hrStatus: string;
  description: string;
  /**
   * The row's own HR id and claimant name. Only needed for a trip belonging to nobody in the run, which
   * has no population member to name it (audit finding 45). Optional so hand-built fixtures stay valid.
   */
  hrId?: string;
  specialist?: string;
};

export type PayoutExpenseRow = {
  hr_id: string | null;
  trip_id: string | null;
  expense_date: string | null;
  to_date: string | null;
  from_location: string | null;
  to_location: string | null;
  location: string | null;
  trip_type: string | null;
  transportation_type: string | null;
  km: number | null;
  travel_cost: number | null;
  meeting_amount: number | null;
  allowance: number | null;
  other_amount: number | null;
  total: number | null;
  approved_amount: number | null;
  hr_approved: boolean | null;
  hr_status: string | null;
  /**
   * The free-text column a REJECTION is recorded in. `hr_approved` only encodes approval, so
   * without this a rejected trip is indistinguishable from a pending one — see
   * payoutExpenseRowIsPayable.
   */
  status: string | null;
  description: string | null;
  specialist?: string | null;
};

/** PostgREST's default cap — same pagination pattern as outstation/geocode-warmup.ts. */
const EXPENSE_PAGE_SIZE = 1000;

function text(value: string | null | undefined): string {
  return (value ?? "").toString().trim();
}

/**
 * Whether a payout-tagged expense row is money the payroll sheet should carry at all.
 *
 * Outstation approval is THREE-state and only one of those states lives in `hr_approved`:
 * approval is the boolean, a REJECTION is recorded in the free-text `status` column, and
 * anything else is pending (see src/lib/outstation/approval-state.ts). This read previously
 * selected neither `status` nor filtered on it, so a trip HR had explicitly rejected was summed
 * at its full claimed amount — the rejection reached the approvals screen and nothing else.
 *
 * PENDING rows deliberately stay in. This wizard IS the approval point (see the p2_expenses
 * subtitle), so HR reviews them here and zeroes anything that should not pay. Only an explicit
 * rejection is dropped, because that decision has already been made.
 *
 * Reuses expenseApprovalState rather than re-deriving the rule, so the queue the approvals
 * screen shows and the money payroll pays can never disagree about what "rejected" means —
 * including its deliberate precedence that a later approval beats a stale "Rejected" status.
 */
export function payoutExpenseRowIsPayable(
  row: Pick<PayoutExpenseRow, "hr_approved" | "status">,
): boolean {
  return expenseApprovalState({ hrApproved: row.hr_approved, status: row.status }) !== "rejected";
}

/**
 * Groups raw payout-tagged expense rows into per-employee trips, dropping rejected ones.
 *
 * Pure and exported so the exclusion rule is testable without a database: the money this
 * produces is what lands on the sheet, so it is worth pinning directly.
 */
export function buildPayoutExpenseTripMap(rows: PayoutExpenseRow[]): Map<string, PayoutExpenseTrip[]> {
  const byCompact = new Map<string, PayoutExpenseTrip[]>();
  for (const row of rows) {
    if (!payoutExpenseRowIsPayable(row)) continue;
    const compact = compactHrKey(row.hr_id ?? "");
    if (!compact) continue;
    const trips = byCompact.get(compact) ?? [];
    trips.push({
      allowance: Number(row.allowance ?? 0),
      approvedAmount:
        row.approved_amount === null || row.approved_amount === undefined
          ? null
          : Number(row.approved_amount),
      description: text(row.description),
      expenseDate: text(row.expense_date).slice(0, 10),
      fromLocation: text(row.from_location),
      hrApproved: row.hr_approved === true,
      hrStatus: text(row.hr_status),
      km: Number(row.km ?? 0),
      meetingAmount: Number(row.meeting_amount ?? 0),
      otherAmount: Number(row.other_amount ?? 0),
      toDate: text(row.to_date).slice(0, 10),
      // `location` is the legacy single-field fallback used when the upload
      // didn't split from/to (11 of 97 live rows) — same precedence as
      // outstation/geocode-warmup.ts.
      toLocation: text(row.to_location) || text(row.location),
      total: Number(row.total ?? 0),
      transportationType: text(row.transportation_type),
      travelCost: Number(row.travel_cost ?? 0),
      tripId: text(row.trip_id),
      tripType: text(row.trip_type),
      hrId: text(row.hr_id),
      specialist: text(row.specialist),
    });
    byCompact.set(compact, trips);
  }
  return byCompact;
}

/**
 * Owner-corrected expense source (2026-07-20): what payroll pays lives in the ledger,
 * `outstation_expenses`, keyed by payout_month/payout_year. `outstation_expense_requests`
 * holds each claim as submitted, not what HR decided, so it is never the money source here.
 *
 * Returns the individual TRIPS per employee, not just their sum (owner request
 * 2026-08-01: "which days, where"). recommendExpenses adds them up, so the money
 * and the breakdown can never disagree — there is one query and one list.
 *
 * Paginated: the previous single unbounded select was silently capped at
 * PostgREST's 1000-row default, which would have under-reimbursed a busy month
 * with no error. Live volumes are ~30-80 rows/month (checked 2026-08-01), so
 * this was not yet biting — the loop keeps it from ever starting. Rows are collected
 * across pages and grouped once, so the rejected-row exclusion has a single home.
 *
 * FAILS CLOSED (audit finding 35). It used to log a failed read and return whatever it had
 * collected, which is nothing, so the step showed zero employees: identical to a month nobody
 * travelled. HR confirmed it and the run published paying no reimbursement at all. A failure on a
 * later page was worse, returning earlier pages as though they were the whole month. A read that
 * fails now stops the step with a 409 whose words reach the screen.
 */
async function loadPayoutExpenseTrips(period: PayrollPeriod): Promise<Map<string, PayoutExpenseTrip[]>> {
  const collected: PayoutExpenseRow[] = [];
  try {
    for (let from = 0; ; from += EXPENSE_PAGE_SIZE) {
      // All expenses whose payout period is this payroll month. The wizard IS the HR
      // confirmation point (recommend → confirm/edit), so pending-approval rows are surfaced
      // too; HR zeroes out anything that shouldn't pay — and each trip's own hr_approved now
      // shows in the row's detail panel, so "pending" is visible rather than merely implied.
      // Rows HR explicitly REJECTED are dropped by buildPayoutExpenseTripMap below.
      // Already-imported rows are skipped so a re-run never double-pays.
      const { data, error } = await getSupabaseAdmin()
        .from("outstation_expenses")
        .select(
          "hr_id,trip_id,expense_date,to_date,from_location,to_location,location,trip_type,transportation_type,km,travel_cost,meeting_amount,allowance,other_amount,total,approved_amount,hr_approved,hr_status,status,description,specialist",
        )
        .eq("payout_month", period.month)
        .eq("payout_year", period.year)
        .is("imported_payroll_batch_id", null)
        .order("expense_date", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + EXPENSE_PAGE_SIZE - 1);
      if (error) {
        logError("Automated payroll: payout expenses load failed", {
          labels: { event: "automated_payroll_payout_expenses_load_failed", month: period.month, year: period.year },
          error,
        });
        throw new ExpenseSourceUnavailableError(period);
      }
      const rows = (data ?? []) as PayoutExpenseRow[];
      collected.push(...rows);
      if (rows.length < EXPENSE_PAGE_SIZE) break;
    }
  } catch (error) {
    // The refusal raised inside the try above is already the answer; only a THROWN read is logged here.
    if (error instanceof ExpenseSourceUnavailableError) throw error;
    logError("Automated payroll: payout expenses load threw an exception", {
      labels: { event: "automated_payroll_payout_expenses_load_threw", month: period.month, year: period.year },
      error,
    });
    throw new ExpenseSourceUnavailableError(period);
  }
  return buildPayoutExpenseTripMap(collected);
}

/** A failed expense read: a 409 whose words reach the step, never an empty list that reads as "nobody travelled". */
class ExpenseSourceUnavailableError extends Error {
  constructor(period: PayrollPeriod) {
    super(
      `Conflict: the outstation expenses for ${monthNameAndYear(period.month, period.year)} could not be read, so this ` +
        "step cannot show who is owed a reimbursement. Nothing was changed. Try again in a moment.",
    );
    this.name = "ExpenseSourceUnavailableError";
  }
}

/** "2026-06-01" for a single-day trip, "2026-06-01 → 2026-06-02" for an overnight one. */
export function formatDateRange(startIso: string, endIso: string): string {
  const start = (startIso ?? "").slice(0, 10);
  const end = (endIso ?? "").slice(0, 10);
  if (start && end && start !== end) return `${start} → ${end}`;
  return start || end || "—";
}

/**
 * The AV/CP ruling for a CRM visit type, read from the single table in
 * src/lib/crm/visit-type-meaning.ts (this used to be a hand-kept copy of that table). Strict:
 * undefined for a type the table does not list — callers treat that as CP, matching dayCellValue.
 * Annual Vacation (-4) is the only AV code; Health Day (-15), Public Holiday (-5) and Casual
 * Leave (-6) are working time. visitType 0 = a regular visit, never looked up here.
 */
export function leaverVisitTypeStatus(visitType: number): "AV" | "CP" | undefined {
  return crmVisitTypeMeaningStrict(visitType);
}

// ---- Part 1 -----------------------------------------------------------------

function recommendNewHires(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    if (member.lifecycle !== "joiner") continue;
    const source = lookupSource(sources, member.employee.hrId);
    const joiner = computeJoinerPay({
      baseSalary: roundCurrency(source?.baseSalary ?? 0),
      extraCostOfLiving: roundCurrency(source?.extraCostOfLiving ?? 0),
      fuelAllowance: roundCurrency(source?.fuelAllowance ?? 0),
      hireDate: member.employee.hireDate ?? "",
      period,
    });
    if (!joiner) continue;
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Days Worked": joiner.daysWorked,
      // Owner request 2026-08-29: the FULL month's net, shown beside the
      // prorated one so the proration can be checked on sight.
      //
      // Built from the SAME three components the proration divides, NOT from
      // employees.net_salary, so Full / calendar-days x Days Worked always
      // reconciles to the card's "Total (month)" exactly. A net_salary column
      // that disagreed with its own components would make a CORRECT proration
      // look wrong — the opposite of what this column exists to do.
      //
      // Blank ("—") rather than 0 when HR has entered no figure at all: such a
      // person is priced at nothing (see hasAnyRawCompensationFigure), and a
      // "0.00" full-month salary reads as a real zero rather than missing data.
      "Net Salary": source?.hasAnyRawCompensationFigure
        ? roundCurrency(
            roundCurrency(source.baseSalary ?? 0) +
              roundCurrency(source.extraCostOfLiving ?? 0) +
              roundCurrency(source.fuelAllowance ?? 0),
          )
        : "—",
      // A "Net (month)" context figure — this month's prorated total — used to
      // be computed here. It is gone with the column that displayed it (owner,
      // 2026-08-29): the card now totals the three editable values live, so a
      // server-side copy of the same number could only ever be the stale one.
      // Do not reinstate it as a context key "for the export" either — the xlsx
      // renders the same live total from the same declaration.
    };
    row.recommended = { baseForMonth: joiner.baseForMonth, ecolPaid: joiner.ecolPaid, fuelPaid: joiner.fuelPaid };
    row.values = {
      baseForMonth: pick(draft?.baseForMonth, joiner.baseForMonth),
      ecolPaid: pick(draft?.ecolPaid, joiner.ecolPaid),
      fuelPaid: pick(draft?.fuelPaid, joiner.fuelPaid),
    };
    rows.push(row);
  }
  return rows;
}

async function recommendResignations(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  const leavers = members.filter((member) => member.lifecycle === "leaver" && member.lastWorkingDate);
  if (leavers.length === 0) return [];

  // Owner request 2026-07-25: CRM no-activity and unpaid-vacation deductions
  // moved OUT of this step into the dedicated p1_crm / p1_unpaid_vacation tabs
  // (see recommendP1Crm / recommendP1UnpaidVacation) — they were showing up in
  // both places, which read as duplication even though it wasn't a double
  // deduction. This step now settles ONLY Base/ECoL/Fuel; the leaver's own
  // Second-Part-netting rule (owner 2026-07-20) still applies, just driven from
  // the tab that now owns the computation.
  const rows: StepRow[] = [];
  for (const member of leavers) {
    if (!member.lastWorkingDate) continue;
    const source = lookupSource(sources, member.employee.hrId);
    const draft = drafts.get(member.compact);
    // ONE resolver, shared with the Resignations CRM tab (leaver-basis.ts). Both
    // tabs now read the same day count from the same place; before 2026-08-30
    // each reconstructed it separately and they disagreed for 7 of the 20
    // settled leavers on the live August run.
    const basis = resolveLeaverBasis({
      source,
      lastWorkingDate: member.lastWorkingDate,
      period,
      draft,
      // The exit workflow records dismissals as well as resignations, so only the employee's own
      // status can say which this is — and a dismissal keeps neither allowance.
      isResignation: isResignationEmploymentStatus(member.employee.employmentStatus),
      // Somebody who joined AND left this month is a leaver here, so without the hire date their
      // settlement counts from the 1st and pays for days before they started.
      hireDate: member.employee.hireDate,
    });
    if (!basis) continue;
    const { settlement } = basis;

    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Last Working Date": member.lastWorkingDate,
      // Divisor for the client-side Days Worked -> money auto-calc. The month's
      // ACTUAL calendar days, matching dailyRate() in proration.ts. Since the
      // owner's 2026-09-12 ruling that is also dayDrivenMoney's own default, so
      // this key no longer changes the figure — it is kept because the step
      // names it explicitly and because it is ALSO the complement cap.
      "Days In Month": basis.monthDays,
      // The three monthly amounts the Days Worked field prorates. All three are
      // in context (NOT in this step's displayed contextColumns — see
      // step-definitions.ts) purely to feed that auto-calc: since the owner's
      // 2026-08-29 rule a resignation prorates the whole NET, so editing the
      // days has to move Extra Cost of Living and Fuel too, not just Base.
      "Base Salary": basis.baseSalary,
      "Extra Cost Of Living": basis.extraCostOfLiving,
      "Fuel Allowance": basis.fuelAllowance,
      // What HR actually sees displayed, labelled "Full Month Net" (owner
      // request 2026-07-25). Same quantity as Base + ECoL + Fuel above —
      // calculateNetSalary in policy.ts is exactly that sum.
      "Net Salary": basis.netSalary,
    };

    // Days Worked is now a persisted column of its own, so what HR confirmed is
    // read back verbatim rather than divided back out of the saved money. The
    // old reverse-derivation could only ever recover a BASE-shaped day count,
    // which stopped being the whole story the moment the allowances began
    // prorating too.
    const daysWorked = basis.daysWorked;
    // A settled >25th leaver is paid in full and has no day share to recompute
    // (computeResignationSettlement's other branch), so his figures come from
    // the settlement untouched.
    const prorated =
      settlement.branch === "on_or_before_25"
        ? prorateLeaverNet(basis, daysWorked)
        : {
            baseForMonth: settlement.baseForMonth,
            ecolPaid: settlement.ecolPaid,
            fuelPaid: settlement.fuelPaid,
          };

    row.recommended = {
      daysWorked: basis.recommendedDaysWorked,
      baseForMonth: settlement.baseForMonth,
      ecolPaid: settlement.ecolPaid,
      fuelPaid: settlement.fuelPaid,
    };
    row.values = {
      daysWorked,
      // A saved money figure still wins over the day-share — HR may deliberately
      // settle an amount that is not a clean multiple of a day, and overwriting
      // that with arithmetic would silently discard a decision. `prorated` is
      // what the confirmed day count is WORTH, and it is the fallback.
      baseForMonth: pick(draft?.baseForMonth, prorated.baseForMonth),
      ecolPaid: pick(draft?.ecolPaid, prorated.ecolPaid),
      fuelPaid: pick(draft?.fuelPaid, prorated.fuelPaid),
    };
    rows.push(row);
  }

  // ---- employees serving notice into a FUTURE month (owner request 2026-07-25)
  // They belong here visually — HR needs to see that they have resigned — but
  // they are still working this whole month and earn a normal full salary, so
  // they get NO settlement. `values` and `recommended` are deliberately EMPTY:
  // stepEditToPatch only writes numeric fields present in `values`, so confirming
  // this step can never stamp a prorated baseForMonth (or a zero) onto them. The
  // real settlement happens in the month they actually leave.
  for (const member of members) {
    if (!member.noticeLastWorkingDate) continue;
    const source = lookupSource(sources, member.employee.hrId);
    const row = baseRow(member);
    row.readOnly = true;
    row.readOnlyNote = `Still employed — settles ${monthNameOf(member.noticeLastWorkingDate)}`;
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Last Working Date": member.noticeLastWorkingDate,
      "Net Salary": roundCurrency(source?.netSalary ?? 0),
      "Base Salary": roundCurrency(source?.baseSalary ?? 0),
      "Days In Month": daysInPeriodMonth(period),
    };
    row.recommended = {};
    row.values = {};
    rows.push(row);
  }

  return rows;
}

/** Calendar days in the run's month — the proration divisor (see dailyRate in proration.ts). */
function daysInPeriodMonth(period: PayrollPeriod): number {
  return new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
}

/** "August 2026" for a yyyy-mm-dd date — used to say when a notice-period employee actually settles. */
function monthNameOf(dateText: string): string {
  const match = /^(\d{4})-(\d{2})/.exec(dateText.trim());
  if (!match) return "later";
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return "later";
  return monthNameAndYear(month, year);
}

/**
 * Fingerprint deductions, sourced from the Deductions module HR actually
 * confirms in (owner-reported 2026-08-03 — see deductions-source.ts for the
 * two-systems history and the production numbers that proved the split).
 *
 * Only candidates the module considers payable reach this step. Fingerprint
 * requires an explicit approval there, so a month whose candidates are all still
 * Pending recommends 0.00 — correctly. That is a decision HR has not made yet,
 * not a figure this step lost, and it is visible on the Deductions Fingerprint
 * tab rather than silently applied here.
 */
function recommendFingerprint(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const entry = deductions.get(member.compact);
    const lines = linesFor(deductions, member.compact, "fingerprint");
    const value = roundCurrency(entry?.buckets.fingerprint ?? 0);
    const days = roundCurrency(lines.reduce((sum, line) => sum + line.days, 0));
    const draft = drafts.get(member.compact);
    // An employee with nothing confirmed and nothing already saved has no reason
    // to occupy a row — same shape this step always had.
    if (value === 0 && days === 0 && draft?.fingerprintValue == null && draft?.fingerprintDays == null) {
      continue;
    }
    const source = lookupSource(sources, member.employee.hrId);
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      // Not shown in this step's contextColumns — purely so the client-side
      // Days→Value auto-calc (recommendation-step.tsx setDaysValue) has a
      // base amount to compute the day-rate from when HR types a day count by
      // hand. The divisor is the month's calendar days (ruling 2026-09-12).
      "Base Salary": roundCurrency(source?.baseSalary ?? 0),
    };
    row.recommended = { fingerprintDays: days, fingerprintValue: value };
    row.values = {
      fingerprintDays: pick(draft?.fingerprintDays, days),
      fingerprintValue: pick(draft?.fingerprintValue, value),
    };
    row.details = [
      ...deductionDetailLines(lines),
      ...pendingDeductionDetailLines(pendingLinesFor(deductions, member.compact, "fingerprint")),
    ];
    rows.push(row);
  }
  return rows;
}

/**
 * The confirmed-deduction lines behind one figure, in the shared breakdown shape
 * (see DEDUCTION_DETAIL_COLUMNS in step-definitions.ts). Built from the same
 * lines the bucket total was summed from, so the panel always foots to the row.
 */
/**
 * The line's own reason, plus the arithmetic when the charge is not simply one-day-per-date.
 *
 * Without this the breakdown shows 3.5 days against 4 dates and says nothing about the gap, which
 * is the state the owner hit on 2026-08-30: two screens quoting different numbers for the same
 * span and no way to tell from either which one was right. Today the only cause is his own
 * 2026-08-02 rule that Thursday is a half day.
 */
function deductionLineReason(line: DeductionLine): string {
  const base = line.reason || "—";
  if (line.chargeableDays === line.days) return base;
  const suffix = `${line.days} days flagged, ${line.chargeableDays} chargeable — Thursday is a half day`;
  return base === "—" ? suffix : `${base} · ${suffix}`;
}

function deductionDetailLines(lines: DeductionLine[]): StepRowDetail[] {
  return lines.map((line) => ({
    Category: deductionsCategoryLabel(line.category),
    Dates: line.dates.length ? formatDateRange(line.dates[0], line.dates[line.dates.length - 1]) : "—",
    // The CHARGEABLE count, because this column sits beside Amount and a reader checks one
    // against the other. Showing the flagged count here instead makes correct money look wrong:
    // 4 days beside a 3.5-day charge reads as an error in the amount.
    //
    // It stays a bare number on purpose — this column is numeric and the owner's standing rule
    // is that nothing in the UI wraps or truncates, so the explanation goes to Reason, which is
    // already prose, and only when there is something to explain.
    Days: line.chargeableDays,
    Amount: line.amount,
    Status: line.status,
    Reason: deductionLineReason(line),
  }));
}

/**
 * Detected-but-undecided lines, in the same breakdown shape — what the payroll
 * gate is holding back from this row's figure.
 *
 * These deliberately do NOT foot to the row: they are worth 0.00 to payroll and
 * every one of them is a decision the owner has not made yet (his rule of
 * 2026-08-03 — only what he confirmed is deducted). Showing them is what stops a
 * correct 0.00 from reading as "the system found nothing", which is precisely
 * how it read to him on 2026-08-30: "the CRM deduction is not reading any
 * deduction", while 7 undecided CRM candidates worth 14,032.26 EGP sat in the
 * Deductions module.
 *
 * The amount is shown because the missing NUMBER is the useful part, and the
 * status is rewritten to say plainly that it is not being charged — a bare
 * "Pending" beside a real figure is the ambiguity, not the cure.
 *
 * 🔴 TWO REASONS A LINE IS WITHHELD, AND THEY NEED DIFFERENT SENTENCES (owner-reported
 * 2026-10-06 — the 2026-08-30 complaint in a new disguise). Since the push cutover (owner rule
 * 2026-09-22) the gate is the PUSH, not the decision: "nothing is deducted until the Super Admin
 * pushes that specific line" (deductions-source.ts). So a line is withheld either because it has
 * not been decided, or because it WAS decided "Approved for Payroll" and never pushed.
 *
 * This function said "awaiting your approval in Deductions" for both, and for the second kind that
 * is false and falsely actionable — it tells him to repeat the one step he has already finished
 * and never names the one that is left. He approved the September unpaid-vacation candidates, read
 * the step, saw only the employee whose line he had also pushed, and reported payroll as broken.
 * Measured on production the same day: 17 approved candidates worth 11,580.17 EGP sat un-pushed
 * across four categories, every one of them labelled as awaiting his approval.
 *
 * Payroll is correct in both cases and this changes no figure — only which action the breakdown
 * asks for. Pinned by tests/deductions-approved-not-pushed-feedback.test.ts.
 */
function pendingDeductionDetailLines(lines: DeductionLine[]): StepRowDetail[] {
  return deductionDetailLines(lines).map((line) => ({
    ...line,
    Status: withheldLineStatus(String(line.Status)),
  }));
}

// ---- Part 2 -----------------------------------------------------------------

async function recommendExpenses(
  members: PopulationMember[],
  period: PayrollPeriod,
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  return buildExpenseStepRows(members, await loadPayoutExpenseTrips(period), drafts);
}

/**
 * The Outstation expenses step's rows: one per employee the payout-tagged
 * expense feeder produced trips for, PLUS one per employee HR added by hand
 * (owner request 2026-08-03).
 *
 * The manual pass is what makes "add employee" survive a page reload. A
 * hand-typed amount is written to the same `expenses` draft column a recommended
 * one uses, so assembleRows already pays it — but this function used to build
 * its row list purely by iterating trips, so the moment HR reloaded, an employee
 * with no trips vanished from the screen while still being paid. Money that is
 * on the sheet but not on the screen is exactly the failure this module exists
 * to prevent, so a draft expense with no trip behind it re-renders as its own
 * row instead.
 *
 * Setting a manual row to 0 is how HR removes it: nothing is left to pay, so it
 * stops being listed on the next load. A ZERO on a trip-backed row means
 * something different — HR reviewed real trips and refused them — and that row
 * keeps rendering because the trips loop, not this one, produces it.
 *
 * Pure (trips are passed in, not fetched) so the persistence rule is unit-tested
 * without a database.
 */
export function buildExpenseStepRows(
  members: PopulationMember[],
  tripsByCompact: Map<string, PayoutExpenseTrip[]>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const rows: StepRow[] = [];
  const outsideRun: StepRow[] = [];
  for (const [compact, trips] of tripsByCompact) {
    const member = byCompact.get(compact);
    if (!member) {
      // Trips for someone NOT in this run (audit finding 45): shown read-only, never paid from here.
      // They used to be skipped with no row, no counter and no warning.
      outsideRun.push(expenseRowOutsideRun(trips));
      continue;
    }
    const draft = drafts.get(compact);

    // THE PROPOSED FIGURE IS WHAT HR HAS ACTUALLY APPROVED — owner decision 2026-09-08.
    //
    // Until then this summed every trip the feeder returned, approved or merely undecided, on the
    // reasoning that the wizard IS the approval point and HR would zero anything that should not
    // pay. Measured against production the day it changed: the September 2026 payout carried 10
    // approved trips worth 8,806.31 and 12 undecided ones worth 5,823.07, so the step proposed
    // 14,629.38 — 66% above what the owner had approved on the Expense Approvals page. That gap
    // is what he reported, and it is why he hand-typed all 15 figures of the August run rather
    // than use the step at all.
    //
    // The undecided money is SURFACED, never dropped: it stays in `row.details` trip by trip and
    // is subtotalled into the "Awaiting Decision" context column below. That distinction is the
    // whole safety property here — his standing rule is that the system FLAGS an expense and
    // never auto-rejects one, and a figure nobody can see is indistinguishable from a refusal.
    // So this narrows what is PROPOSED, not what is visible or payable: approving the trip, or
    // typing the amount, still pays it.
    //
    // `hrApproved` alone answers the question because REJECTED trips never reach this function —
    // buildPayoutExpenseTripMap drops them upstream against the real `status` column (which a
    // PayoutExpenseTrip does not even carry), so the surviving states are approved and pending
    // only. tests/automated-payroll-rejected-expenses.test.ts pins that upstream half and is
    // deliberately untouched by this change.
    //
    // HR's reduced amount still wins on an approved trip: payableExpenseAmount is the one rule
    // every payout path shares, and an untouched row reimburses the claim exactly.

    // THE DUPLICATE-CLAIM HOLD. The same shape as the undecided money above, for the same
    // reason: an extra copy of a trip already in this run is held OUT of the proposed figure and
    // SHOWN, never dropped and never refused. Ahmed Mohamed Ahmed Mohamed Heikal was reimbursed
    // 351.00 twice for one trip to As Satamuni because nothing compared a row against the rows
    // beside it; duplicate-expense-hold.ts carries the account and the measurement.
    const duplicateHolds = findDuplicateExpenseHolds(trips);
    let value = 0;
    let awaitingDecision = 0;
    for (const trip of trips) {
      // One bucket per trip. A held copy is not also counted as awaiting a decision: the hold IS
      // the decision it is waiting for, and counting it twice would overstate what is outstanding.
      if (duplicateHolds.has(trip.tripId)) continue;
      const payable = payableExpenseAmount(trip.approvedAmount, trip.total);
      if (trip.hrApproved) value = roundCurrency(value + payable);
      else awaitingDecision = roundCurrency(awaitingDecision + payable);
    }
    const onHoldDuplicate = heldDuplicateTotal(trips, duplicateHolds);

    const tripDates = trips.map((trip) => trip.expenseDate).filter(Boolean).sort();
    const tripEndDates = trips.map((trip) => trip.toDate || trip.expenseDate).filter(Boolean).sort();

    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      // Declared as a context column since the module shipped (2026-07-20) but
      // never populated, so it rendered blank in the grid, the mobile card AND
      // the xlsx. Fixed here.
      Trips: trips.length,
      "Trip Dates": tripDates.length
        ? formatDateRange(tripDates[0], tripEndDates[tripEndDates.length - 1] ?? tripDates[tripDates.length - 1])
        : "—",
      // What this employee has waiting that the figure above does NOT include. Zero for anyone
      // whose trips are all decided, which is the state HR is working towards.
      "Awaiting Decision": awaitingDecision,
      // Extra copies of a trip already counted in the figure above. Zero for every employee in
      // every payout run Phoenix has had but one, so a non-zero here is worth opening.
      "On Hold — Duplicate": onHoldDuplicate,
    };
    row.details = tripDetailRows(trips, duplicateHolds);
    row.recommended = { expenses: value };
    row.values = { expenses: pick(draft?.expenses, value) };
    row.reasons = { expensesNote: draft?.expensesNote ?? "" };
    rows.push(row);
  }

  // Manually added employees — see this function's doc comment. Ordered after
  // the feeder rows and by name, so a hand-added row is easy to spot rather than
  // interleaved into a list HR reads as "what the system found".
  const manual: StepRow[] = [];
  for (const member of members) {
    if (tripsByCompact.has(member.compact)) continue;
    const draft = drafts.get(member.compact);
    const amount = draft?.expenses;
    if (amount == null || amount === 0) continue;
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      Trips: 0,
      "Trip Dates": "—",
    };
    // Recommended 0, not `amount`: the system recommends nothing here, and the
    // grid's diff/reset must not present a hand-typed figure as system-derived.
    row.recommended = { expenses: 0 };
    row.values = { expenses: amount };
    row.reasons = { expensesNote: draft?.expensesNote ?? "" };
    row.manual = true;
    manual.push(row);
  }
  manual.sort((left, right) => left.fullName.localeCompare(right.fullName));
  rows.push(...manual);
  outsideRun.sort((left, right) => left.fullName.localeCompare(right.fullName));
  rows.push(...outsideRun);

  return rows;
}

/**
 * The breakdown a row expands into, one line per trip. Shared by a payroll row and a row outside the run,
 * so the two can never describe the same trip differently.
 */
function tripDetailRows(
  trips: PayoutExpenseTrip[],
  duplicateHolds: Map<string, DuplicateExpenseHold> = new Map(),
): NonNullable<StepRow["details"]> {
  return trips.map((trip) => ({
    Dates: formatDateRange(trip.expenseDate, trip.toDate),
    From: trip.fromLocation || "—",
    To: trip.toLocation || "—",
    "Trip Type": trip.tripType || "—",
    Transport: trip.transportationType || "—",
    KM: trip.km,
    Travel: trip.travelCost,
    Meeting: trip.meetingAmount,
    Allowance: trip.allowance,
    Other: trip.otherAmount,
    // The payable figure, so the visible breakdown always adds up to the reimbursed total.
    // When HR reduced a claim this is below the sum of the components above — that gap IS the
    // approval decision, and the original claim stays on the Expense Approvals page.
    Total: payableExpenseAmount(trip.approvedAmount, trip.total),
    // hr_status is blank on every live row, so hr_approved is the real signal;
    // fall back to hr_status only if a future import starts populating it.
    "HR Approved": trip.hrApproved ? "Yes" : trip.hrStatus || "Not yet approved",
    Description: trip.description || "—",
    "Trip ID": trip.tripId || "—",
    // Plain words when this trip is an extra copy of another in the same run, and a dash when it
    // is not, so the column reads the same on every line rather than appearing only on a bad one.
    "On Hold": duplicateHolds.get(trip.tripId)?.reason ?? "—",
  }));
}

/**
 * Approved or pending trips tagged to this payout for someone who is NOT in this run (audit finding 45).
 *
 * A rep who left in an earlier month, or someone HR excluded, had these skipped with no row, no counter
 * and no warning: money approved on the Expense Approvals page that was neither paid, listed nor flagged,
 * and never stamped either, so no later report showed it outstanding. Measured 2026-09-11, the two
 * published months carried none, so this is preventive.
 *
 * READ-ONLY on purpose, and carrying no values: paying someone the run does not carry would put a stranger
 * on the sheet. `saveStep` and `confirmStep` both skip read-only rows; the note says what to do instead.
 */
function expenseRowOutsideRun(trips: PayoutExpenseTrip[]): StepRow {
  // The duplicate-claim hold applies here too, and for a reason beyond consistency: this row's
  // note is a statement of what is still OWED outside payroll, so a duplicated trip counted into
  // it would be an overstatement in the one place someone reads to settle up by hand.
  const duplicateHolds = findDuplicateExpenseHolds(trips);
  let approved = 0;
  let awaitingDecision = 0;
  for (const trip of trips) {
    if (duplicateHolds.has(trip.tripId)) continue;
    const payable = payableExpenseAmount(trip.approvedAmount, trip.total);
    if (trip.hrApproved) approved = roundCurrency(approved + payable);
    else awaitingDecision = roundCurrency(awaitingDecision + payable);
  }
  const onHoldDuplicate = heldDuplicateTotal(trips, duplicateHolds);
  const hrId = trips.find((trip) => trip.hrId)?.hrId ?? "";
  const name = trips.find((trip) => trip.specialist)?.specialist ?? "";
  const tripDates = trips.map((trip) => trip.expenseDate).filter(Boolean).sort();
  const tripEndDates = trips.map((trip) => trip.toDate || trip.expenseDate).filter(Boolean).sort();
  const egp = (value: number) =>
    `EGP ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    hrId,
    fullName: name || hrId,
    jobTitle: null,
    line: null,
    context: {
      "Hire Date": "",
      Trips: trips.length,
      "Trip Dates": tripDates.length
        ? formatDateRange(tripDates[0], tripEndDates[tripEndDates.length - 1] ?? tripDates[tripDates.length - 1])
        : "—",
      "Awaiting Decision": awaitingDecision,
      "On Hold — Duplicate": onHoldDuplicate,
    },
    values: {},
    recommended: {},
    reason: null,
    onHold: false,
    details: tripDetailRows(trips, duplicateHolds),
    readOnly: true,
    readOnlyNote:
      `Not in this month's payroll run, so nothing here is paid: ${egp(approved)} approved and ` +
      `${egp(awaitingDecision)} awaiting decision` +
      (onHoldDuplicate > 0
        ? `, plus ${egp(onHoldDuplicate)} held as a duplicate of a trip already counted here — ` +
          `check the two before settling it`
        : "") +
      `. Pay it outside payroll, or put them back in the run.`,
  };
}

/**
 * THE PART 2 VACATION CONFIRM WRITES NO LEAVE-BALANCE ROW, AND MUST NOT BE GIVEN ONE AGAIN.
 *
 * A `settleCrmLeaveBalanceForPeriod` used to live here. It wrote one
 * `public.payroll_copilot_vacation_settlements` row per employee with CRM-only annual leave, to
 * draw those days off the balance durably rather than only as that month's payroll-sheet figure.
 *
 * IT NEVER WORKED, AND IT DESTROYED ROWS WHILE FAILING. It set `run_id` to an
 * `automated_payroll_runs` id, but the column is a foreign key onto `payroll_copilot_runs` — no
 * automated run id has ever satisfied it, so every insert was refused `23503`, logged, and skipped.
 * The supersede that ran FIRST was scoped to `employee_hr_id_compact` + `start_date` alone and its
 * error was discarded, so each confirm retired whatever live row held that slot and replaced it
 * with nothing. On 2026-08-04 07:49:03 Cairo the July run retired Khaled Mohamed Ali Bedair's
 * 1.00-day balance settlement of 2026-07-12, written by `system:crm-correction-2026-07-21`. All 8
 * `p2_vacation` confirms on production recorded `crmLeaveBalanceSettled` null; the ledger holds no
 * row any automated run wrote.
 *
 * SO THERE IS ONE MECHANISM, NOT TWO (owner's decision, 2026-10-01).
 * `scripts/import-crm-vacation-backfill.ts` imports each CRM vacation signal as a real Phoenix
 * request in `v2_vacation_requests`, where it draws the balance down the ordinary way, is visible
 * to HR, and can be corrected. It has done so all year: 468 requests, 415 days, January–August
 * 2026, imported 2026-08-03 and 2026-08-24 — which is why the July confirm found zero CRM-only
 * days left to settle.
 *
 * RESTORING A SETTLEMENT WRITE HERE RE-CREATES A DOUBLE DRAW-DOWN, measured, not hypothetical.
 * `approvedPaidDaysInPeriod` in vacation/service.ts returns requestDays + settledDays +
 * attendanceDays, so a ledger row and an imported request covering the same day are BOTH charged.
 * Production already carries one such pair. If this ever has to come back, the importer has to be
 * retired in the same change — and the foreign key fixed first.
 *
 * Pinned by `tests/automated-payroll-crm-leave-one-mechanism.test.ts`.
 */

/**
 * Unpaid-vacation deductions for continuing two-part employees, sourced from the
 * Deductions module HR confirms in (owner-reported 2026-08-03 — see
 * deductions-source.ts). Covers BOTH of the module's vacation categories,
 * `unpaid_vacation` and `insufficient_balance_vacation`, which share the same
 * `unpaid_vacations` salary column there.
 *
 * Both require an explicit "Approved for Payroll" in the module, so nothing is
 * deducted here that HR has not decided.
 *
 * THE LEAVE-BALANCE DRAW-DOWN DOES NOT HAPPEN IN THE CONFIRM AT ALL ANY MORE.
 * This paragraph used to say the confirm "still settles CRM-only leave against
 * the balance ledger", through a `computeVacationDeductionTotals` that lived in
 * this file. That stopped being true on 2026-10-01: the settlement write is
 * REMOVED, `scripts/import-crm-vacation-backfill.ts` is the one path a CRM leave
 * day reaches a balance by (owner's decision), and the measurement function left
 * behind it — which nothing ever called again — was deleted on the same ruling.
 * Both are recoverable from git history if the figure is ever wanted on a screen.
 * The standing note further down, where that write used to live, carries the
 * account and the reason it must not be rebuilt — DO NOT read this paragraph as
 * evidence a draw-down still runs here.
 *
 * What survives unchanged is the distinction it was drawing: leave BOOKKEEPING is
 * a different question from what salary is deducted, and sourcing the money from
 * the Deductions module does not change how many balance days an employee
 * consumed. The bookkeeping is simply the importer's job now.
 */
function recommendVacation(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    // Leavers AND one-part employees are settled in Part 1 — never here, to avoid
    // double-deducting the same days. See isSettledInPart1.
    if (isSettledInPart1(member, source, drafts.get(member.compact)?.settledInPart1)) continue;
    const lines = linesFor(deductions, member.compact, "unpaidVacation");
    const amount = roundCurrency(deductions.get(member.compact)?.buckets.unpaidVacation ?? 0);
    const draft = drafts.get(member.compact);

    // This step is "Vacation (NO balance)" — it exists to decide salary
    // deductions. An employee who owes nothing has nothing for HR to decide, so
    // listing them is noise (owner, 2026-08-01). A row HR has typed a value into
    // is always kept, so an edit can never disappear.
    if (amount === 0 && (draft?.unpaidVacations ?? 0) === 0) continue;

    const days = roundCurrency(lines.reduce((sum, line) => sum + line.days, 0));
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Confirmed Lines": lines.length,
      // Not shown in this step's contextColumns — the client-side Days→Value
      // auto-calc (recommendation-step.tsx setDaysValue) reads it directly.
      "Base Salary": roundCurrency(source?.baseSalary ?? 0),
    };
    row.details = [
      ...deductionDetailLines(lines),
      ...pendingDeductionDetailLines(pendingLinesFor(deductions, member.compact, "unpaidVacation")),
    ];
    row.recommended = { p2VacationDays: days, unpaidVacations: amount };
    row.values = {
      p2VacationDays: days,
      unpaidVacations: pick(draft?.unpaidVacations, amount),
    };
    rows.push(row);
  }
  rows.sort((left, right) => (right.values.unpaidVacations ?? 0) - (left.values.unpaidVacations ?? 0));
  return rows;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** "Tuesday" for a yyyy-mm-dd date, "" if unparseable. Exported for tests. */
export function weekdayName(dateIso: string): string {
  const ms = Date.parse(`${(dateIso ?? "").slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return "";
  return WEEKDAY_NAMES[new Date(ms).getUTCDay()];
}


/**
 * CRM no-activity deductions for continuing two-part employees, sourced from the
 * Deductions module HR confirms in (owner-reported 2026-08-03 — see
 * deductions-source.ts).
 *
 * 🔴 CRM IS THE MODULE'S ONE MANDATORY CATEGORY ("whoever has N days must be
 * deducted") — AND THAT RULE DOES NOT APPLY HERE. In the module a pending CRM
 * row publishes unless HR clears it; on this step it pays NOTHING until it is
 * explicitly "Approved for Payroll", exactly like every other category. That is
 * the owner's 2026-08-03 rule for money, and buildDeductionBuckets is where it
 * is enforced — this function just spends what that gate released.
 *
 * Do not "restore consistency" by reinstating mandatory-unless-cleared here. It
 * would immediately release every pending CRM row, including the district-manager
 * no-record days that #1654 made never-auto-publish — measured on production
 * 2026-08-04, one such July row worth 8,709.68 EGP is sitting at Pending right
 * now. Pinned by tests/payroll-deduction-gate-composes-with-publish-rule.test.ts.
 *
 * The isSettledInPart1 skip is unchanged and load-bearing: leavers and one-part
 * employees settle in Part 1, and deducting them here as well would charge the
 * same days twice. Guarded by tests/automated-payroll-part1-scope.test.ts.
 */
function recommendCrm(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (isSettledInPart1(member, source, drafts.get(member.compact)?.settledInPart1)) continue;
    const lines = linesFor(deductions, member.compact, "crm");
    const value = roundCurrency(deductions.get(member.compact)?.buckets.crm ?? 0);
    const draft = drafts.get(member.compact);
    if (value === 0 && draft?.crm == null) continue;

    // CHARGEABLE days — this field carries `autoCalcMoneyKey: "crm"`, so the moment anyone
    // touches the row the amount is recomputed as day-rate x this number. The flagged count
    // would charge a Thursday in full and silently overwrite the module's weighted amount.
    const days = roundCurrency(lines.reduce((sum, line) => sum + line.chargeableDays, 0));
    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Confirmed Lines": lines.length,
      "Base Salary": roundCurrency(source?.baseSalary ?? 0),
    };
    row.details = [
      ...deductionDetailLines(lines),
      ...pendingDeductionDetailLines(pendingLinesFor(deductions, member.compact, "crm")),
    ];
    row.recommended = { p2CrmDays: days, crm: value };
    row.values = { p2CrmDays: days, crm: pick(draft?.crm, value) };
    rows.push(row);
  }
  rows.sort((left, right) => (right.values.crm ?? 0) - (left.values.crm ?? 0));
  return rows;
}

/**
 * Part 2 Additions. Recommends zero, except where a standing addition falls due this month
 * (standing-additions.ts — owner request 2026-09-13, a quarterly incentive that was forgotten in
 * August because this step had no feeder). A value HR already saved on the draft row always wins,
 * and the standing reason is offered only while HR has not saved the row's additions themselves —
 * otherwise a figure HR changed would carry an explanation written for a different one.
 *
 * Other additions is pre-filled the same way from a DISPUTE REFUND falling due this month
 * (dispute-refunds.ts — owner, 2026-10-09: a deduction a reopened dispute cancels after its own
 * month was paid is given back "in additions, other"). Same two rules: HR's saved figure wins, and
 * the refund's reason is offered only while HR has not saved Other additions themselves.
 *
 * 🔴 A SAVED **ZERO** IN OTHER ADDITIONS NEVER SUPPRESSES THE REFUND'S REASON. Confirming this step
 * persists every visible row, so a zero there is as likely to be the whole grid's untouched default
 * as anybody's decision — and the drift check's remedy is to confirm the step again, which swaps the
 * refund back onto the row (`takeCurrentModuleFigures`). With the reason suppressed, that confirm
 * was then refused outright by `assertAdditionsReasonsPresent` — money with no reason — and the
 * refund had no way through at all. A zero explains nothing and needs no explanation, so offering
 * the reason beside one can mislead nobody; a figure HR actually typed still suppresses it.
 */
export function recommendAdditions(
  members: PopulationMember[],
  drafts: Map<string, DraftRow>,
  standing: Map<string, StandingAdditionsForEmployee> = new Map(),
  refunds: Map<string, DisputeRefundsForEmployee> = new Map(),
): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const due = standing.get(member.compact);
    const refund = refunds.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    const incentive = due?.incentive ?? 0;
    const bonus = due?.bonus ?? 0;
    const otherAdditions = refund?.amount ?? 0;
    row.recommended = { incentive, bonus, overtime: 0, otherAdditions };
    row.values = {
      incentive: pick(draft?.incentive, incentive),
      bonus: pick(draft?.bonus, bonus),
      overtime: pick(draft?.overtime, 0),
      otherAdditions: pick(draft?.otherAdditions, otherAdditions),
    };
    const hrSavedAdditions = draft?.incentive != null || draft?.bonus != null;
    const hrSavedOther = draft?.otherAdditions != null && Math.abs(Number(draft.otherAdditions)) >= 0.005;
    const offered = [hrSavedAdditions ? null : (due?.reason ?? null), hrSavedOther ? null : (refund?.reason ?? null)].filter(
      (reason): reason is string => Boolean(reason),
    );
    row.reason = draft?.additionsReason ?? (offered.length > 0 ? offered.join("; ") : null);
    return row;
  });
}

/**
 * Everyone a saved Held Salary Release pays who is NOT in this month's population — typically a
 * resigned employee whose last Part 2 was withheld. Assembly gives each a release-only row
 * (assemble.ts assembleReleaseOnlyRow).
 *
 * Their salary source is added to `sources` when missing, so the sheet shows their contract salary
 * the way it does for everyone else. A release saved for someone with no employee record at all is
 * left out here, and Part 2 confirm and publish refuse it by name rather than drop the money.
 */
export function releaseOnlyMembersFor(input: {
  members: PopulationMember[];
  directory: Map<string, EmployeeDirectoryRow>;
  draftRows: DraftRow[];
  sources: Map<string, PayrollSalarySource>;
  period: PayrollPeriod;
}): PopulationMember[] {
  const listed = new Set(input.members.map((member) => member.compact));
  const result: PopulationMember[] = [];
  for (const draft of input.draftRows) {
    // A release in either instalment puts them on the sheet (owner, 2026-10-26: "it should be also in part one").
    const released = Number(draft.heldReleaseValue ?? 0) > 0 || Number(draft.heldReleaseP1Value ?? 0) > 0;
    if (draft.excluded || !released) continue;
    const compact = compactHrKey(draft.employeeHrIdCompact);
    if (!compact || listed.has(compact)) continue;
    const employee = input.directory.get(compact);
    const member = employee ? releaseOnlyMember(employee) : null;
    if (!employee || !member) continue;
    if (!lookupSource(input.sources, employee.hrId)) {
      const source = buildSalarySource(employee, input.period);
      for (const key of salarySourceLookupKeys(employee.hrId)) input.sources.set(key, source);
    }
    listed.add(compact);
    result.push(member);
  }
  return result;
}

/**
 * "Held Salary Release", in Part 1 and in Part 2 (owner, 2026-10-26: "if someone's salary is held, it's
 * not added afterwards"; "it should be also in part one").
 *
 * One row per person who has money an earlier PUBLISHED month withheld and that is still owed —
 * withheld less whatever was settled by hand (held-settlements.ts) — plus anyone who already has a
 * release saved on this run, so a saved figure never vanishes from the screen that set it.
 *
 * Most of these people are no longer in the population (they resigned, and that is why they were
 * held), so the row is built from the employee record rather than from `members`. The recommended
 * figure is everything due now — the outstanding balance less pay deferred to a LATER month
 * (owner, 2026-10-26); the step can lower it, never raise it above the outstanding (saveStep).
 *
 * `part1Corrections` is what HR has entered as "Part 1 Not Paid" against the previous published month,
 * by compact HR id: shown in that column, and anyone with an entry is listed even once it is paid off,
 * so a saved figure never vanishes from the screen that set it.
 *
 * `part` picks the instalment. Part 2's Outstanding is what is left after this month's Part 1 released
 * its share — the balances leave out this run's own reservation, so without it Part 1's release would
 * be offered a second time.
 */
export function recommendHeldRelease(
  members: PopulationMember[],
  directory: Map<string, EmployeeDirectoryRow>,
  drafts: Map<string, DraftRow>,
  heldBalances: Map<string, HeldBalance[]>,
  period: PayrollPeriod,
  part1Corrections: Map<string, number> = new Map(),
  part: 1 | 2 = 2,
): StepRow[] {
  const field = part === 1 ? "heldReleaseP1Value" : "heldReleaseValue";
  const memberByCompact = new Map(members.map((member) => [member.compact, member]));
  const compacts = new Set<string>(heldBalances.keys());
  for (const [compact, draft] of drafts) {
    const saved = Number(draft.heldReleaseValue ?? 0) > 0 || Number(draft.heldReleaseP1Value ?? 0) > 0;
    if (!draft.excluded && saved) compacts.add(compact);
  }
  for (const [compact, amount] of part1Corrections) {
    if (amount > 0) compacts.add(compact);
  }
  const rows: StepRow[] = [];
  for (const compact of compacts) {
    const draft = drafts.get(compact);
    if (draft?.excluded) continue;
    const balances = [...(heldBalances.get(compact) ?? [])].sort(
      (a, b) => a.year - b.year || a.month - b.month,
    );
    const employee = memberByCompact.get(compact)?.employee ?? directory.get(compact) ?? null;
    const member = memberByCompact.get(compact) ?? (employee ? releaseOnlyMember(employee) : null);
    const row: StepRow = member
      ? baseRow(member)
      : {
          hrId: balances[0]?.hrId ?? draft?.employeeHrId ?? compact,
          fullName: balances[0]?.name ?? "",
          jobTitle: null,
          line: null,
          context: {},
          values: {},
          recommended: {},
          reason: null,
          onHold: false,
          lifecycle: "regular",
        };
    const sum = (pickAmount: (balance: HeldBalance) => number) =>
      roundCurrency(balances.reduce((total, balance) => total + pickAmount(balance), 0));
    // What this month's Part 1 released — paid unless they were withheld at Part 1 (assemble.ts).
    const releasedInPart1 =
      part === 2 && !(draft?.part1Withheld ?? draft?.onHold)
        ? Math.max(0, roundCurrency(Number(draft?.heldReleaseP1Value ?? 0)))
        : 0;
    const outstanding = Math.max(0, roundCurrency(sum((balance) => balance.outstanding) - releasedInPart1));
    // Deferred pay whose month has not come yet: owed, but not recommended before its month.
    const notDue = notYetDue(balances, period);
    const dueNow = Math.max(0, roundCurrency(outstanding - notDue));
    const part1NotPaid = roundCurrency(part1Corrections.get(compact) ?? 0);
    row.context = {
      "Held Month": balances.map((balance) => monthNameAndYear(balance.month, balance.year)).join(", "),
      "Part 1 Already Paid": sum((balance) => balance.firstPartAlreadyPaid),
      "Part 1 Withheld": sum((balance) => balance.firstPartWithheld),
      "Part 2 Withheld": sum((balance) => balance.secondPartWithheld),
      Deferred: sum((balance) => balance.deferred),
      "Settled By Hand": sum((balance) => balance.settled?.amount ?? 0),
      "Released In Payroll": sum((balance) => balance.releasedByPayroll),
      ...(part === 2 ? { "Released In Part 1": releasedInPart1 } : {}),
      Outstanding: outstanding,
      "Not Yet Due": notDue,
    };
    row.recommended = { [field]: dueNow, part1NotPaid };
    row.values = { [field]: pick(draft?.[field], dueNow), part1NotPaid };
    rows.push(row);
  }
  return rows.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

/**
 * Part 1 "Defer Pay" (owner, 2026-10-26: "it should be also in part one"): every member, with the Part 1
 * the deferral may come off.
 *
 * "Part 1" is the row's live First Part WITHOUT its own deferral — the most that can be deferred, and
 * the same figure assemble.ts caps it at — read from the assembly Part 1 confirm freezes. Nothing is
 * recommended: 0 unless HR types an amount.
 */
function recommendPayDeferralP1(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  draftRows: DraftRow[],
  drafts: Map<string, DraftRow>,
  period: PayrollPeriod,
): StepRow[] {
  const assembled = new Map(
    assembleRows({ members, sources, draftRows, period, part1Confirmed: false }).map((entry) => [entry.compact, entry]),
  );
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    const entry = assembled.get(member.compact);
    const part1 = entry ? roundCurrency(entry.row.firstPart + entry.payDeferralPart1Applied) : 0;
    row.context = { ...row.context, "Hire Date": member.employee.hireDate ?? "", "Part 1": part1 };
    row.recommended = { payDeferralP1Value: 0 };
    row.values = { payDeferralP1Value: pick(draft?.payDeferralP1Value, 0) };
    row.selects = { payDeferralP1Month: draft?.payDeferralP1Month ?? "next" };
    return row;
  });
}

/**
 * Part 2 "Defer Pay" (owner, 2026-10-26): every member, with the Part 2 the deferral may come off.
 *
 * "Part 2" is the row's second instalment WITHOUT its own deferral — the most that can be deferred,
 * and the same figure assemble.ts caps the deferral at — read from the same assembly the bank files
 * use, so the screen, the cap and the payment cannot disagree. Nothing is recommended: 0 unless HR
 * types an amount.
 */
function recommendPayDeferral(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  draftRows: DraftRow[],
  drafts: Map<string, DraftRow>,
  period: PayrollPeriod,
  carryForwardByCompact: Map<string, number> | undefined,
): StepRow[] {
  const assembled = new Map(
    assembleRows({ members, sources, draftRows, period, part1Confirmed: true, carryForwardByCompact }).map(
      (entry) => [entry.compact, entry],
    ),
  );
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    const entry = assembled.get(member.compact);
    const part2 = entry ? roundCurrency(entry.row.secondPart + entry.payDeferralApplied) : 0;
    row.context = { ...row.context, "Hire Date": member.employee.hireDate ?? "", "Part 2": part2 };
    row.recommended = { payDeferralValue: 0 };
    row.values = { payDeferralValue: pick(draft?.payDeferralValue, 0) };
    row.selects = { payDeferralMonth: draft?.payDeferralMonth ?? "next" };
    return row;
  });
}

/**
 * Part 2 "Any more deductions?" — HR's free-text catch-all, now ALSO the landing
 * place for confirmed loan / other deductions from the Deductions module for
 * continuing two-part employees (owner request 2026-08-03).
 *
 * Those two categories previously had nowhere to go for this population: the
 * Part 1 Other Deductions tab is scoped to `isSettledInPart1` employees, so a
 * confirmed loan for an ordinary two-part employee was approved in the module
 * and then silently reached no step at all. The same predicate splits the two
 * populations here, so a given employee's loan/other is offered in exactly one
 * place and can never be charged twice.
 */
function recommendManualDeductions(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    const source = lookupSource(sources, member.employee.hrId);
    // Settled-in-Part-1 employees take their loan/other on the Part 1 tab.
    const settledInPart1 = isSettledInPart1(member, source, draft?.settledInPart1);
    const lines = settledInPart1
      ? []
      : [...linesFor(deductions, member.compact, "loan"), ...linesFor(deductions, member.compact, "other")];
    const days = roundCurrency(lines.reduce((sum, line) => sum + line.days, 0));
    const confirmed = settledInPart1
      ? 0
      : roundCurrency(
          (deductions.get(member.compact)?.buckets.loan ?? 0) +
            (deductions.get(member.compact)?.buckets.other ?? 0),
        );
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Base Salary": roundCurrency(source?.baseSalary ?? 0),
    };
    row.recommended = { p2ManualDeductionDays: days, manualOtherDeductions: confirmed };
    row.values = {
      p2ManualDeductionDays: days,
      manualOtherDeductions: pick(draft?.manualOtherDeductions, confirmed),
    };
    row.reason = draft?.manualReason ?? null;
    // Undecided lines are listed for the same population the charged ones are —
    // an employee settled in Part 1 takes loan/other on the Part 1 tab, so
    // surfacing his withheld lines HERE would show the same decision on two
    // screens and invite it being made twice.
    row.details = [
      ...deductionDetailLines(lines),
      ...pendingDeductionDetailLines(
        settledInPart1
          ? []
          : [
              ...pendingLinesFor(deductions, member.compact, "loan"),
              ...pendingLinesFor(deductions, member.compact, "other"),
            ],
      ),
    ];
    return row;
  });
}

/**
 * THE PART 1 / PART 2 SPLIT RULE (owner-decided 2026-07-25). Whether an employee's
 * CRM / unpaid-vacation deduction is settled in Part 1 rather than Part 2:
 *
 *  - leaver    → settled in Part 1 (they won't be present for Part 2 at all; their
 *                CRM + vacation are auto-computed on the Resignations step).
 *  - one_part  → settled in Part 1. They have no meaningful Second Part to net a
 *                Part-2 deduction against, so deducting there clamps their Second
 *                Part to 0 and strands the remainder in `overpaidResidual` (money
 *                the company never recovers). Reducing the frozen First Part
 *                directly — via the Part 1 manual tabs — actually lands.
 *  - two_parts → NOT settled in Part 1; handled automatically in Part 2.
 *
 * This single predicate is deliberately used in BOTH directions so the two
 * populations stay disjoint and no employee can be deducted twice for the same
 * thing: the Part 1 manual tabs show only employees where this is true, and
 * recommendVacation / recommendCrm (Part 2) skip exactly those same employees.
 * Guarded by tests/automated-payroll-part1-scope.test.ts — if you change this,
 * change both call sites or you reintroduce a double-deduction.
 *
 * ONCE PART 1 IS CONFIRMED THE ANSWER IS READ, NOT RECOMPUTED. Both inputs move:
 * a payment mode is corrected, somebody resigns mid-month. The columns this
 * routes money into do not move, so re-deciding after the fact charged a loan in
 * Part 1 and offered it again in Part 2, or moved it out of both and never took
 * it at all. `confirmPart1` stamps the answer onto the draft row beside the
 * frozen First Part; from that moment this returns the stamp. A null stamp means
 * Part 1 is not confirmed yet — and the live rule is then the right answer.
 */
export function isSettledInPart1(
  member: Pick<PopulationMember, "lifecycle">,
  source: Pick<PayrollSalarySource, "paymentMode"> | undefined,
  frozen?: boolean | null,
): boolean {
  if (frozen != null) return frozen;
  return member.lifecycle === "leaver" || source?.paymentMode === "one_part";
}

function part1ManualDeductionBaseRow(
  member: PopulationMember,
  source: PayrollSalarySource | undefined,
): StepRow {
  const row = baseRow(member);
  row.context = {
    "Hire Date": member.employee.hireDate ?? "",
    // "Base Salary" is kept in context (NOT in this step's displayed contextColumns —
    // see step-definitions.ts) purely because the client-side Days→Value auto-calc
    // reads row.context["Base Salary"] to compute Base ÷ the month's calendar days × days
    // (recommendation-step.tsx setDaysValue) — the divisor moved off a flat 30 on
    // 2026-09-12. "Net Salary" is the number HR actually sees displayed (owner
    // request 2026-07-25: show Net, not Base, in the UI).
    "Base Salary": roundCurrency(source?.baseSalary ?? 0),
    "Net Salary": roundCurrency(source?.netSalary ?? 0),
    // Blank for continuing (non-leaver) one-part employees — only leavers have one.
    //
    // Labelled "Last Working Date" because that is exactly what it is. Six Part 1
    // steps used to head this same value "Resignation Date", which is a DIFFERENT
    // column in employee_resignations: 4 of 54 live exit records have the two
    // dates apart (Mohamed Yasser resigned 2 Aug, last worked 6 Aug; Ahmed
    // Abdallah 28 vs 31 Aug). The exit form copies one date into all four of its
    // date columns in the other 92.6%, which is why the wrong heading survived —
    // and why the Resignations step (correctly headed "Last Working Date") and
    // the Resignations CRM step looked like they disagreed when they did not.
    // The settlement has always keyed off the last working date; only the heading
    // was wrong. Owner-reported 2026-08-30.
    "Last Working Date": member.lastWorkingDate ?? "",
  };
  return row;
}

function recommendP1Crm(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source, drafts.get(member.compact)?.settledInPart1)) continue;
    // This month's resignations moved to their own dedicated Resignations CRM
    // tab (owner request 2026-07-26 — see recommendResignationCrm), because a
    // leaver's CRM rules differ: the Working/Non-Working split caps at his DAYS
    // WORKED, not the whole month. This tab is one-part CONTINUING employees
    // only, and their split caps at the whole month.
    //
    // THE DIVISOR IS NO LONGER ONE OF THE DIFFERENCES. This comment used to say
    // the tab kept "the old whole-month /30 behavior" for continuing employees;
    // the owner's ruling of 2026-09-12 (audit finding 37) retired that flat rate
    // on every day-driven field, so both tabs now divide by the month's own
    // calendar days. See dayDrivenMoney in step-definitions.ts.
    if (member.lifecycle === "leaver") continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    // Working/Non-Working Days cap (owner request 2026-07-25) — the real
    // calendar day count. The money divisor is the same figure here, but the cap
    // stays a SEPARATE field from it: on the Resignations CRM tab the cap is the
    // leaver's days worked while the divisor is still the whole month. See
    // StepFieldSpec.complementTotalContextKey's doc for why they must not merge.
    const daysInMonth = daysInPeriodMonth(period);
    row.context["Days In Month"] = daysInMonth;

    // CRM comes from the Deductions module like every other deduction (owner
    // rule 2026-08-04) — this tab used to recommend a flat 0 and rely on HR
    // retyping a figure they had already confirmed elsewhere.
    const lines = linesFor(deductions, member.compact, "crm");
    const confirmedValue = roundCurrency(deductions.get(member.compact)?.buckets.crm ?? 0);
    // CHARGEABLE days — `p1odCrmDays` carries `autoCalcMoneyKey: "p1odCrmValue"`, so this number
    // becomes the money multiplier as soon as the row is edited. Same Thursday weighting the
    // module already applied when it priced the candidate.
    const confirmedDays = roundCurrency(lines.reduce((sum, line) => sum + line.chargeableDays, 0));

    const nonWorkingDays = pick(draft?.p1odCrmDays, confirmedDays);
    row.recommended = {
      p1odCrmWorkingDays: Math.max(0, daysInMonth - confirmedDays),
      p1odCrmDays: confirmedDays,
      p1odCrmValue: confirmedValue,
    };
    row.values = {
      p1odCrmWorkingDays: Math.max(0, daysInMonth - nonWorkingDays),
      p1odCrmDays: nonWorkingDays,
      p1odCrmValue: pick(draft?.p1odCrmValue, confirmedValue),
    };
    row.reasons = { p1odCrmReason: draft?.p1odCrmReason ?? "" };
    row.details = [
      ...deductionDetailLines(lines),
      ...pendingDeductionDetailLines(pendingLinesFor(deductions, member.compact, "crm")),
    ];
    rows.push(row);
  }
  return rows;
}

/**
 * Leaver CRM deduction rate — UNIFIED with the resignation settlement (owner
 * rule 2026-07-26): ÷ the month's ACTUAL calendar days × days.
 *
 * That used to be this function's exception — continuing employees were on a
 * flat 30 until the owner's ruling of 2026-09-12 (audit finding 37) put every
 * day-driven field on the month's own length. It is now the one rate the whole
 * system uses, so a caller must not read "unified with the settlement" as
 * meaning anything else is still on a different divisor.
 *
 * `monthlyAmount` is the leaver's NET for a whole month — Base + Extra Cost of
 * Living + Fuel. It was the BASE alone until 2026-08-30, which broke the very
 * unification this function exists for: the owner moved the settlement to
 * prorate the whole net on 2026-08-29, so from that day a no-activity day cost
 * strictly LESS than the day of pay it was meant to cancel. He named it the next
 * day — *"in the CRM, it must prorate the net salary"* — and this is that rule.
 *
 * Callers should not compute the amount themselves: `leaverDayDeduction` in
 * leaver-basis.ts wraps this over the one resolved basis, and is what the step
 * uses. This stays exported because it is pure and deterministic, so the rule
 * can be pinned directly by a unit test.
 */
export function resignationCrmDeduction(monthlyAmount: number, days: number, period: PayrollPeriod): number {
  const monthDays = daysInPeriodMonth(period);
  if (monthlyAmount <= 0 || days <= 0 || monthDays <= 0) return 0;
  return roundCurrency((monthlyAmount / monthDays) * days);
}

/**
 * Dedicated Resignations CRM tab (owner request 2026-07-26): this month's
 * leavers only. Fixes the bug where the shared CRM tab's Working/Non-Working
 * split ran against the whole month (31), so a 9-day employee could show 22
 * "non-working" days — the 22 days AFTER he had already left — and be deducted
 * for them.
 *
 * Here Working + Non-Working cap at DAYS WORKED (his employment span this month,
 * from the settlement), so no post-resignation day can ever be deducted. The
 * deduction uses `resignationCrmDeduction` (Base ÷ actual month days), matching
 * the settlement's own daily rate. Fields are keyed directly to the
 * resignationCrmDays/crm draft columns, so the generic persist-loop in
 * run-service.ts writes them with no remap, and leaverDeductionFor's
 * Second-Part-netting rule (owner 2026-07-20) keeps working unchanged.
 */
function recommendResignationCrm(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const leavers = members.filter((member) => member.lifecycle === "leaver" && member.lastWorkingDate);
  if (leavers.length === 0) return [];

  const rows: StepRow[] = [];
  for (const member of leavers) {
    if (!member.lastWorkingDate) continue;
    const source = lookupSource(sources, member.employee.hrId);
    const draft = drafts.get(member.compact);

    // THE SAME resolver the Resignations step uses (leaver-basis.ts). Days
    // worked is whatever HR CONFIRMED there, and only falls back to the
    // settlement's calendar count when nobody has confirmed anything.
    //
    // This is the fix for the owner's 2026-08-30 report. This step used to call
    // computeResignationSettlement itself and take its calendar count, never
    // looking at the draft — so a leaver confirmed at 12 days on the
    // Resignations step arrived here as 28, and the cap below then allowed 28
    // non-working days against a man who worked 12.
    const basis = resolveLeaverBasis({
      source,
      lastWorkingDate: member.lastWorkingDate,
      period,
      draft,
      // The exit workflow records dismissals as well as resignations, so only the employee's own
      // status can say which this is — and a dismissal keeps neither allowance.
      isResignation: isResignationEmploymentStatus(member.employee.employmentStatus),
      // Somebody who joined AND left this month is a leaver here, so without the hire date their
      // settlement counts from the 1st and pays for days before they started.
      hireDate: member.employee.hireDate,
    });
    if (!basis) continue;
    const daysWorked = basis.daysWorked;

    // The leaver's CRM no-activity days come from the Deductions module, like
    // every other deduction in this wizard (owner rule 2026-08-04: "the
    // deductions module [is] the only source of truth... CRM deductions pulls
    // from CRM deductions"). This step used to rescan his CRM visit history
    // itself via the Field Workforce engine, which is exactly the duplicated
    // calculation that produced figures disagreeing with the module.
    //
    // Still clamped to days worked: the module scopes a candidate to real
    // working days, but a leaver's settlement is the one place an off-by-one
    // cannot be corrected afterwards, so the cap stays as a final guard.
    const crmLines = linesFor(deductions, member.compact, "crm");
    // CHARGEABLE days, not flagged days. The module weights a Thursday at half (owner rule
    // 2026-08-02) when it prices the candidate; this figure is what the day rate below gets
    // multiplied by, so reading the unweighted count charged a Thursday in full. B-3, August
    // 2026: 4 flagged days (Wed 5, Thu 6, Sat 8, Sun 9) = 3.5 chargeable.
    const recommendedNonWorking = Math.min(
      daysWorked,
      roundCurrency(crmLines.reduce((sum, line) => sum + line.chargeableDays, 0)),
    );
    // ONE RATE, ONE SOURCE — and they are different sources on purpose:
    //   the Deductions module decides WHICH days are chargeable (owner rule 2026-08-04),
    //   the leaver rule decides what a day is WORTH (owner rule 2026-08-30: "in the CRM, it
    //   must prorate the net salary").
    //
    // This used to hand back the module's own confirmed amount whenever it had one. That amount
    // is priced off the BASE salary, so the moment a candidate was approved the row showed a
    // base-rate recommendation beside a net-rate charge — the same figure disagreeing with itself
    // on one line. Deriving both from the day count is what makes the recommendation and the
    // charge the same number again.
    const recommendedValue = leaverDayDeduction(basis, recommendedNonWorking);

    // Trust a saved day count only if it is within the valid span. A stored
    // value greater than days worked can only be the old whole-month bug (e.g.
    // 22 saved for a 9-day leaver) — discard it and re-recommend, self-healing
    // the stale data without a DB write. The money always re-derives from the
    // (clamped) day count so the displayed value can never disagree with it.
    const storedDays = draft?.resignationCrmDays;
    const nonWorking =
      storedDays != null && storedDays >= 0 && storedDays <= daysWorked ? storedDays : recommendedNonWorking;
    const value = leaverDayDeduction(basis, nonWorking);

    const row = part1ManualDeductionBaseRow(member, source);
    row.context["Days In Month"] = basis.monthDays; // deduction divisor (Net ÷ actual month days)
    row.context["Days Worked"] = daysWorked; // complement cap for Working/Non-Working
    // The monthly amount the day-rate is a share of. NET since 2026-08-30, so
    // the client-side auto-calc charges a no-activity day exactly what the
    // settlement pays for a worked one. part1ManualDeductionBaseRow already put
    // "Net Salary" in context for display; the field spec names it as the
    // auto-calc amount, which is what makes the two agree.
    row.context["Net Salary"] = basis.netSalary;

    // WHY A ZERO CAN BE HONEST HERE, and why it must never be silent. Payroll
    // pays only what the owner has explicitly decided in the Deductions module
    // ("Approved for Payroll" — his rule of 2026-08-03), while that module's own
    // Overview counts a CRM row as soon as it is detected. So a leaver can show
    // a real deduction there and 0.00 here, which is exactly what the owner hit
    // on 2026-08-30: "the CRM deduction is not reading any deduction" — all 7 of
    // August's CRM candidates, 14,032.26 EGP, were sitting Pending.
    //
    // The gate is right and stays. The SILENCE was the defect: the row showed a
    // bare 0.00 with nothing saying a decision was outstanding. Undecided lines
    // now appear in the row's own breakdown carrying their real status, so the
    // zero always arrives with its reason attached.
    row.details = [
      ...deductionDetailLines(crmLines),
      ...pendingDeductionDetailLines(pendingLinesFor(deductions, member.compact, "crm")),
    ];
    row.recommended = {
      resigCrmWorkingDays: Math.max(0, daysWorked - recommendedNonWorking),
      resignationCrmDays: recommendedNonWorking,
      crm: recommendedValue,
    };
    row.values = {
      resigCrmWorkingDays: Math.max(0, daysWorked - nonWorking),
      resignationCrmDays: nonWorking,
      crm: value,
    };
    row.reasons = { resigCrmReason: draft?.p1odCrmReason ?? "" };
    rows.push(row);
  }
  return rows;
}

/**
 * Unpaid-vacation deductions for employees settled in Part 1 (leavers and
 * one-part employees), read from the Deductions module like every other
 * deduction in this wizard.
 *
 * Owner rule 2026-08-04: "the deductions module [is] the only source of truth of
 * deductions... no any deduction type should be read [from anywhere else]".
 * This step previously recomputed a leaver's settlement itself — rescanning CRM
 * leave days, de-duplicating them against Phoenix vacation requests, and calling
 * the balance engine per employee. That was the single largest duplicated
 * calculation in the wizard and the main source of figures disagreeing with the
 * module.
 *
 * The leaver remap is preserved: p1odVacationValue reads from and writes to the
 * SAME `unpaidVacations` draft column the Resignations step uses (see
 * run-service.ts), so leaverDeductionFor's Second-Part-netting rule keeps
 * working untouched.
 */
function recommendP1UnpaidVacation(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source, drafts.get(member.compact)?.settledInPart1)) continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);

    const lines = linesFor(deductions, member.compact, "unpaidVacation");
    const value = roundCurrency(deductions.get(member.compact)?.buckets.unpaidVacation ?? 0);
    const isLeaver = member.lifecycle === "leaver";

    // Reference only — the day count never drives the money here (see the
    // field's doc comment): a settlement is a balance-aware composite, not a
    // flat day rate.
    row.context["Unpaid Vacation Days"] = roundCurrency(lines.reduce((sum, line) => sum + line.days, 0));
    row.recommended = { p1odVacationDays: 0, p1odVacationValue: value };
    row.values = {
      p1odVacationDays: pick(draft?.p1odVacationDays, 0),
      p1odVacationValue: pick(isLeaver ? draft?.unpaidVacations : draft?.p1odVacationValue, value),
    };
    row.reasons = { p1odVacationReason: draft?.p1odVacationReason ?? "" };
    row.details = [
      ...deductionDetailLines(lines),
      ...pendingDeductionDetailLines(pendingLinesFor(deductions, member.compact, "unpaidVacation")),
    ];
    rows.push(row);
  }
  return rows;
}

function recommendP1NoRecord(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source, drafts.get(member.compact)?.settledInPart1)) continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    row.recommended = { p1odNoRecordDays: 0, p1odNoRecordValue: 0 };
    row.values = {
      p1odNoRecordDays: pick(draft?.p1odNoRecordDays, 0),
      p1odNoRecordValue: pick(draft?.p1odNoRecordValue, 0),
    };
    row.reasons = { p1odNoRecordReason: draft?.p1odNoRecordReason ?? "" };
    rows.push(row);
  }
  return rows;
}

function recommendP1OtherDeductions(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  deductions: Map<string, EmployeeDeductions>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    if (!isSettledInPart1(member, source, drafts.get(member.compact)?.settledInPart1)) continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    // Confirmed loan / other deductions from the Deductions module land here for
    // employees settled in Part 1 (owner request 2026-08-03). Everyone else gets
    // them on the Part 2 manual-deductions step — the isSettledInPart1 split is
    // what keeps the two populations disjoint so neither charges the same money.
    // HR can still type a figure on top; a saved value always wins via `pick`.
    const loan = roundCurrency(deductions.get(member.compact)?.buckets.loan ?? 0);
    const other = roundCurrency(deductions.get(member.compact)?.buckets.other ?? 0);
    row.recommended = { p1odLoanDays: 0, p1odLoanValue: loan, p1odOtherDays: 0, p1odOtherValue: other };
    row.values = {
      p1odLoanDays: pick(draft?.p1odLoanDays, 0),
      p1odLoanValue: pick(draft?.p1odLoanValue, loan),
      p1odOtherDays: pick(draft?.p1odOtherDays, 0),
      p1odOtherValue: pick(draft?.p1odOtherValue, other),
    };
    row.reasons = {
      p1odLoanReason: draft?.p1odLoanReason ?? "",
      p1odOtherReason: draft?.p1odOtherReason ?? "",
    };
    row.details = [
      ...deductionDetailLines([
        ...linesFor(deductions, member.compact, "loan"),
        ...linesFor(deductions, member.compact, "other"),
      ]),
      ...pendingDeductionDetailLines([
        ...pendingLinesFor(deductions, member.compact, "loan"),
        ...pendingLinesFor(deductions, member.compact, "other"),
      ]),
    ];
    rows.push(row);
  }
  return rows;
}

/**
 * Special Situations (owner rule 2026-07-25): unlike the 4 manual deduction tabs
 * above, this shows EVERY employee regardless of payment mode — it exists
 * precisely for cases that fall outside the normal one-part/two-part rules. One
 * shared "Apply To" choice per employee routes BOTH their deduction and their
 * addition to the same installment (see split.ts's FreezeFirstPartInput doc and
 * assemble.ts's specialRoutedToFirst). Defaults to "second" — the safer default,
 * since it never touches the frozen First Part unless HR explicitly opts in.
 */
function recommendSpecialSituations(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  drafts: Map<string, DraftRow>,
): StepRow[] {
  const rows: StepRow[] = [];
  for (const member of members) {
    const source = lookupSource(sources, member.employee.hrId);
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    row.recommended = {
      specialDeductionDays: 0,
      specialDeductionValue: 0,
      specialAdditionDays: 0,
      specialAdditionValue: 0,
    };
    row.values = {
      specialDeductionDays: pick(draft?.specialDeductionDays, 0),
      specialDeductionValue: pick(draft?.specialDeductionValue, 0),
      specialAdditionDays: pick(draft?.specialAdditionDays, 0),
      specialAdditionValue: pick(draft?.specialAdditionValue, 0),
    };
    row.selects = { specialSituationPart: draft?.specialSituationPart ?? "second" };
    rows.push(row);
  }
  return rows;
}

/**
 * The hold review, with last month's hold attached to every row that had one.
 *
 * Two distinct jobs, deliberately not collapsed into one:
 *
 *  - `priorHold` is attached to EVERY row the previous month held, whether or
 *    not this month has its own reason. It is what tells the reviewer that a
 *    hold is a continuation rather than something new — the question they cannot
 *    answer from this month's run alone, and the reason August 2026's thirteen
 *    blank holds were unreadable while two of them were fully explained by July.
 *
 *  - The reason is PREFILLED from it only when this month has none of its own.
 *    A reason typed for this month always wins; carry-forward fills a gap and
 *    never overwrites. The prefilled text carries its own "Carried forward from
 *    <month>" label (hold-reason.ts), so when the step is saved or confirmed the
 *    stored reason still says where it came from — a UI-only marker would be
 *    lost by the very save that made it durable, leaving a stale note reading as
 *    a fresh assertion about this month.
 */
function recommendHolds(
  members: PopulationMember[],
  drafts: Map<string, DraftRow>,
  priorHolds: Map<string, PriorHold>,
): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.onHold = draft?.onHold ?? false;

    const prior = priorHolds.get(member.compact);
    if (prior) row.priorHold = prior;

    const resolved = resolveHoldReason({
      onHold: row.onHold,
      storedReason: draft?.holdReason,
      prior,
      priorMonthLabel: prior ? monthNameAndYear(prior.month, prior.year) : "",
    });
    row.reason = resolved.reason;
    if (resolved.carriedForward) row.reasonCarriedForward = true;
    return row;
  });
}

/** Build one step's recommendation rows (system recommendation overlaid with saved edits). */
/**
 * Attach each row's whole-month settlement basis — the four figures the owner
 * asked to see on every screen (2026-08-30). See settlement-summary.ts.
 *
 * Done HERE, once, after the switch, rather than inside each of the sixteen
 * recommend* functions: the summary is the same quantity on every screen by
 * definition (it is the employee's month, not this step's slice), so building
 * it per step would be fifteen chances for one screen to disagree with the
 * others about what someone is paid. A step whose row has no matching member —
 * a manually-added employee — simply gets no basis, and the card renders no
 * summary rather than a confident row of zeros.
 */
function attachSettlementBasis(
  rows: StepRow[],
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  drafts: Map<string, DraftRow>,
  period: PayrollPeriod,
  carryForward: Map<string, number> | undefined,
): StepRow[] {
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  for (const row of rows) {
    const compact = compactHrKey(row.hrId);
    const member = byCompact.get(compact);
    if (!member) continue;
    row.settlement = settlementBasisFor({
      member,
      source: lookupSource(sources, member.employee.hrId),
      draft: drafts.get(compact),
      period,
      carriedForward: carryForward?.get(compact) ?? 0,
    });
  }
  return rows;
}

export async function recommendStep(input: {
  access: AccessContext;
  period: PayrollPeriod;
  stepKey: StepKey;
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  draftRows: DraftRow[];
  /**
   * This run's recovery of previous runs' overpayments, keyed by compact HR id
   * (carry-forward.ts). Optional: the confirm path only persists what is
   * already on the row and never reads the settlement basis, so it does not pay
   * for the extra query. Omitting it leaves `carriedForwardApplied` at 0.
   */
  carryForwardByCompact?: Map<string, number>;
  /**
   * Held Salary Release only: outstanding held balances from earlier published months, by compact HR
   * id (held-settlements.ts outstandingHeldByEmployee), and the employee records the release is paid
   * to — most of them leavers outside `members`. Required for that step; ignored by every other.
   */
  heldBalances?: Map<string, HeldBalance[]>;
  directory?: Map<string, EmployeeDirectoryRow>;
  /** Held Salary Release only: "Part 1 Not Paid" entered against the previous published month. */
  part1Corrections?: Map<string, number>;
}): Promise<StepRow[]> {
  const drafts = draftMap(input.draftRows);
  const withBasis = async (rows: StepRow[] | Promise<StepRow[]>): Promise<StepRow[]> =>
    attachSettlementBasis(
      await rows,
      input.members,
      input.sources,
      drafts,
      input.period,
      input.carryForwardByCompact,
    );
  return withBasis(recommendStepRows(input, drafts));
}

async function recommendStepRows(
  input: {
    access: AccessContext;
    period: PayrollPeriod;
    stepKey: StepKey;
    members: PopulationMember[];
    sources: Map<string, PayrollSalarySource>;
    draftRows: DraftRow[];
    heldBalances?: Map<string, HeldBalance[]>;
    directory?: Map<string, EmployeeDirectoryRow>;
    part1Corrections?: Map<string, number>;
    carryForwardByCompact?: Map<string, number>;
  },
  drafts: Map<string, DraftRow>,
): Promise<StepRow[]> {
  switch (input.stepKey) {
    case "p1_new_hires":
      return recommendNewHires(input.members, input.sources, input.period, drafts);
    case "p1_resignations":
      return recommendResignations(input.members, input.sources, input.period, drafts);
    case "p1_fingerprint":
      return recommendFingerprint(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_crm":
      return recommendP1Crm(
        input.members,
        input.sources,
        input.period,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_resignation_crm":
      return recommendResignationCrm(
        input.members,
        input.sources,
        input.period,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_unpaid_vacation":
      return recommendP1UnpaidVacation(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_no_record":
      return recommendP1NoRecord(input.members, input.sources, drafts);
    case "p1_other_deductions":
      return recommendP1OtherDeductions(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_special_situations":
      return recommendSpecialSituations(input.members, input.sources, drafts);
    case "p2_expenses":
      return recommendExpenses(input.members, input.period, drafts);
    case "p2_vacation":
      return recommendVacation(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p2_crm":
      return recommendCrm(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p2_additions":
      return recommendAdditions(input.members, drafts, await loadStandingAdditions(input.period), await loadDisputeRefunds(input.period));
    case "p2_manual_deductions":
      return recommendManualDeductions(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_held_release":
    case "p2_held_release":
      if (!input.heldBalances || !input.directory) {
        // Never an empty step: an empty list would read as "nobody is owed anything".
        throw new Error("Held Salary Release needs the held balances and the employee records to recommend.");
      }
      return recommendHeldRelease(
        input.members,
        input.directory,
        drafts,
        input.heldBalances,
        input.period,
        input.part1Corrections,
        input.stepKey === "p1_held_release" ? 1 : 2,
      );
    case "p1_pay_deferral":
      return recommendPayDeferralP1(input.members, input.sources, input.draftRows, drafts, input.period);
    case "p2_pay_deferral":
      return recommendPayDeferral(
        input.members,
        input.sources,
        input.draftRows,
        drafts,
        input.period,
        input.carryForwardByCompact,
      );
    case "p1_holds":
    case "p2_holds":
      // One extra read, on the two hold steps only — the carry-forward and the
      // "held last month too" marker both need the previous run's rows.
      return recommendHolds(input.members, drafts, await listPriorMonthHolds(input.period));
    default:
      return [];
  }
}

/** Convenience for callers that don't already hold the population/sources. */
export async function loadStepContext(period: PayrollPeriod): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  directory: Map<string, EmployeeDirectoryRow>;
}> {
  return resolvePayrollPopulationAndSources(period);
}
