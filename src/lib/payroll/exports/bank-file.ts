import type { SalaryRecord } from "@/lib/payroll/types";

/**
 * Bank-transfer file rows for a payroll batch. Pulls the payable amount from the
 * salary record (month salary = first + second part) and joins bank details from
 * the employee master (they don't live on salary_records). Employees without a
 * bank account are flagged so they can be paid manually.
 */

export type EmployeeBankInfo = {
  bankName: string | null;
  bankAccount: string | null;
  hasBankAccount: string | null;
};

export type BankFileRow = {
  hrId: string;
  fullName: string;
  bankName: string;
  bankAccount: string;
  amount: number;
  missingBank: boolean;
};

function compactKey(hrId: string): string {
  return String(hrId ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function buildBankFileRows(
  records: SalaryRecord[],
  bankByHrId: Map<string, EmployeeBankInfo>,
): BankFileRow[] {
  return records.map((record) => {
    const bank = bankByHrId.get(compactKey(record.hrId));
    const bankAccount = (bank?.bankAccount ?? "").trim();
    const bankName = (bank?.bankName ?? "").trim();
    return {
      hrId: record.employeeCode || record.hrId,
      fullName: record.fullName,
      bankName,
      bankAccount,
      amount: record.monthSalary,
      missingBank: bankAccount.length === 0,
    };
  });
}

export function bankFileCompactKey(hrId: string): string {
  return compactKey(hrId);
}
