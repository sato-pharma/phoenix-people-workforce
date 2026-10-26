import type { SalaryRecord } from "@/lib/payroll/types";

/**
 * The payroll comment on a row that pays ONLY an earlier month's held salary (Automated Payroll's
 * Held Salary Release, owner 2026-10-26) — typically someone who has left.
 *
 * Shared here, in payroll, because two sides must agree on it: automated-payroll writes it, and the
 * Statutory Summary reads it. That person worked nothing this month and nothing is filed for them;
 * without the marker the summary would count their insurance wage as insured payroll for the month.
 */
export const HELD_RELEASE_ONLY_COMMENT = "Held salary released from an earlier month";

/** True for a release-only record: the marker, no working days, no social insurance and no tax. */
export function isHeldReleaseOnlyRecord(
  record: Pick<SalaryRecord, "payrollComment" | "workingDays" | "socialInsurance" | "employmentIncomeTax">,
): boolean {
  return (
    record.payrollComment === HELD_RELEASE_ONLY_COMMENT &&
    Number(record.workingDays ?? 0) === 0 &&
    Number(record.socialInsurance ?? 0) === 0 &&
    Number(record.employmentIncomeTax ?? 0) === 0
  );
}
