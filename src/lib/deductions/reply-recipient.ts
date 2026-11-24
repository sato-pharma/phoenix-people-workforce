// Who an HR reply on a deduction dispute is addressed to.
//
// A reply used to be possible only on a PUBLISHED deduction, so its notice read the employee off the
// active publication line and gave up when there was none. Since 2026-11-13 an employee can dispute
// any deduction that is not cleared — published or not (`deductionOpenForDispute`, dispute-open.ts) —
// so a reply on an unpublished one found no line, logged "Deductions reply has no published line to
// address" and told nobody: on 2026-11-24 two Super Admin replies (17:10 and 17:12 Cairo) were saved
// and neither employee was ever notified.
//
// The published line still wins when there is one (it is the row the portal shows them); otherwise
// the deduction's own record names its employee. Only when neither names anyone is there nobody to tell.

export type ReplyRecipientSource = {
  employee_hr_id?: string | null;
  employee_name?: string | null;
} | null;

export type ReplyRecipient = {
  employeeHrId: string;
  storedEmployeeName: string | null;
  source: "published_line" | "candidate";
};

function clean(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

export function pickReplyRecipient(line: ReplyRecipientSource, candidate: ReplyRecipientSource): ReplyRecipient | null {
  const lineHrId = clean(line?.employee_hr_id);
  if (lineHrId) {
    return { employeeHrId: lineHrId, source: "published_line", storedEmployeeName: clean(line?.employee_name) };
  }
  const candidateHrId = clean(candidate?.employee_hr_id);
  if (candidateHrId) {
    return { employeeHrId: candidateHrId, source: "candidate", storedEmployeeName: clean(candidate?.employee_name) };
  }
  return null;
}
