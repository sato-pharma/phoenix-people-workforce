import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyApprovalsLoadFailure } from "../src/lib/approvals-hub/service.ts";
import { VacationViewerHasNoEmployeeProfileError } from "../src/lib/vacation/service.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * System Audit APP-FEAFFD50. On 20 Oct 2026 10:05–10:18 Cairo the Super Admin opened empty office seats
 * through View as Seat. No employee stands behind an empty seat, so the vacation service answered "Your
 * employee profile is not available in the employee directory", and the Approvals Hub vacation badge
 * logged that as an ERROR three times — a false error, since the badge shows nothing either way. The
 * fourth row (22 Oct 15:52, "Supabase request timed out") was a real failed read and must stay an error.
 */
export function vacationProfileThrowsMissing(source: string): string[] {
  const start = source.indexOf("async function filterVacationEmployeesForAccess(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const missing: string[] = [];
  if (!/throw new VacationViewerHasNoEmployeeProfileError\("Your employee profile is not available in the employee directory\. Please contact HR\."\)/.test(body)) {
    missing.push("no directory row for the viewer must throw VacationViewerHasNoEmployeeProfileError, with the same words as before");
  }
  if (!/throw new VacationViewerHasNoEmployeeProfileError\("Your employee profile is not linked yet\. Please contact HR\."\)/.test(body)) {
    missing.push("a viewer row with no HR id must throw VacationViewerHasNoEmployeeProfileError, with the same words as before");
  }
  return missing;
}

export function runApprovalsBadgeEmptySeatTests() {
  // What each failure is — only "error" is logged as an ERROR and reaches the System Audit board.
  const noProfile = new VacationViewerHasNoEmployeeProfileError("Your employee profile is not available in the employee directory. Please contact HR.");
  assert.equal(classifyApprovalsLoadFailure(noProfile), "no_employee_profile", "an empty seat is nobody to count for, not a failure");
  assert.equal(noProfile.message, "Your employee profile is not available in the employee directory. Please contact HR.", "the words a page prints are unchanged");
  assert.ok(noProfile instanceof Error, "it is still an Error to every existing catch");
  assert.equal(classifyApprovalsLoadFailure(new Error("AbortError: Supabase request timed out.")), "error", "a database timeout stays an error (the 22 Oct row)");
  assert.equal(
    classifyApprovalsLoadFailure(new Error("Your employee profile is not available in the employee directory. Please contact HR.")),
    "error",
    "only the named class is quiet — the same words from another module are not silenced by a text match",
  );
  assert.equal(classifyApprovalsLoadFailure(new Error("Forbidden: no leave access")), "forbidden", "a refusal keeps its own class");

  // The vacation service throws the named class at both "nobody behind this viewer" points.
  const source = stripComments(readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.deepEqual(vacationProfileThrowsMissing(source), [], "both no-profile refusals throw the named class");
  const broken = source.replace(
    'throw new VacationViewerHasNoEmployeeProfileError("Your employee profile is not available',
    'throw new Error("Your employee profile is not available',
  );
  assert.notEqual(broken, source, "the broken copy must actually differ");
  assert.ok(vacationProfileThrowsMissing(broken).length > 0, "the pin fires when the empty-seat refusal goes back to a plain Error");
}
