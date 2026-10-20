import { isActiveImportEmployee, normalizeEmploymentStatus } from "@/lib/imports/employee-lifecycle";
import { parseImportBooleanFlag } from "@/lib/imports/employee-normalizers";
import {
  normalizePayrollPaymentMode,
  payrollPaymentModeLabel,
  type PayrollPaymentMode,
} from "@/lib/payroll/policy";

/**
 * PAYMENT MODE AND PAYROLL ELIGIBLE STAY WITH THE HR MANAGER. The salary-blind seat (the one
 * isSalaryBlindRole answers true for — the HR Operations Specialist) edits bank name and bank
 * account, and never these two.
 *
 * Owner, 2026-10-20: "can change bank account but never a paymode". Payroll eligible decides
 * whether the person is paid at all, so it is held the same way — and so is EMPLOYMENT STATUS,
 * because setting an active person to "inactive" turns payroll eligible off with it (employeePayload:
 * an inactive lifecycle is never eligible), and an exit is decided by the HR Manager, not here.
 * Every door is closed on the SERVER, from the access context, never from anything the browser sends:
 *
 *   - THE EMPLOYEE SAVE (app/api/employees/route.ts) writes the STORED values back. It never
 *     drops the keys as `undefined`, the way it drops money: employeePayload ALWAYS writes
 *     payment_mode (an absent mode becomes the default "two_parts") and payroll_eligible (absent
 *     becomes "eligible" for an active person), so dropping them would CHANGE both for anyone paid
 *     in one part or kept off payroll — the exact thing this rule forbids.
 *   - THE IMPORT (employee-validator.ts) compares each cell with the master. An equal cell is
 *     ignored, a differing one blocks its row with the sentence below, and withoutPayFlags
 *     (employee-import-salary-blind.ts) blanks both on every planned row, so neither is written.
 *
 * The stored values are derived exactly as the directory derives them for her screen and her
 * export (employee-directory.ts), so every cell of her own export compares equal.
 */

export type StoredPayFlags = {
  /** As normalizeEmploymentStatus reads it: a blank status is "active". */
  employmentStatus: string;
  paymentMode: PayrollPaymentMode;
  payrollEligible: boolean;
};

/** The code each refused row carries, and the one her Upload Rules sheet lists. */
export const PAY_FLAG_KEPT_CODE = "pay_flag_kept_with_hr_manager";

/**
 * The directory's own derivation: the employee row's payment mode, else the compensation row's,
 * normalised; payroll eligible as stored, else an active person is eligible.
 */
export function storedPayFlagsFromRow(
  row: { employment_status?: string | null; payment_mode?: string | null; payroll_eligible?: boolean | null },
  compensationPaymentMode?: string | null,
): StoredPayFlags {
  return {
    employmentStatus: normalizeEmploymentStatus(row.employment_status),
    paymentMode: normalizePayrollPaymentMode(row.payment_mode ?? compensationPaymentMode),
    payrollEligible: row.payroll_eligible ?? isActiveImportEmployee(row),
  };
}

/** Her save with all three put back to what the master holds, whatever the form sent. */
export function withStoredPayFlags<
  T extends { employmentStatus?: string | null; payrollEligible?: boolean | null; salaryPaymentMode?: string | null },
>(input: T, stored: StoredPayFlags): T {
  return {
    ...input,
    employmentStatus: stored.employmentStatus,
    payrollEligible: stored.payrollEligible,
    salaryPaymentMode: stored.paymentMode,
  };
}

/** Said when her save cannot read the master's two values: nothing is written rather than a guess. */
export const PAY_FLAGS_UNREADABLE_MESSAGE =
  "This employee's payment mode could not be read, so nothing was saved. Try again in a moment.";

/** Said once on her import when the master's two values could not be read for the comparison. */
export const PAY_FLAGS_NOT_COMPARED_MESSAGE =
  "Payment Mode, Payroll Eligible and Employment Status could not be checked against the master, so those columns were ignored — nothing in them was written.";

/** The four spellings the import validator accepts for a payment mode. */
const PAYMENT_MODE_CELLS: ReadonlySet<string> = new Set(["two_parts", "one_part", "two parts", "one part"]);

function yesNo(value: boolean) {
  return value ? "Yes" : "No";
}

export function paymentModeKeptMessage(from: PayrollPaymentMode, to: string) {
  return `Payment mode stays with the HR Manager — this row changes it from ${payrollPaymentModeLabel(from)} to ${to}.`;
}

export function payrollEligibleKeptMessage(from: boolean, to: boolean) {
  return `Payroll eligible stays with the HR Manager — this row changes it from ${yesNo(from)} to ${yesNo(to)}.`;
}

function statusLabel(status: string) {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function employmentStatusKeptMessage(from: string, to: string) {
  return `Employment status stays with the HR Manager — this row changes it from ${statusLabel(from)} to ${statusLabel(to)}.`;
}

/**
 * One refusal per column whose cell CHANGES the master, for one of her import rows. A blank cell,
 * or one equal to the stored value, says nothing. A payment mode the validator does not recognise
 * is a change too (it is not the stored mode), named as she typed it. An unrecognised payroll
 * eligible word is "not provided" to the write as well, so it says nothing. With no stored value
 * to compare against there is nothing to name — and the cell is still never written.
 */
export function payFlagChangesFromSeat(
  cells: { employmentStatus?: string | null; paymentMode: string | null; payrollEligible: string | null },
  stored: StoredPayFlags | undefined,
): Array<{ field: "employmentStatus" | "paymentMode" | "payrollEligible"; message: string }> {
  if (!stored) return [];
  const changes: Array<{ field: "employmentStatus" | "paymentMode" | "payrollEligible"; message: string }> = [];

  const statusCell = cells.employmentStatus?.trim() || null;
  if (statusCell) {
    const status = normalizeEmploymentStatus(statusCell);
    if (status !== stored.employmentStatus) {
      changes.push({ field: "employmentStatus", message: employmentStatusKeptMessage(stored.employmentStatus, status) });
    }
  }

  const modeCell = cells.paymentMode?.trim() || null;
  if (modeCell) {
    const lower = modeCell.toLowerCase();
    const mode = PAYMENT_MODE_CELLS.has(lower) ? normalizePayrollPaymentMode(lower) : null;
    if (mode !== stored.paymentMode) {
      changes.push({
        field: "paymentMode",
        message: paymentModeKeptMessage(stored.paymentMode, mode ? payrollPaymentModeLabel(mode) : `"${modeCell}"`),
      });
    }
  }

  const eligible = parseImportBooleanFlag(cells.payrollEligible);
  if (eligible !== null && eligible !== stored.payrollEligible) {
    changes.push({ field: "payrollEligible", message: payrollEligibleKeptMessage(stored.payrollEligible, eligible) });
  }

  return changes;
}
