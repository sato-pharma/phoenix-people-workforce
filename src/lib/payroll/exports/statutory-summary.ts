import { roundCurrency } from "@/lib/payroll/money";
import type { StatutoryConfig } from "@/lib/payroll/statutory/types";
import type { SalaryRecord } from "@/lib/payroll/types";

/**
 * Statutory summary for a payroll batch — for the accountant / authority filings.
 *
 * salary_records stores the employee social insurance (11% deduction) and income
 * tax. From the employee SI and the configured rates we derive the subject wage
 * (SI / employee rate) and the employer contribution (SI × employer/employee
 * rate), so the summary shows the full social-insurance picture plus tax, with
 * company totals.
 */

export type StatutorySummaryRow = {
  hrId: string;
  fullName: string;
  subjectWage: number;
  employeeSi: number;
  employerSi: number;
  totalSi: number;
  incomeTax: number;
};

export type StatutorySummaryTotals = {
  employeeSi: number;
  employerSi: number;
  totalSi: number;
  incomeTax: number;
};

export function buildStatutorySummaryRows(
  records: SalaryRecord[],
  config: StatutoryConfig,
): { rows: StatutorySummaryRow[]; totals: StatutorySummaryTotals } {
  const employeeRate = config.siEmployeeRate > 0 ? config.siEmployeeRate : 0.11;
  const employerRatio = config.siEmployerRate / employeeRate;

  const rows: StatutorySummaryRow[] = records.map((record) => {
    const employeeSi = roundCurrency(record.socialInsurance);
    const employerSi = roundCurrency(employeeSi * employerRatio);
    const subjectWage = roundCurrency(employeeSi / employeeRate);
    const incomeTax = roundCurrency(record.employmentIncomeTax);
    return {
      hrId: record.employeeCode || record.hrId,
      fullName: record.fullName,
      subjectWage,
      employeeSi,
      employerSi,
      totalSi: roundCurrency(employeeSi + employerSi),
      incomeTax,
    };
  });

  const totals = rows.reduce<StatutorySummaryTotals>(
    (acc, row) => ({
      employeeSi: roundCurrency(acc.employeeSi + row.employeeSi),
      employerSi: roundCurrency(acc.employerSi + row.employerSi),
      totalSi: roundCurrency(acc.totalSi + row.totalSi),
      incomeTax: roundCurrency(acc.incomeTax + row.incomeTax),
    }),
    { employeeSi: 0, employerSi: 0, totalSi: 0, incomeTax: 0 },
  );

  return { rows, totals };
}
