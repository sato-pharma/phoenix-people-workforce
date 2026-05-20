import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { resolveFixedSalaryAmounts } from "@/lib/payroll/policy";

type EmployeeMasterSalarySource = Pick<
  EmployeeDirectoryRow,
  | "baseSalary"
  | "basicSalary"
  | "extraCostOfLiving"
  | "fuelAllowance"
  | "grossSalary"
  | "netSalary"
  | "socialInsurance"
  | "taxes"
>;

export type EmployeeMasterExportSalary = {
  baseSalary: number | null;
  basicSalary: number | null;
  grossSalary: number | null;
  netSalary: number | null;
};

function hasSalaryReference(employee: EmployeeMasterSalarySource) {
  return [
    employee.baseSalary,
    employee.basicSalary,
    employee.grossSalary,
    employee.netSalary,
    employee.socialInsurance,
    employee.taxes,
    employee.fuelAllowance,
    employee.extraCostOfLiving,
  ].some((value) => value !== null && value !== undefined);
}

export function resolveEmployeeMasterExportSalary(
  employee: EmployeeMasterSalarySource,
): EmployeeMasterExportSalary {
  if (!hasSalaryReference(employee)) {
    return {
      baseSalary: employee.baseSalary,
      basicSalary: employee.basicSalary,
      grossSalary: employee.grossSalary,
      netSalary: employee.netSalary,
    };
  }

  return resolveFixedSalaryAmounts({
    baseSalary: employee.baseSalary,
    basicSalary: employee.basicSalary,
    extraCostOfLiving: employee.extraCostOfLiving,
    fuelAllowance: employee.fuelAllowance,
    grossSalary: employee.grossSalary,
    netSalary: employee.netSalary,
    socialInsurance: employee.socialInsurance,
    taxes: employee.taxes,
  });
}
