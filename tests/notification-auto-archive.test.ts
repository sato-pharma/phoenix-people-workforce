import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyActionableApprovalCandidates } from "../src/lib/notifications/in-app.ts";

export function runNotificationAutoArchiveTests() {
  // --- classifyActionableApprovalCandidates: pure logic, no database ---

  {
    const candidates = classifyActionableApprovalCandidates([
      { id: "n1", module: "vacation", event_type: "next_manager_review", metadata: { requestId: "VAC-1" } },
    ]);
    assert.equal(candidates.vacation.length, 1, "next_manager_review is a vacation candidate");
    assert.deepEqual(candidates.vacation[0], { id: "n1", requestId: "VAC-1" });
  }

  {
    // request_submitted fans out to every step's recipient at once — direct manager (actionable
    // now), manager-of-manager (future, "Available after..."), and HR (future/exception-only,
    // "Review / reject only until...") all under the SAME eventType. Only the copy whose own
    // metadata.status says "Pending your approval" may be auto-archived.
    const candidates = classifyActionableApprovalCandidates([
      { id: "n2a", module: "vacation", event_type: "request_submitted", metadata: { requestId: "VAC-2", status: "Pending your approval" } },
      { id: "n2b", module: "vacation", event_type: "request_submitted", metadata: { requestId: "VAC-2", status: "Available after the first management approval" } },
      { id: "n2c", module: "vacation", event_type: "request_submitted", metadata: { requestId: "VAC-2", status: "Review / reject only until management approves" } },
      { id: "n2d", module: "vacation", event_type: "request_submitted", metadata: { requestId: "VAC-2" } },
    ]);
    assert.equal(candidates.vacation.length, 1, "only the currently-actionable copy of request_submitted is a candidate");
    assert.equal(candidates.vacation[0].id, "n2a", "the manager-of-manager/HR future-stage copies and a missing status must all be excluded");
  }

  {
    const candidates = classifyActionableApprovalCandidates([
      { id: "n3", module: "excuse", event_type: "request_submitted", metadata: { requestId: "EXC-1" } },
      { id: "n4", module: "excuse", event_type: "request_resubmitted", metadata: { requestId: "EXC-2" } },
    ]);
    assert.equal(candidates.excuse.length, 2, "excuse submitted+resubmitted are both candidates (single-step, single-recipient)");
  }

  {
    // FYI status update sent to the employee, not an approver — must never be treated as a
    // pending-action candidate no matter how it's misread.
    const candidates = classifyActionableApprovalCandidates([
      { id: "n5", module: "excuse", event_type: "request_decided", metadata: { requestId: "EXC-3" } },
    ]);
    assert.equal(candidates.excuse.length, 0, "excuse request_decided (FYI to employee) must never be a candidate");
  }

  {
    const candidates = classifyActionableApprovalCandidates([
      { id: "n6", module: "weekly_plans", event_type: "plan_manager_approved", metadata: { planId: "PLAN-1" } },
      { id: "n7", module: "weekly_plans", event_type: "plan_ceo_approved", metadata: { planId: "PLAN-2" } },
    ]);
    assert.equal(candidates.plan.length, 2, "plan_manager_approved (to CEO) and plan_ceo_approved (to HR) are both candidates");
  }

  {
    // plan_submitted fans out to the manager (action-needed) AND HR (pure awareness, tagged
    // audience: "hr_awareness" by notifyHrOnSubmit) under the SAME eventType — only the
    // un-tagged manager copy may be auto-archived.
    const candidates = classifyActionableApprovalCandidates([
      { id: "n8", module: "weekly_plans", event_type: "plan_submitted", metadata: { planId: "PLAN-3" } },
      { id: "n9", module: "weekly_plans", event_type: "plan_submitted", metadata: { audience: "hr_awareness", planId: "PLAN-3" } },
    ]);
    assert.equal(candidates.plan.length, 1, "only the manager's plan_submitted copy is a candidate");
    assert.equal(candidates.plan[0].id, "n8", "the hr_awareness-tagged copy must be excluded");
  }

  {
    // plan_ceo_approved took the same shape once HR's acknowledgement became automatic
    // (autoAcknowledgeFinalApprovedPlan, 2026-09-02): the normal copy is a pure FYI tagged
    // audience: "hr_awareness" and must survive in the bell, while an UNTAGGED copy means the
    // automatic acknowledgement failed and the plan really is still awaiting HR's manual click.
    const candidates = classifyActionableApprovalCandidates([
      { id: "n12", module: "weekly_plans", event_type: "plan_ceo_approved", metadata: { planId: "PLAN-4" } },
      { id: "n13", module: "weekly_plans", event_type: "plan_ceo_approved", metadata: { audience: "hr_awareness", planId: "PLAN-5" } },
    ]);
    assert.equal(candidates.plan.length, 1, "only the action-needed plan_ceo_approved copy is a candidate");
    assert.equal(candidates.plan[0].id, "n12", "the auto-acknowledged FYI copy must never be auto-archived as a stale approval");
  }

  {
    // Defensive: missing id, missing requestId/planId, and an unrecognized module must never
    // crash or silently produce a bogus candidate.
    const candidates = classifyActionableApprovalCandidates([
      { id: "", module: "vacation", event_type: "next_manager_review", metadata: { requestId: "VAC-4" } },
      { id: "n10", module: "vacation", event_type: "next_manager_review", metadata: {} },
      { id: "n11", module: "unknown_module", event_type: "next_manager_review", metadata: { requestId: "VAC-5" } },
    ]);
    assert.equal(candidates.vacation.length, 0, "missing id, missing requestId, and an unknown module must all be rejected");
  }

  // --- API + UI + workflow wiring: static source assertions (matches this repo's
  // approvals-hub.test.ts convention for locking in cross-file wiring without a live server) ---

  const inAppSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  assert.match(inAppSource, /export async function archiveAllInAppNotifications/, "archiveAllInAppNotifications must be exported for the Clear All route");
  assert.match(inAppSource, /export async function archiveInAppNotification/, "archiveInAppNotification must be exported");
  assert.match(inAppSource, /archived_at: now/, "archive writes archived_at, distinct from read_at");
  assert.match(inAppSource, /"vacation:request_submitted": \{ domain: "vacation", idField: "requestId" \}/, "vacation request_submitted is in the actionable allowlist (gated on metadata.status, not blanket-excluded)");

  const routeSource = readFileSync("app/api/notifications/in-app/route.ts", "utf8");
  assert.match(routeSource, /clearAll === true/, "PATCH route must handle clearAll");
  assert.match(routeSource, /archiveAllInAppNotifications\(access\)/, "clearAll must call archiveAllInAppNotifications");

  const bellSource = readFileSync("src/components/layout/in-app-notifications-bell.tsx", "utf8");
  assert.match(bellSource, /clearAll: true/, "bell must send clearAll:true to the API");
  assert.match(bellSource, /Clear all notifications/, "bell must have a Clear all button");
  // The bell's unread marker shares the sidebar's alarm class so both surfaces pulse identically.
  // It became a COUNT on 2026-09-02 (was a bare 2px dot), matching InternalMessagesMenu beside it —
  // the position moved with it, so this pins the class and the number, not the old coordinates.
  assert.match(bellSource, /nav-badge-alarm absolute right-1 top-1/, "the bell's unread badge carries the shared alarm class, consistent with the sidebar badges");
  assert.match(bellSource, /unreadCount > 99 \? "99\+" : unreadCount/, "the bell shows HOW MANY are unread, capped, rather than an unquantified dot");

  const weeklyPlanningSource = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  assert.match(
    weeklyPlanningSource,
    /audience: "hr_awareness"/,
    "HR's plan_submitted awareness copy must be tagged so the bell never auto-archives it as if it were the manager's action-needed copy",
  );
}
