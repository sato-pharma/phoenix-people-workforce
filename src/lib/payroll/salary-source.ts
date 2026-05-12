import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import {
  calculateGrossSalary,
  calculateNetSalary,
  normalizePayrollPaymentMode,
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

export async function getPayrollSalarySourcesByHrId() {
  const directory = await getEmployeeDirectory();
  const sources = new Map<string, PayrollSalarySource>();

  for (const employee of directory.employees) {
    const baseSalary = numberOrNull(employee.netSalary);
    const extraCostOfLiving = numberOrNull(employee.extraCostOfLiving);
    const fuelAllowance = numberOrNull(employee.fuelAllowance);
    const socialInsurance = numberOrNull(employee.socialInsurance);
    const employmentIncomeTax = numberOrNull(employee.taxes);
    const source: PayrollSalarySource = {
      baseSalary,
      employmentIncomeTax,
      extraCostOfLiving,
      fuelAllowance,
      grossSalary:
        numberOrNull(employee.grossSalary) ??
        (baseSalary === null
          ? null
          : moneyOrNull(
              calculateGrossSalary({
                baseSalary,
                socialInsurance,
                taxes: employmentIncomeTax,
              }),
            )),
      netSalary:
        baseSalary === null
          ? null
          : moneyOrNull(
              calculateNetSalary({
                baseSalary,
                extraCostOfLiving,
                fuelAllowance,
              }),
            ),
      paymentMode: normalizePayrollPaymentMode(employee.salaryPaymentMode),
      socialInsurance,
    };

    for (const key of salarySourceLookupKeys(employee.hrId)) {
      sources.set(key, source);
    }
  }

  return sources;
}
