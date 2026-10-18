import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { permissionMatrix } from "../src/lib/auth/permissions.ts";
import {
  planCommentFor,
  pruneSelectedPlanIds,
  viewerMayEditPlan,
  withoutPlanComment,
  withPlanComment,
} from "../src/lib/weekly-planning/plan-editor-state.ts";
import { stripComments } from "./support/comment-strip.ts";

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
    /canViewPlan\(access, employee, plan, viewerScope\)/,
    "addPlanComment must still authorize on plan participation — now also passing the viewer's " +
      "resolved skip-level scope, so a manager who can now SEE a report's plan can also comment " +
      "on it (deliberate: view and comment widen together, decision authority is untouched)",
  );

  // ── Reading the thread is gated the same way ───────────────────────────────
  // listPlanComments asserted `update`, which CEO and Manager do not hold: the call threw 403 and
  // plan-conversation-thread.tsx painted an EMPTY thread for exactly the roles the thread was built
  // for, while addPlanComment (read) let them post into it.
  const listStart = serviceSource.indexOf("export async function listPlanComments");
  assert.ok(listStart >= 0, "listPlanComments must exist");
  const listComments = serviceSource.slice(listStart, serviceSource.indexOf("\n}\n", listStart));
  assert.ok(listComments.includes("canViewPlan("), "the slice must span listPlanComments to its closing brace");
  assert.match(
    listComments,
    /assertPermission\(access, "weekly_plans", "read"\)/,
    "listPlanComments' permission floor is read, like addPlanComment's; canViewPlan is the real authorization",
  );
  assert.doesNotMatch(
    stripComments(listComments),
    /assertPermission\(access, "weekly_plans", "update"\)/,
    "listPlanComments must not require weekly_plans:update - CEO and Manager cannot hold it, so their thread would load empty",
  );
  const registrySource = readFileSync("src/lib/security/access-registry.ts", "utf8");
  assert.match(
    registrySource,
    /methods: \["GET"\], pattern: "\/api\/weekly-plans\/:id\/comments", permission: \{ resource: "weekly_plans", action: "read" \}/,
    "the access registry already declares the comment READ as weekly_plans:read - the service must agree with it",
  );
  assert.match(
    registrySource,
    /methods: \["POST"\], pattern: "\/api\/weekly-plans\/:id\/comments", permission: \{ resource: "weekly_plans", action: "read" \}/,
    "the access registry must declare the comment POST as weekly_plans:read too, the floor addPlanComment asserts - 'update' described a permission CEO and Manager cannot hold",
  );

  // ── One review comment PER PLAN ────────────────────────────────────────────
  // A single shared string was bound to every plan's textarea and sent on whichever plan was decided
  // next, so text typed for plan A was recorded on plan B's decision and mailed to B's employee.
  let drafts = withPlanComment({}, "plan-a", "Please add the Alexandria visits");
  assert.equal(planCommentFor(drafts, "plan-a"), "Please add the Alexandria visits");
  assert.equal(planCommentFor(drafts, "plan-b"), "", "typing on plan A leaves plan B's comment empty");
  drafts = withPlanComment(drafts, "plan-b", "Looks right");
  assert.equal(planCommentFor(drafts, "plan-a"), "Please add the Alexandria visits", "and typing on B leaves A alone");
  const afterB = withoutPlanComment(drafts, "plan-b");
  assert.equal(planCommentFor(afterB, "plan-b"), "", "a decision on plan B clears B's comment");
  assert.equal(planCommentFor(afterB, "plan-a"), "Please add the Alexandria visits", "and keeps A's");
  assert.equal(withoutPlanComment(afterB, "plan-b"), afterB, "clearing a plan with no draft changes nothing");
  assert.equal("plan-b" in drafts, true, "clearing must not mutate the previous state object");

  const workspaceCode = stripComments(workspaceSource);
  assert.doesNotMatch(
    workspaceCode,
    /const \[comment, setComment\]/,
    "the workspace must not hold ONE comment string for every review card",
  );
  assert.equal(
    (workspaceCode.match(/comment: planCommentFor\(comments, planId\)/g) ?? []).length,
    3,
    "decide, the edit-request decision and the HR acknowledgement each send only THEIR plan's comment",
  );
  assert.equal(
    (workspaceCode.match(/setComments\(\(current\) => withoutPlanComment\(current, planId\)\)/g) ?? []).length,
    3,
    "and each clears only that plan's draft on success",
  );
  assert.match(
    workspaceCode,
    /onChange=\{\(e\) => onComment\(p\.id, e\.target\.value\)\}/,
    "a review card's textarea writes the comment of ITS plan",
  );

  // ── Bulk-approve selection forgets plans that left the queue ───────────────
  const selected = new Set(["plan-a", "plan-b", "plan-c"]);
  assert.deepEqual(
    Array.from(pruneSelectedPlanIds(selected, ["plan-a", "plan-c", "plan-d"])).sort(),
    ["plan-a", "plan-c"],
    "plan B was decided and left the queue, so \"Approve selected\" must neither count nor send it",
  );
  assert.equal(
    pruneSelectedPlanIds(selected, ["plan-a", "plan-b", "plan-c", "plan-d"]),
    selected,
    "nothing left the queue: the same set comes back so state does not churn",
  );
  assert.equal(pruneSelectedPlanIds(selected, []).size, 0);
  assert.match(
    workspaceCode,
    /setSelectedIds\(\(previous\) => pruneSelectedPlanIds\(previous, queuePlanIds\)\)/,
    "the review card must prune its selection when the queue changes",
  );

  // ── Who gets a live editor ─────────────────────────────────────────────────
  // The server lets the plan's owner or a Super Admin save and submit it (assertPlanOwner); a
  // manager who opens a report's plan gets 403 on Save, Submit and Add day. The editor offers
  // exactly the server's rule - both call the same function.
  assert.equal(viewerMayEditPlan({ planOwnerHrId: "AB-12", viewerHrId: "AB-12", viewerRole: "Medical Rep" }), true);
  assert.equal(
    viewerMayEditPlan({ planOwnerHrId: "AB-12", viewerHrId: "ab-12", viewerRole: "Medical Rep" }),
    true,
    "HR ids are compared the way the server compares them, so stored upper case matches the access context's lower case",
  );
  assert.equal(
    viewerMayEditPlan({ planOwnerHrId: "AB-12", viewerHrId: "CD-34", viewerRole: "District Manager" }),
    false,
    "a manager opening a subordinate's plan reads it; he does not edit it",
  );
  assert.equal(viewerMayEditPlan({ planOwnerHrId: "AB-12", viewerHrId: "CD-34", viewerRole: "CEO" }), false);
  assert.equal(
    viewerMayEditPlan({ planOwnerHrId: "AB-12", viewerHrId: "CD-34", viewerRole: "Super Admin" }),
    true,
    "the server's one admin path: a Super Admin may save and submit any plan",
  );
  assert.equal(viewerMayEditPlan({ planOwnerHrId: "AB-12", viewerHrId: null, viewerRole: "Medical Rep" }), false);
  assert.equal(viewerMayEditPlan({ planOwnerHrId: null, viewerHrId: null, viewerRole: "Medical Rep" }), false);

  const ownerGuardStart = serviceSource.indexOf("function assertPlanOwner");
  assert.ok(ownerGuardStart >= 0, "assertPlanOwner must exist");
  const ownerGuard = serviceSource.slice(ownerGuardStart, serviceSource.indexOf("\n}\n", ownerGuardStart));
  assert.ok(
    ownerGuard.includes("viewerMayEditPlan("),
    "assertPlanOwner must call the shared rule, so the editor and the server cannot drift apart",
  );
  assert.match(
    workspaceCode,
    /const canEdit = planCanEdit\(plan\) && workspace\.canSubmitPlans && mayEditPlan;/,
    "the editor's canEdit must include the ownership rule",
  );
  assert.match(
    workspaceCode,
    /viewerMayEditPlan\(\{ planOwnerHrId: plan\.employeeHrId, viewerHrId: access\.hrId, viewerRole: access\.role \}\)/,
    "and it asks the shared function about the plan's owner and the viewer",
  );
}
