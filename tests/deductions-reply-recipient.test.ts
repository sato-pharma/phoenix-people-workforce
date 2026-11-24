import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pickReplyRecipient } from "../src/lib/deductions/reply-recipient.ts";

/**
 * An HR reply on a deduction dispute reaches the employee even when the deduction was never
 * published (2026-11-24). Since 2026-11-13 an unpublished, uncleared deduction can be disputed, but
 * the reply's notice read the employee only off the active publication line, so two Super Admin
 * replies that day (Yassin Khalifa's and Ahmed Ashraf's, both unpublished November deductions) were
 * saved and logged "Deductions reply has no published line to address", and nobody was told.
 */
export function runDeductionsReplyRecipientTests() {
  // The real shape of the 2026-11-24 case: no active line, the candidate names the employee.
  assert.deepEqual(
    pickReplyRecipient(null, { employee_hr_id: "B-132", employee_name: "Yassin Samir Mohamed Ahmed Khalifa" }),
    { employeeHrId: "B-132", source: "candidate", storedEmployeeName: "Yassin Samir Mohamed Ahmed Khalifa" },
    "an unpublished deduction's reply is addressed to the employee on the deduction itself",
  );

  // A published line still wins — it is the row the portal shows the employee.
  assert.deepEqual(
    pickReplyRecipient(
      { employee_hr_id: "B-143", employee_name: "Ahmed Ashraf" },
      { employee_hr_id: "B-999", employee_name: "Someone Else" },
    ),
    { employeeHrId: "B-143", source: "published_line", storedEmployeeName: "Ahmed Ashraf" },
    "the active published line is preferred over the candidate",
  );

  // A line that names nobody falls through to the candidate rather than giving up.
  assert.equal(pickReplyRecipient({ employee_hr_id: "  ", employee_name: null }, { employee_hr_id: "B-143" })?.employeeHrId, "B-143");
  assert.equal(pickReplyRecipient({ employee_hr_id: "B-143" }, null)?.storedEmployeeName, null, "a missing name is null, never an empty string");

  // Only when neither names anyone is there nobody to tell.
  assert.equal(pickReplyRecipient(null, null), null);
  assert.equal(pickReplyRecipient(null, { employee_hr_id: "" }), null);

  // The reply's notice uses the helper and reads the candidate too.
  const comments = readFileSync(new URL("../src/lib/deductions/comments.ts", import.meta.url), "utf8");
  const notify = comments.slice(comments.indexOf("async function notifyDeductionsReply"), comments.indexOf("async function notifyDeductionsComment"));
  assert.match(notify, /pickReplyRecipient\(/, "notifyDeductionsReply picks its recipient through pickReplyRecipient");
  assert.match(notify, /\.from\("deductions_candidates"\)/, "notifyDeductionsReply reads the deduction's own record as the fallback");
  assert.doesNotMatch(notify, /no published line to address/, "the dead-end on a missing published line is gone");
  assert.match(
    notify,
    /threadLabel: recipient\.source === "published_line" \? "published deduction for" : "deduction for"/,
    "an unpublished deduction is never called published in the employee's message",
  );
}
