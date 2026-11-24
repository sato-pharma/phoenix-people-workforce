import type { NonEmployeePayrollRow } from "../types.ts";

/** Digits only, so "1000 2305 0538" and "100023050538" are the same account. */
function accountKey(account: string | null | undefined): string {
  return String(account ?? "").replace(/\D/g, "");
}

/**
 * ONE LINE PER PAYEE PER PART ON THE SHEETS AND THE BANK FILES (owner, 2026-11-24: "One line:
 * 159,987"). A standing transfer (standing-transfers.ts) is seeded as its own Non-Employees line so
 * the list can badge it and HR can edit it apart from the payee's salary. But in the Excel and the
 * CIB / FAB files it is ADDED ONTO the payee's own line of the same part and the same bank account,
 * so the payee receives one transfer per part, not two to the same account.
 *
 * Pure, and it never changes a total: the transfer's amount moves onto the matching line and the
 * transfer line is dropped. A transfer with no matching line (the payee is not otherwise paid that
 * part, or the account differs) stays a line of its own, so nothing is ever lost. The run's stored
 * rows and the on-screen list are untouched; only what is exported is merged.
 */
export function mergeStandingTransferLinesForExport(rows: NonEmployeePayrollRow[]): NonEmployeePayrollRow[] {
  const merged = rows.map((row) => ({ ...row }));
  const dropped = new Set<number>();
  merged.forEach((transfer, index) => {
    if (!transfer.standingTransferId) return;
    const account = accountKey(transfer.bankAccount);
    if (!account) return;
    const name = transfer.fullNameEn.trim().toLowerCase();
    const candidates = merged
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(
        ({ row, rowIndex }) =>
          rowIndex !== index &&
          !dropped.has(rowIndex) &&
          !row.standingTransferId &&
          row.part === transfer.part &&
          accountKey(row.bankAccount) === account,
      );
    const target =
      candidates.find(({ row }) => row.fullNameEn.trim().toLowerCase() === name) ?? candidates[0];
    if (!target) return;
    target.row.totalSalary = Math.round((target.row.totalSalary + transfer.totalSalary) * 100) / 100;
    dropped.add(index);
  });
  return merged.filter((_, index) => !dropped.has(index));
}
