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
import { listUnpaidVacationCandidates } from "@/lib/payroll/copilot/vacation-settlement.ts";
import { deductionsCategoryLabel } from "@/lib/deductions/calculations";
// The whole-month settlement basis behind every step's four-figure summary.
// Value import into a module assemble.ts imports FROM — safe, and deliberately
// so: assemble.ts takes only `import type { PopulationMember }` back, which is
// erased at compile time, so there is no runtime cycle.
import { settlementBasisFor } from "./assemble.ts";
import {
  linesFor,
  loadConfirmedDeductions,
  pendingLinesFor,
  type DeductionLine,
  type EmployeeDeductions,
} from "./deductions-source.ts";
import { calculateFlat30DeductionAmount } from "./flat-deduction-rate.ts";
// The ONE leaver rule — days worked and the day rate — shared by the
// Resignations and Resignations CRM steps so they can never disagree again
// (owner, 2026-08-30: "the rule must be synced everywhere in the module").
import {
  leaverDayDeduction,
  prorateLeaverNet,
  resolveLeaverBasis,
} from "./leaver-basis.ts";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { isPayrollIneligibleEmployee } from "@/lib/payroll/eligibility.ts";
import { roundCurrency } from "@/lib/payroll/money";
import { normalizePayrollPaymentMode, resolveFixedSalaryAmounts } from "@/lib/payroll/policy";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source-model.ts";
// The Field Workforce engine is no longer a source of any DEDUCTION figure
// (owner rule 2026-08-04: the Deductions module is the only source of truth).
// This one import survives for loadCrmLeaveDatesByCompact, which feeds the leave
// BALANCE ledger on confirm — leave bookkeeping, not money.
import { buildFieldWorkforceCompliancePreviewFromVisitsReport } from "@/lib/field-workforce-compliance/ireports360-source.ts";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculatePaymentForRequest } from "@/lib/vacation/service";

import { monthNameAndYear } from "./step-definitions.ts";
import type {
  DraftRow,
  PayrollPeriod,
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
  unpaidDaysInSpan: number;
};

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
 * Needed because the row's money is computed once for the whole group (Base/30 ×
 * days) while the new breakdown shows it per day. Naively rounding total/count
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
}> {
  const [employees, feeders] = await Promise.all([
    getEmployeeDirectoryRows({ includeInactive: true }),
    buildFeederStates(period),
  ]);
  const members: PopulationMember[] = [];
  const sources = new Map<string, PayrollSalarySource>();

  for (const employee of employees) {
    const compact = compactHrKey(employee.hrId);
    if (!compact) continue;
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
      unpaidDaysInSpan: feeder?.unpaidDaysBeforeLastWorkingDate ?? 0,
    });

    const source = buildSalarySource(employee, period);
    for (const key of salarySourceLookupKeys(employee.hrId)) sources.set(key, source);
  }

  return { members, sources };
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

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function periodBounds(period: PayrollPeriod): { start: string; end: string } {
  const lastDay = new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
  return {
    start: `${period.year}-${pad2(period.month)}-01`,
    end: `${period.year}-${pad2(period.month)}-${pad2(lastDay)}`,
  };
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
    });
    byCompact.set(compact, trips);
  }
  return byCompact;
}

/**
 * Owner-corrected expense source (2026-07-20): the real payroll expenses live in the
 * legacy `outstation_expenses` table keyed by payout_month/payout_year — the new
 * `outstation_expense_requests` table the Copilot feeder reads is near-empty.
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
 * Defensive: empty map on any failure.
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
          "hr_id,trip_id,expense_date,to_date,from_location,to_location,location,trip_type,transportation_type,km,travel_cost,meeting_amount,allowance,other_amount,total,approved_amount,hr_approved,hr_status,status,description",
        )
        .eq("payout_month", period.month)
        .eq("payout_year", period.year)
        .is("imported_payroll_batch_id", null)
        .order("expense_date", { ascending: true })
        .range(from, from + EXPENSE_PAGE_SIZE - 1);
      if (error) {
        logError("Automated payroll: payout expenses load failed", {
          labels: { event: "automated_payroll_payout_expenses_load_failed", month: period.month, year: period.year },
          error,
        });
        return buildPayoutExpenseTripMap(collected);
      }
      const rows = (data ?? []) as PayoutExpenseRow[];
      collected.push(...rows);
      if (rows.length < EXPENSE_PAGE_SIZE) break;
    }
  } catch (error) {
    logError("Automated payroll: payout expenses load threw an exception", {
      labels: { event: "automated_payroll_payout_expenses_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return buildPayoutExpenseTripMap(collected);
}

/** "2026-06-01" for a single-day trip, "2026-06-01 → 2026-06-02" for an overnight one. */
export function formatDateRange(startIso: string, endIso: string): string {
  const start = (startIso ?? "").slice(0, 10);
  const end = (endIso ?? "").slice(0, 10);
  if (start && end && start !== end) return `${start} → ${end}`;
  return start || end || "—";
}

function eachDateInclusive(startIso: string, endIso: string): string[] {
  const dates: string[] = [];
  const start = startIso.slice(0, 10);
  const end = endIso.slice(0, 10);
  let ms = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(ms) || !Number.isFinite(endMs)) return dates;
  for (; ms <= endMs; ms += 86400000) dates.push(new Date(ms).toISOString().slice(0, 10));
  return dates;
}

/**
 * CRM-recorded leave (AV / vacation-signal) dates per employee, reusing the FWC live engine
 * so the visit-type→AV mapping + excuse nuances stay identical to the Field Workforce
 * Compliance report (owner rule 2026-07-20: treat CRM leave as real vacation). Defensive.
 */
async function loadCrmLeaveDatesByCompact(period: PayrollPeriod): Promise<Map<string, Set<string>>> {
  const byCompact = new Map<string, Set<string>>();
  try {
    const preview = await buildFieldWorkforceCompliancePreviewFromVisitsReport({
      month: period.month,
      year: period.year,
    });
    for (const candidate of preview.reviewCandidates) {
      if (candidate.type !== "vacation_signal" || !candidate.dateIso) continue;
      const compact = compactHrKey(candidate.hrId);
      if (!compact) continue;
      const dates = byCompact.get(compact) ?? new Set<string>();
      dates.add(candidate.dateIso);
      byCompact.set(compact, dates);
    }
  } catch (error) {
    logError("Automated payroll: CRM leave load failed (non-fatal)", {
      labels: { event: "automated_payroll_crm_leave_load_failed", month: period.month, year: period.year },
      error,
    });
  }
  return byCompact;
}

/** Approved/pending v2 vacation dates per employee — used to de-dup CRM leave already on Phoenix. */
async function loadV2VacationDatesByCompact(period: PayrollPeriod): Promise<Map<string, Set<string>>> {
  const byCompact = new Map<string, Set<string>>();
  try {
    const { start, end } = periodBounds(period);
    const { data, error } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("employee_hr_id,start_date,end_date,status")
      .in("status", ["approved", "pending_manager"])
      .lte("start_date", end)
      .gte("end_date", start);
    if (error) {
      logError("Automated payroll: v2 vacation dates load failed", {
        labels: { event: "automated_payroll_v2_vacation_dates_load_failed", month: period.month, year: period.year },
        error,
      });
      return byCompact;
    }
    for (const row of (data ?? []) as Array<{
      employee_hr_id: string | null;
      start_date: string | null;
      end_date: string | null;
    }>) {
      const compact = compactHrKey(row.employee_hr_id ?? "");
      if (!compact || !row.start_date || !row.end_date) continue;
      const dates = byCompact.get(compact) ?? new Set<string>();
      for (const date of eachDateInclusive(row.start_date, row.end_date)) {
        if (date >= start && date <= end) dates.add(date);
      }
      byCompact.set(compact, dates);
    }
  } catch (error) {
    logError("Automated payroll: v2 vacation dates load threw an exception", {
      labels: { event: "automated_payroll_v2_vacation_dates_load_threw", month: period.month, year: period.year },
      error,
    });
  }
  return byCompact;
}

/**
 * Faithful copy of ireports360-source.ts's VISIT_TYPE_TO_STATUS map (owner-confirmed
 * 2026-07-20; that map is private to that file, so it's duplicated here — keep in sync if
 * it ever changes). visitType 0 = a regular visit, handled separately below.
 */
const LEAVER_VISIT_TYPE_TO_STATUS = new Map<number, "AV" | "CP">([
  [-1, "CP"], // Conference
  [-2, "CP"], // Group Meeting
  [-4, "AV"], // Annual Vacation — the only genuine leave type here
  // Public Holiday (-5) and Casual Leave (-6) are WORKING time (owner ruling 2026-08-21).
  // Both already behaved this way — but only because they were ABSENT from this map and fell
  // through to the CP default. That was an accident, not a decision. Listing them explicitly
  // means a later change to that fallback cannot silently turn 1,659 production days into
  // charged leave, which is exactly how the Health Day mistake below happened. iReports360
  // sends no description for either; see src/lib/crm/visit-types.ts for what each code means.
  [-5, "CP"],
  [-6, "CP"],
  [-8, "CP"], // Campaign (Prospection)
  [-9, "CP"], // Training
  [-11, "CP"], // Meeting
  [-12, "CP"], // Traveling
  // Health Day is WORKING time, not leave (owner ruling 2026-08-01): "an activity
  // they do for patients in the dr clinic." Kept in lockstep with the source map
  // in ireports360-source.ts — see the note there for what the old AV mapping cost.
  [-15, "CP"],
]);

/**
 * Read accessor for the map above, exported so the AV/CP ruling is unit-testable
 * without exposing the mutable Map itself. Undefined for a type the map does not
 * list (callers treat that as CP, matching dayCellValue).
 */
export function leaverVisitTypeStatus(visitType: number): "AV" | "CP" | undefined {
  return LEAVER_VISIT_TYPE_TO_STATUS.get(visitType);
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
      unpaidDaysInSpan: member.unpaidDaysInSpan,
      draft,
    });
    if (!basis) continue;
    const { settlement } = basis;

    const row = baseRow(member);
    row.context = {
      "Hire Date": member.employee.hireDate ?? "",
      "Last Working Date": member.lastWorkingDate,
      // Divisor for the client-side Days Worked -> money auto-calc. Must be the
      // month's ACTUAL calendar days to match dailyRate() in proration.ts; the
      // default 30 used for deduction day-rates would overpay in a 31-day month.
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
      // Base/30 rate to compute from when HR types a day count by hand.
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
 */
function pendingDeductionDetailLines(lines: DeductionLine[]): StepRowDetail[] {
  return deductionDetailLines(lines).map((line) => ({
    ...line,
    Status: `${line.Status} — not charged, awaiting your approval in Deductions`,
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
  for (const [compact, trips] of tripsByCompact) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const draft = drafts.get(compact);

    // Identical running-round accumulation to the pre-detail version — the
    // reimbursed figure must not move by a piastre just because the breakdown
    // is now visible. It DOES move when HR approved a different amount than was
    // claimed: that is the approval, and payableExpenseAmount is the one rule
    // every payout path shares. Untouched rows have a null approved amount and
    // still reimburse the claim exactly.
    let value = 0;
    for (const trip of trips) {
      value = roundCurrency(value + payableExpenseAmount(trip.approvedAmount, trip.total));
    }

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
    };
    row.details = trips.map((trip) => ({
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
    }));
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

  return rows;
}

type VacationDeductionTotal = {
  v2Days: number;
  v2Amount: number;
  crmDays: number;
  crmUnpaidDays: number;
  crmAmount: number;
  /**
   * CRM leave days the employee's balance absorbed, costing no salary. Surfaced
   * so a 0-deduction row explains itself: those employees are on this step
   * because confirming it debits their balance, not because they owe money.
   */
  crmBalanceDays: number;
};

/**
 * One employee's CRM-only-leave balance breakdown for a period — the detail
 * `settleCrmLeaveBalanceForPeriod` needs to durably record, beyond the
 * aggregated `VacationDeductionTotal` used for the payroll-sheet number.
 */
export type CrmLeaveBalanceSettlement = {
  employeeHrId: string;
  compact: string;
  /** Earliest CRM-only AV date this period — the settlement row's anchor date. */
  startDate: string;
  /** Count of CRM-only AV dates this period (no Phoenix v2 request covering them). */
  totalDays: number;
  /** Days actually covered by the employee's live balance (<= totalDays). */
  balanceDaysConsumed: number;
  /** Days beyond balance, deducted from salary instead. */
  unpaidDays: number;
  salaryDeductionAmount: number;
};

/**
 * Vacation deduction totals for every member (Phoenix v2 unpaid days + CRM-recorded leave,
 * balance-first). Shared by the Part-2 Vacation step (everyone except leavers, who are
 * settled at resignation time instead) and the Resignation step (leavers only).
 *
 * Also returns crmLeaveSettlements — the same CRM-only-leave figures broken out per employee,
 * consumed by settleCrmLeaveBalanceForPeriod to durably record the balance draw-down when the
 * Part-2 Vacation step is confirmed (owner rule 2026-07-21: a vacation day, whether sourced
 * from CRM or a formal Phoenix request, must subtract from balance first and salary only for
 * what balance doesn't cover — durably, not just as a one-off payroll-sheet number that
 * disappears next period).
 */
export async function computeVacationDeductionTotals(
  members: PopulationMember[],
  sources: Map<string, PayrollSalarySource>,
  period: PayrollPeriod,
): Promise<{
  totals: Map<string, VacationDeductionTotal>;
  crmLeaveSettlements: CrmLeaveBalanceSettlement[];
  detailsByCompact: Map<string, StepRowDetail[]>;
}> {
  const byCompact = new Map(members.map((member) => [member.compact, member]));
  const totals = new Map<string, VacationDeductionTotal>();
  const crmLeaveSettlements: CrmLeaveBalanceSettlement[] = [];
  const detailsByCompact = new Map<string, StepRowDetail[]>();
  const ensure = (compact: string) => {
    const existing =
      totals.get(compact) ??
      { v2Days: 0, v2Amount: 0, crmDays: 0, crmUnpaidDays: 0, crmAmount: 0, crmBalanceDays: 0 };
    totals.set(compact, existing);
    return existing;
  };
  const addDetail = (compact: string, line: StepRowDetail) => {
    const lines = detailsByCompact.get(compact) ?? [];
    lines.push(line);
    detailsByCompact.set(compact, lines);
  };

  // 1) Phoenix-submitted unpaid vacations (existing v2 balance-aware settlement).
  const v2Candidates = await listUnpaidVacationCandidates(period);
  for (const candidate of v2Candidates) {
    const compact = compactHrKey(candidate.employeeHrId);
    if (!compact) continue;
    const entry = ensure(compact);
    entry.v2Days += Number(candidate.unpaidDays ?? 0);
    entry.v2Amount += roundCurrency(candidate.salaryDeductionAmount);
    // Deliberately reports "Covered by Balance" as 0 and deducts the full
    // salaryDeductionAmount, mirroring what the line above actually adds up.
    // listUnpaidVacationCandidates only returns requests already carrying
    // payment_status='unpaid', so the balance question was settled when the
    // request was classified; its balanceDaysToConsume figure is advice for the
    // Copilot's separate settle-from-balance workflow, NOT a reduction applied
    // here. Showing it as coverage would imply a smaller deduction than the row
    // actually charges.
    addDetail(compact, {
      Source: "Phoenix request",
      Dates: formatDateRange(candidate.startDate, candidate.endDate),
      Type: candidate.vacationType,
      Days: roundCurrency(Number(candidate.unpaidDays ?? 0)),
      "Covered by Balance": 0,
      "Deducted Days": roundCurrency(Number(candidate.unpaidDays ?? 0)),
      Deduction: roundCurrency(candidate.salaryDeductionAmount),
      Basis: "Request already marked unpaid — deducted in full",
    });
  }

  // 2) CRM-recorded leave (owner rule 2026-07-20): the balance covers what it can; the
  //    remainder is a salary deduction. CRM dates already covered by a Phoenix vacation are
  //    excluded so the same leave day is never counted twice.
  const [crmLeaveDates, v2Dates] = await Promise.all([
    loadCrmLeaveDatesByCompact(period),
    loadV2VacationDatesByCompact(period),
  ]);
  for (const [compact, avDates] of crmLeaveDates) {
    const member = byCompact.get(compact);
    if (!member) continue;
    const covered = v2Dates.get(compact);
    const crmOnly = [...avDates].filter((date) => !covered?.has(date)).sort();
    if (crmOnly.length === 0) continue;

    let balanceDays = 0;
    try {
      const snapshot = await calculatePaymentForRequest({
        durationDays: crmOnly.length,
        employeeHrId: member.employee.hrId,
        hireDate: member.employee.hireDate,
        startDate: crmOnly[0],
        vacationType: "annual",
      });
      balanceDays = Math.max(0, Number(snapshot.balanceBeforeDays ?? 0));
    } catch (error) {
      logError("Automated payroll: CRM leave balance check failed", {
        labels: { event: "automated_payroll_crm_leave_balance_check_failed", hrId: member.employee.hrId },
        error,
      });
    }
    const unpaidDays = Math.max(0, crmOnly.length - balanceDays);
    const base = roundCurrency(lookupSource(sources, member.employee.hrId)?.baseSalary ?? 0);
    const amount =
      unpaidDays > 0
        ? calculateFlat30DeductionAmount({ baseSalary: base, deductionDays: unpaidDays }) ?? 0
        : 0;
    const entry = ensure(compact);
    entry.crmDays += crmOnly.length;
    entry.crmUnpaidDays += unpaidDays;
    entry.crmAmount += amount;
    entry.crmBalanceDays += Math.min(Math.floor(balanceDays), crmOnly.length);
    crmLeaveSettlements.push({
      balanceDaysConsumed: roundCurrency(Math.min(balanceDays, crmOnly.length)),
      compact,
      employeeHrId: member.employee.hrId,
      salaryDeductionAmount: amount,
      startDate: crmOnly[0],
      totalDays: crmOnly.length,
      unpaidDays,
    });

    // One line per CRM leave DATE — this is the "which days" the aggregate hides.
    // crmOnly is already sorted, and the balance is consumed in date order, so
    // the first `covered` dates are the free ones and the rest are charged. The
    // charged dates split `amount` exactly (see distributeAmount) so the panel
    // always foots to the row's Deduction Value.
    const coveredCount = Math.min(Math.floor(balanceDays), crmOnly.length);
    const perDeductedDay = distributeAmount(amount, crmOnly.length - coveredCount);
    crmOnly.forEach((dateIso, index) => {
      const isCovered = index < coveredCount;
      addDetail(compact, {
        Source: "CRM leave",
        Dates: dateIso,
        // Annual Vacation (-4) only. Health Day (-15) is working time and no
        // longer classifies as leave at all, so it never reaches this step —
        // see LEAVER_VISIT_TYPE_TO_STATUS.
        Type: "Annual vacation",
        Days: 1,
        "Covered by Balance": isCovered ? 1 : 0,
        "Deducted Days": isCovered ? 0 : 1,
        Deduction: isCovered ? 0 : (perDeductedDay[index - coveredCount] ?? 0),
        Basis: isCovered ? "Vacation balance covered it" : "Beyond balance — deducted from salary",
      });
    });
  }

  return { crmLeaveSettlements, detailsByCompact, totals };
}

/**
 * Durably records the balance-first-else-salary settlement for each employee's CRM-only
 * leave days this period, reusing the SAME payroll_copilot_vacation_settlements ledger a
 * formal Phoenix unpaid-request settlement writes to (balanceSettledDaysInPeriod in
 * vacation/service.ts already sums it, regardless of source) — so a CRM-only AV day counts
 * against the employee's real balance in every FUTURE balance check, not just this month's
 * payroll sheet. vacation_request_ids stays [] (no formal request exists); that's also how a
 * CRM-sourced row is told apart from a Copilot-decided one when reviewing the table directly.
 * Idempotent: re-confirming the same step supersedes the prior live row for that
 * employee+startDate before inserting, so a re-run never double-counts.
 */
export async function settleCrmLeaveBalanceForPeriod(input: {
  crmLeaveSettlements: CrmLeaveBalanceSettlement[];
  actorHrId: string;
  runId?: string | null;
}): Promise<{ settled: number }> {
  const supabase = getSupabaseAdmin();
  let settled = 0;
  for (const settlement of input.crmLeaveSettlements) {
    if (settlement.totalDays <= 0) continue;

    await supabase
      .from("payroll_copilot_vacation_settlements")
      .update({ superseded_at: new Date().toISOString() })
      .eq("employee_hr_id_compact", settlement.compact)
      .eq("start_date", settlement.startDate)
      .is("superseded_at", null);

    const method: "balance" | "partial_balance" | "salary" =
      settlement.unpaidDays <= 0 ? "balance" : settlement.balanceDaysConsumed > 0 ? "partial_balance" : "salary";

    const { error } = await supabase.from("payroll_copilot_vacation_settlements").insert({
      balance_days_consumed: method === "salary" ? null : settlement.balanceDaysConsumed,
      decided_by: input.actorHrId,
      employee_hr_id: settlement.employeeHrId,
      employee_hr_id_compact: settlement.compact,
      run_id: input.runId ?? null,
      salary_deduction_amount: method === "balance" ? null : settlement.salaryDeductionAmount,
      settlement_method: method,
      start_date: settlement.startDate,
      unpaid_days: settlement.totalDays,
      vacation_request_ids: [],
    });
    if (error) {
      logError("Automated payroll: CRM leave balance settlement insert failed", {
        labels: {
          event: "automated_payroll_crm_leave_balance_settlement_insert_failed",
          hrId: settlement.employeeHrId,
          runId: input.runId ?? null,
        },
        error,
      });
      continue;
    }
    settled += 1;
  }
  return { settled };
}

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
 * THE LEAVE-BALANCE DRAW-DOWN IS DELIBERATELY UNTOUCHED. Confirming this step
 * still settles CRM-only leave against the balance ledger via
 * computeVacationDeductionTotals inside run-service.ts (owner rule 2026-07-21) —
 * that is leave BOOKKEEPING, a different question from what salary is deducted,
 * and it runs independently of what this feeder displays. Sourcing the money
 * from the module does not change how many balance days an employee consumed.
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
    if (isSettledInPart1(member, source)) continue;
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
    if (isSettledInPart1(member, source)) continue;
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

function recommendAdditions(members: PopulationMember[], drafts: Map<string, DraftRow>): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.recommended = { incentive: 0, bonus: 0, overtime: 0 };
    row.values = {
      incentive: pick(draft?.incentive, 0),
      bonus: pick(draft?.bonus, 0),
      overtime: pick(draft?.overtime, 0),
    };
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
    const settledInPart1 = isSettledInPart1(member, source);
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
 */
export function isSettledInPart1(
  member: Pick<PopulationMember, "lifecycle">,
  source: Pick<PayrollSalarySource, "paymentMode"> | undefined,
): boolean {
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
    // reads row.context["Base Salary"] to compute Base/30 × days (recommendation-step.tsx
    // setDaysValue) — that formula is untouched. "Net Salary" is the number HR actually
    // sees displayed (owner request 2026-07-25: show Net, not Base, in the UI).
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
    if (!isSettledInPart1(member, source)) continue;
    // This month's resignations moved to their own dedicated Resignations CRM
    // tab (owner request 2026-07-26 — see recommendResignationCrm), because a
    // leaver's CRM rules differ: the Working/Non-Working split caps at his DAYS
    // WORKED (not the whole month) and the deduction divides by the month's
    // ACTUAL calendar days (not /30). This tab is now one-part CONTINUING
    // employees only, keeping the old whole-month /30 behavior for them.
    if (member.lifecycle === "leaver") continue;
    const draft = drafts.get(member.compact);
    const row = part1ManualDeductionBaseRow(member, source);
    // Working/Non-Working Days cap (owner request 2026-07-25) — the real
    // calendar day count, deliberately NOT the fixed /30 the money formula uses.
    // See StepFieldSpec.complementTotalContextKey's doc for why these must stay separate.
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
 * rule 2026-07-26): ÷ the month's ACTUAL calendar days × days, NOT the /30 used
 * for continuing employees.
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
      unpaidDaysInSpan: member.unpaidDaysInSpan,
      draft,
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
    if (!isSettledInPart1(member, source)) continue;
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
    if (!isSettledInPart1(member, source)) continue;
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
    if (!isSettledInPart1(member, source)) continue;
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

function recommendHolds(members: PopulationMember[], drafts: Map<string, DraftRow>): StepRow[] {
  return members.map((member) => {
    const draft = drafts.get(member.compact);
    const row = baseRow(member);
    row.context = { "Hire Date": member.employee.hireDate ?? "" };
    row.onHold = draft?.onHold ?? false;
    row.reason = draft?.holdReason ?? null;
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
      return recommendAdditions(input.members, drafts);
    case "p2_manual_deductions":
      return recommendManualDeductions(
        input.members,
        input.sources,
        await loadConfirmedDeductions(input.period),
        drafts,
      );
    case "p1_holds":
    case "p2_holds":
      return recommendHolds(input.members, drafts);
    default:
      return [];
  }
}

/** Convenience for callers that don't already hold the population/sources. */
export async function loadStepContext(period: PayrollPeriod): Promise<{
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
}> {
  return resolvePayrollPopulationAndSources(period);
}
