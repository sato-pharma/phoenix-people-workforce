import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { roundCurrency } from "@/lib/payroll/money";
import { calculateBasicSalary, calculateGrossSalary, calculatePayrollParts } from "@/lib/payroll/policy";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";
import { computeIncomeTax, computeSocialInsurance } from "@/lib/payroll/statutory/calculator";
import type { StatutoryConfig } from "@/lib/payroll/statutory/types";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source-model";

import { compactHrKey } from "./feeders.ts";
import {
  applyResignationPartsSplit,
  calendarDaysInMonth,
  computeJoinerPay,
  computeResignationSettlement,
  dailyRate,
  isInPeriod,
  type ResignationSettlement,
} from "./proration.ts";
import type {
  CopilotAdjustment,
  CopilotPeriod,
  RecurringAdjustment,
} from "./types.ts";

/**
 * Assembly engine: turns master compensation + allowances + recurring items +
 * negotiated chat adjustments into a SalaryValidationRow (the exact shape the
 * existing upload path produces), so the Copilot draft flows into the same
 * createSalaryBatch machinery.
 *
 * Base, Basic, and Net always come from the employee master and are never
 * recomputed by statutory math (Base×70% feeds the locked incentive scheme).
 * Only Gross is derived forward from Base+SI+Tax for statutory reporting.
 */

export function lookupSource(
  sources: Map<string, PayrollSalarySource>,
  hrId: string,
): PayrollSalarySource | undefined {
  for (const key of salarySourceLookupKeys(hrId)) {
    const source = sources.get(key);
    if (source) return source;
  }
  return undefined;
}

export function groupAdjustmentsByEmployee(
  adjustments: CopilotAdjustment[],
): Map<string, CopilotAdjustment[]> {
  const map = new Map<string, CopilotAdjustment[]>();
  for (const adjustment of adjustments) {
    const key = compactHrKey(adjustment.employeeHrId);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(adjustment);
    map.set(key, list);
  }
  return map;
}

export function indexRecurringByEmployee(
  recurring: RecurringAdjustment[],
): Map<string, RecurringAdjustment[]> {
  const map = new Map<string, RecurringAdjustment[]>();
  for (const item of recurring) {
    const key = compactHrKey(item.employeeHrId);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

/** True when the employee has been explicitly deferred out of this run. */
export function isDeferred(adjustments: CopilotAdjustment[]): boolean {
  return adjustments.some((adjustment) => adjustment.kind === "defer");
}

type BuildRowInput = {
  employee: EmployeeDirectoryRow;
  source: PayrollSalarySource | undefined;
  recurring: RecurringAdjustment[];
  adjustments: CopilotAdjustment[];
  period: CopilotPeriod;
  index: number;
  statutory?: { config: StatutoryConfig; insuranceWage: number | null };
  /** Set when this employee's last working date falls within `period` — routes through resignation Rule 1/2 instead of the normal parts split. */
  resignation?: { lastWorkingDate: string; unpaidDaysInSpan: number } | null;
};

/**
 * Build a single employee's draft row. Returns null when the employee has been
 * deferred to a later month.
 */
export function buildRowForEmployee(input: BuildRowInput): SalaryValidationRow | null {
  const { employee, source, recurring, adjustments, period, index } = input;
  if (isDeferred(adjustments)) return null;

  const baseSalary = roundCurrency(source?.baseSalary ?? 0);
  let grossSalary = roundCurrency(source?.grossSalary ?? 0);
  const netSalary = roundCurrency(source?.netSalary ?? 0);
  let socialInsurance = roundCurrency(source?.socialInsurance ?? 0);
  let employmentIncomeTax = roundCurrency(source?.employmentIncomeTax ?? 0);
  const extraCostOfLiving = roundCurrency(source?.extraCostOfLiving ?? 0);
  const fuelAllowance = roundCurrency(source?.fuelAllowance ?? 0);
  const paymentMode = source?.paymentMode ?? "two_parts";

  // Base, Basic (base×70%), and Net are the source of truth from the employee
  // master and must NEVER be recomputed here — Basic feeds the locked incentive
  // scheme, so any drift would silently distort incentive payouts. When a
  // per-employee insurance wage is configured, SI is computed from that wage
  // (independent of base/gross) and income tax is computed on Base — not
  // Gross — by passing `Base + SI` as the calculator's "monthlyGross" argument
  // so its internal `(monthlyGross − SI) × 12` cancels back out to `Base × 12`.
  // Gross is the only figure allowed to move, recomputed FORWARD as
  // `Base + SI + Tax` (policy.ts's own formula) purely for statutory reporting
  // — it never feeds back into base/net/monthSalary. Without an insurance wage
  // configured, everything is carried as-is (Phase 1 behavior).
  if (input.statutory && input.statutory.insuranceWage != null && baseSalary > 0) {
    const si = computeSocialInsurance(input.statutory.insuranceWage, input.statutory.config);
    socialInsurance = si.employee;
    employmentIncomeTax = computeIncomeTax(
      baseSalary + si.employee,
      si.employee,
      input.statutory.config,
    );
    grossSalary = calculateGrossSalary({ baseSalary, socialInsurance, employmentIncomeTax });
  }

  // Additive components the Copilot fills; feeder-imported columns stay 0 in P1.
  let bonus = 0;
  let overtime = 0;
  let otherAdditions = 0;
  let loans = 0;
  let otherDeductions = 0;
  let unpaidVacations = 0;
  const incentive = 0;
  const expenses = 0;
  const crm = 0;
  const fingerPrint = 0;
  const medicalInsurance = roundCurrency(employee.medicalInsurance ?? 0);

  // 1) Recurring items for this period.
  for (const item of recurring) {
    if (item.kind === "loan" || item.kind === "advance") loans += item.monthlyAmount;
    else if (item.kind === "penalty") otherDeductions += item.monthlyAmount;
    else if (item.kind === "allowance") otherAdditions += item.monthlyAmount;
  }

  // 2) Negotiated chat adjustments (loan-kind is realized via recurring, skip).
  const overrides = new Map<string, number>();
  for (const adjustment of adjustments) {
    const amount = roundCurrency(adjustment.amount ?? 0);
    switch (adjustment.kind) {
      case "bonus":
        bonus += amount;
        break;
      case "penalty":
        otherDeductions += amount;
        break;
      case "advance":
        loans += amount;
        break;
      case "prorate": {
        // Universal proration principle: the daily rate is always Base ÷
        // calendar days in month — ECOL/Fuel are never part of it, even here.
        const total = calendarDaysInMonth(period);
        const worked = Math.max(0, Math.min(adjustment.workedDays ?? 0, total));
        const unpaidDays = Math.max(0, total - worked);
        const unpaid = roundCurrency(dailyRate(baseSalary, period) * unpaidDays);
        unpaidVacations += Math.max(0, unpaid);
        break;
      }
      case "override":
        if (adjustment.field) overrides.set(adjustment.field, amount);
        break;
      default:
        break;
    }
  }

  // 3) Absolute overrides last.
  if (overrides.has("bonus")) bonus = overrides.get("bonus")!;
  if (overrides.has("overtime")) overtime = overrides.get("overtime")!;
  if (overrides.has("otherAdditions")) otherAdditions = overrides.get("otherAdditions")!;
  if (overrides.has("loans")) loans = overrides.get("loans")!;
  if (overrides.has("otherDeductions")) otherDeductions = overrides.get("otherDeductions")!;
  if (overrides.has("unpaidVacations")) unpaidVacations = overrides.get("unpaidVacations")!;

  bonus = roundCurrency(bonus);
  overtime = roundCurrency(overtime);
  otherAdditions = roundCurrency(otherAdditions);
  loans = roundCurrency(loans);
  otherDeductions = roundCurrency(otherDeductions);
  unpaidVacations = roundCurrency(unpaidVacations);

  // Resignation/joiner settlement: for a leaver/joiner this month, Base/ECOL/
  // Fuel/Net for THIS row reflect the actual prorated entitlement (owner's
  // formulas below) rather than the full carried master values — a genuine,
  // rule-driven recalculation for a real partial-month event, distinct from
  // the statutory-drift bug fixed above. Gross/SI/Tax are deliberately left
  // as computed against the full master Base (Egyptian SI/tax proration for a
  // partial month is out of scope here — owner: "not critical").
  let effectiveBaseSalary = baseSalary;
  let effectiveExtraCostOfLiving = extraCostOfLiving;
  let effectiveFuelAllowance = fuelAllowance;
  let effectiveNetSalary = netSalary;
  let resignationSettlement: ResignationSettlement | null = null;

  const settlementAdditions = roundCurrency(overtime + bonus + otherAdditions);
  const settlementDeductions = roundCurrency(
    crm + fingerPrint + medicalInsurance + loans + otherDeductions + unpaidVacations,
  );

  if (input.resignation?.lastWorkingDate) {
    resignationSettlement = computeResignationSettlement({
      baseSalary,
      extraCostOfLiving,
      fuelAllowance,
      lastWorkingDate: input.resignation.lastWorkingDate,
      period,
      unpaidDaysInSpan: input.resignation.unpaidDaysInSpan,
      otherAdditions: settlementAdditions,
      otherDeductions: settlementDeductions,
    });
    if (resignationSettlement) {
      effectiveBaseSalary = resignationSettlement.baseForMonth;
      effectiveExtraCostOfLiving = resignationSettlement.ecolPaid;
      effectiveFuelAllowance = resignationSettlement.fuelPaid;
      effectiveNetSalary = resignationSettlement.netForMonth;
    }
  } else {
    const hireDate = employee.hireDate;
    if (hireDate && isInPeriod(hireDate, period)) {
      const joinerPay = computeJoinerPay({ baseSalary, extraCostOfLiving, fuelAllowance, hireDate, period });
      if (joinerPay) {
        effectiveBaseSalary = joinerPay.baseForMonth;
        effectiveExtraCostOfLiving = joinerPay.ecolPaid;
        effectiveFuelAllowance = joinerPay.fuelPaid;
        effectiveNetSalary = joinerPay.netForMonth;
      }
    }
  }

  // Manual chat overrides win over the auto-computed settlement — the CEO's
  // explicit, audited escape hatch for a one-off exception.
  let settlementOverridden = false;
  if (overrides.has("baseSalary")) {
    effectiveBaseSalary = overrides.get("baseSalary")!;
    settlementOverridden = true;
  }
  if (overrides.has("extraCostOfLiving")) {
    effectiveExtraCostOfLiving = overrides.get("extraCostOfLiving")!;
    settlementOverridden = true;
  }
  if (overrides.has("fuelAllowance")) {
    effectiveFuelAllowance = overrides.get("fuelAllowance")!;
    settlementOverridden = true;
  }
  if (settlementOverridden) {
    effectiveNetSalary = roundCurrency(
      effectiveBaseSalary + effectiveExtraCostOfLiving + effectiveFuelAllowance,
    );
  }

  const totalAdditions = roundCurrency(
    expenses + incentive + overtime + bonus + effectiveExtraCostOfLiving + effectiveFuelAllowance + otherAdditions,
  );
  const totalDeductions = roundCurrency(
    crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions,
  );
  const governmentalDeductions = roundCurrency(socialInsurance + employmentIncomeTax);

  let firstPart: number;
  let secondPart: number;
  if (resignationSettlement && !settlementOverridden) {
    // Resignation Rule 2 (two-part payment mode only): Part 1 stays at the
    // normal fixed Basic Salary anchor unless the settlement is smaller, in
    // which case Part 1 absorbs the whole settlement and Part 2 is 0.
    if (paymentMode === "two_parts") {
      const split = applyResignationPartsSplit({
        totalPayable: resignationSettlement.total,
        basicSalary: calculateBasicSalary({ baseSalary }),
      });
      firstPart = split.firstPart;
      secondPart = split.secondPart;
    } else {
      firstPart = roundCurrency(Math.max(0, resignationSettlement.total));
      secondPart = 0;
    }
  } else {
    const parts = calculatePayrollParts({
      additions: expenses + incentive + overtime + bonus + otherAdditions,
      deductions: crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions,
      baseSalary: effectiveBaseSalary,
      extraCostOfLiving: effectiveExtraCostOfLiving,
      fuelAllowance: effectiveFuelAllowance,
      netSalary: effectiveNetSalary,
      paymentMode,
      previousExpenses: 0,
      secondPartAdditions: expenses + incentive,
    });
    firstPart = roundCurrency(parts.firstPart);
    secondPart = roundCurrency(Math.max(0, parts.secondPart));
  }
  const monthSalary = roundCurrency(firstPart + secondPart);

  return {
    area: employee.areaName ?? "",
    baseSalary: effectiveBaseSalary,
    bonus,
    crm,
    hrId: employee.hrId,
    employmentIncomeTax,
    expenses,
    extraCostOfLiving: effectiveExtraCostOfLiving,
    fingerPrint,
    firstPart,
    fuelAllowance: effectiveFuelAllowance,
    governmentalDeductions,
    fullName: employee.fullName,
    grossSalary,
    hireDate: employee.hireDate,
    incentive,
    jobTitle: employee.jobTitle ?? "",
    line: employee.lineName ?? "",
    loans,
    medicalInsurance,
    monthSalary,
    nameAr: employee.nameAr,
    netSalary: effectiveNetSalary,
    otherAdditions,
    otherDeductions,
    overtime,
    payrollComment: null,
    paymentMode,
    row: index,
    secondPart,
    socialInsurance,
    totalAdditions,
    totalDeductions,
    unpaidVacations,
  };
}
