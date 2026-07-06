import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { roundCurrency } from "@/lib/payroll/money";
import { calculatePayrollParts } from "@/lib/payroll/policy";
import type { SalaryValidationRow } from "@/lib/payroll/salary-import";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source-model";

import { compactHrKey } from "./feeders.ts";
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
 * Phase 1 seeds fixed salary and allowances only; approved attendance/expense
 * amounts continue to import through the existing post-batch RPCs, and full
 * tax/insurance computation is Phase 2. The values here are carried, not
 * recomputed.
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

function daysInMonth(period: CopilotPeriod): number {
  return new Date(Date.UTC(period.year, period.month, 0)).getUTCDate();
}

type BuildRowInput = {
  employee: EmployeeDirectoryRow;
  source: PayrollSalarySource | undefined;
  recurring: RecurringAdjustment[];
  adjustments: CopilotAdjustment[];
  period: CopilotPeriod;
  index: number;
};

/**
 * Build a single employee's draft row. Returns null when the employee has been
 * deferred to a later month.
 */
export function buildRowForEmployee(input: BuildRowInput): SalaryValidationRow | null {
  const { employee, source, recurring, adjustments, period, index } = input;
  if (isDeferred(adjustments)) return null;

  const baseSalary = roundCurrency(source?.baseSalary ?? 0);
  const grossSalary = roundCurrency(source?.grossSalary ?? 0);
  const netSalary = roundCurrency(source?.netSalary ?? 0);
  const socialInsurance = roundCurrency(source?.socialInsurance ?? 0);
  const employmentIncomeTax = roundCurrency(source?.employmentIncomeTax ?? 0);
  const extraCostOfLiving = roundCurrency(source?.extraCostOfLiving ?? 0);
  const fuelAllowance = roundCurrency(source?.fuelAllowance ?? 0);
  const paymentMode = source?.paymentMode ?? "two_parts";

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
  const medicalInsurance = 0;

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
        const worked = Math.max(0, Math.min(adjustment.workedDays ?? 0, daysInMonth(period)));
        const total = daysInMonth(period);
        const unpaid = total > 0 ? roundCurrency(netSalary * (1 - worked / total)) : 0;
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

  const totalAdditions = roundCurrency(
    expenses + incentive + overtime + bonus + extraCostOfLiving + fuelAllowance + otherAdditions,
  );
  const totalDeductions = roundCurrency(
    crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions,
  );
  const governmentalDeductions = roundCurrency(socialInsurance + employmentIncomeTax);

  const parts = calculatePayrollParts({
    additions: expenses + incentive + overtime + bonus + otherAdditions,
    deductions: crm + fingerPrint + unpaidVacations + medicalInsurance + loans + otherDeductions,
    baseSalary,
    extraCostOfLiving,
    fuelAllowance,
    netSalary,
    paymentMode,
    previousExpenses: 0,
    secondPartAdditions: expenses + incentive,
  });
  const firstPart = roundCurrency(parts.firstPart);
  const secondPart = roundCurrency(Math.max(0, parts.secondPart));
  const monthSalary = roundCurrency(firstPart + secondPart);

  return {
    area: employee.areaName ?? "",
    baseSalary,
    bonus,
    crm,
    hrId: employee.hrId,
    employmentIncomeTax,
    expenses,
    extraCostOfLiving,
    fingerPrint,
    firstPart,
    fuelAllowance,
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
    netSalary,
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
