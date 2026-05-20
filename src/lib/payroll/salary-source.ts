import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { resolveStandardSalaryAllowances } from "@/lib/payroll/allowance-policy";
import {
  normalizePayrollPaymentMode,
  resolveFixedSalaryAmounts,
} from "@/lib/payroll/policy";
import {
  salarySourceLookupKeys,
  type PayrollSalarySource,
} from "@/lib/payroll/salary-source-model";

export { salarySourceLookupKeys, type PayrollSalarySource };

function numberOrNull(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function moneyOrNull(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function getPayrollSalarySourcesByHrId(expectedPeriod?: { month: number; year: number }) {
  const directory = await getEmployeeDirectory();
  const sources = new Map<string, PayrollSalarySource>();

  for (const employee of directory.employees) {
    const standardAllowances = resolveStandardSalaryAllowances({
      departmentName: employee.departmentName,
      jobTitle: employee.jobTitle,
      lineName: employee.lineName,
      month: expectedPeriod?.month,
      positionTitle: employee.positionTitle,
      year: expectedPeriod?.year,
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
    const source: PayrollSalarySource = {
      baseSalary,
      employmentIncomeTax,
      extraCostOfLiving,
      fuelAllowance,
      grossSalary: baseSalary === null ? null : moneyOrNull(fixedSalary.grossSalary),
      netSalary:
        baseSalary === null
          ? null
          : moneyOrNull(fixedSalary.netSalary),
      paymentMode: normalizePayrollPaymentMode(employee.salaryPaymentMode),
      socialInsurance,
    };

    for (const key of salarySourceLookupKeys(employee.hrId)) {
      sources.set(key, source);
    }
  }

  return sources;
}
