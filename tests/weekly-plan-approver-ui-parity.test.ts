import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";

// The weekly-plan approver model is owner-locked and enforced SERVER-side:
//   assertManagerReviewer — the assigned direct manager only (CEO only when the plan has no
//                           manager at all). No Super Admin branch.
//   assertCeoReviewer     — CEO only. No Super Admin branch.
// The workspace UI must not render decision buttons the server will reject, and the plan
// conversation must not be gated on a permission its intended posters do not hold.
export function runWeeklyPlanApproverUiParityTests() {
  const workspaceSource = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const serviceSource = readFileSync("src/lib/weekly-planning/service.ts", "utf8");

  // ── The server guards really have no Super Admin bypass ────────────────────
  // If this ever changes, the UI filter below should change with it — that is the point of
  // asserting both sides in one test.
  const managerReviewerStart = serviceSource.indexOf("async function assertManagerReviewer");
  // NOTE: assertCeoReviewer is NOT async — searching for "async function assertCeoReviewer"
  // returns -1, and slice(start, -1) silently runs to the end of the file.
  const managerReviewerEnd = serviceSource.indexOf("function assertCeoReviewer");
  assert.ok(managerReviewerStart >= 0, "assertManagerReviewer must exist");
  assert.ok(
    managerReviewerEnd > managerReviewerStart,
    "assertCeoReviewer must follow assertManagerReviewer — this test slices between them",
  );
  const managerReviewer = serviceSource.slice(managerReviewerStart, managerReviewerEnd);
  // Match the bypass SHAPE, not the words: the function's own comments legitimately mention
  // Super Admin to say there is no bypass, so a bare string match would fail on correct code.
  assert.doesNotMatch(
    managerReviewer,
    /role\s*===\s*["']Super Admin["']|scope\s*===\s*["']system["']/,
    "assertManagerReviewer must not gain a Super Admin bypass without the workspace queues changing too",
  );

  // ── The workspace must not hand Super Admin buttons that 403 ───────────────
  assert.doesNotMatch(
    workspaceSource,
    /isSuperAdminReviewer/,
    "the decision queues must not admit Super Admin — assertManagerReviewer/assertCeoReviewer reject every such click with 403, so the buttons are guaranteed-broken UI on the platform's most-watched account",
  );

  // ── Plan comments are gated on participation, not on `update` ──────────────
  // CEO and the Manager role are the two the thread was built for and neither holds `update`.
  const ceo = permissionMatrix["CEO"]?.weekly_plans ?? [];
  const manager = permissionMatrix["Manager"]?.weekly_plans ?? [];
  assert.ok(ceo.includes("read"), "CEO must be able to read weekly plans");
  assert.ok(manager.includes("read"), "Manager must be able to read weekly plans");
  assert.equal(
    ceo.includes("update") || manager.includes("update"),
    false,
    "sanity: neither CEO nor Manager holds weekly_plans:update — which is exactly why addPlanComment must not require it",
  );

  const addComment = serviceSource.slice(
    serviceSource.indexOf("export async function addPlanComment"),
    serviceSource.indexOf("export async function addPlanComment") + 1600,
  );
  assert.ok(addComment.length > 0, "addPlanComment must exist");
  assert.doesNotMatch(
    addComment,
    /assertPermission\(access, "weekly_plans", "update"\)/,
    "addPlanComment must not require weekly_plans:update — CEO and Manager cannot hold it, so the composer would render for them and then 403 on Send",
  );
  assert.match(
    addComment,
    /assertPermission\(access, "weekly_plans", "read"\)/,
    "addPlanComment's permission floor is read; canViewPlan is the real authorization",
  );
  assert.match(
    addComment,
    /canViewPlan\(access, employee, plan\)/,
    "addPlanComment must still authorize on plan participation",
  );
}
