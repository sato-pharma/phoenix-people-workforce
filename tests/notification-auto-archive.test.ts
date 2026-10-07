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

  {
    // Phoenix CRM's off-plan approval joins the same mechanism (owner, 2026-10-02: "clear the
    // manager's off-plan notice when he approves it too"). It is keyed by the VISIT id. The rep's
    // own copies of the same story — approved, refused, passed on — are NOT approver notices:
    // auto-archiving those would clear his record of what happened to his visit.
    const candidates = classifyActionableApprovalCandidates([
      { id: "n13", module: "phoenix_crm", event_type: "unplanned_visit_waiting", metadata: { visitId: "VIS-1" } },
      { id: "n14", module: "phoenix_crm", event_type: "unplanned_visit_approved", metadata: { visitId: "VIS-1" } },
      { id: "n15", module: "phoenix_crm", event_type: "unplanned_visit_refused", metadata: { visitId: "VIS-2" } },
      { id: "n16", module: "phoenix_crm", event_type: "unplanned_visit_moved_on", metadata: { visitId: "VIS-3" } },
      // Every other Phoenix CRM notice stays put, the daily forecast's alert included.
      { id: "n17", module: "phoenix_crm", event_type: "forecast_sent", metadata: { visitId: "VIS-4" } },
      // A waiting notice with no visit id (a row written before this shipped) is left visible
      // rather than guessed at.
      { id: "n18", module: "phoenix_crm", event_type: "unplanned_visit_waiting", metadata: {} },
    ]);
    assert.deepEqual(candidates.phoenixCrm, [{ id: "n13", requestId: "VIS-1" }], "only the reviewer's waiting notice, keyed by its visit id");
    assert.equal(candidates.vacation.length + candidates.excuse.length + candidates.plan.length, 0, "a Phoenix CRM notice never lands in another domain");
  }

  {
    // 🔴 THE WEEKLY PLAN NOTICE (owner, 2026-10-07). "Weekly plan to review from <rep>" is the
    // notice Phoenix CRM sends most, and nothing withdrew it: measured on production that night,
    // all four of one district manager's were dead, two of them the SAME rep for the SAME week —
    // the first send, and the re-send after his own return — with identical titles. It is keyed by
    // the PLAN id, and it is its OWN domain: `phoenixCrm` is matched against off-plan VISIT ids, so
    // a plan id landing there would be archived the instant it was read.
    const candidates = classifyActionableApprovalCandidates([
      { id: "p1", module: "phoenix_crm", event_type: "plan_waiting", metadata: { planId: "PLAN-A" } },
      // The REP's own copies of the same week are his record of what happened, never approver notices.
      { id: "p2", module: "phoenix_crm", event_type: "plan_approved", metadata: { planId: "PLAN-A" } },
      { id: "p3", module: "phoenix_crm", event_type: "plan_returned", metadata: { planId: "PLAN-A" } },
      // The MONTH is a different record with a different id — it must not ride on the week's rule.
      { id: "p4", module: "phoenix_crm", event_type: "monthly_plan_waiting", metadata: { planId: "PLAN-A" } },
      // A row written before the plan id travelled in the metadata is left visible, never guessed at.
      { id: "p5", module: "phoenix_crm", event_type: "plan_waiting", metadata: {} },
    ]);
    assert.deepEqual(candidates.phoenixCrmPlan, [{ id: "p1", requestId: "PLAN-A" }], "only the reviewer's waiting notice, keyed by its plan id");
    assert.equal(candidates.phoenixCrm.length, 0, "a weekly-plan notice never lands in the off-plan VISIT domain");
    assert.equal(candidates.plan.length, 0, "nor in the weekly_plans module's own domain, which is a different workflow");
  }

  // --- API + UI + workflow wiring: static source assertions (matches this repo's
  // approvals-hub.test.ts convention for locking in cross-file wiring without a live server) ---

  const inAppSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  // 🔴 "STILL HIS", NEVER "STILL OPEN": at the SFE stage the visit is still waiting, but not on
  // him. canDecideUnplannedVisit is the single rule both the bell and the Team tab answer from.
  const crmAwaiting = readFileSync("src/lib/phoenix-crm/server/awaiting-decisions.ts", "utf8");
  assert.match(crmAwaiting, /canDecideUnplannedVisit\(viewer, seat, row\.is_test === true, stage\)/, "the bell asks the module's own rule whose turn it is");
  assert.match(crmAwaiting, /\.in\("status", \["manager_pending", "sfe_pending"\]\)/, "a decided visit is not awaiting anyone");
  assert.doesNotMatch(crmAwaiting, /@\/lib\/phoenix-crm\/server\/(notifications|unplanned)/, "it stays a leaf — importing either would close the cycle back to the bell");
  assert.match(inAppSource, /"phoenix_crm:unplanned_visit_waiting": \{ domain: "phoenixCrm", idField: "visitId" \}/, "the off-plan approval is in the actionable allowlist");
  assert.match(inAppSource, /const awaitingIds = await phoenixCrmVisitIdsAwaitingDecision\(access\);/, "and the bell asks Phoenix CRM, not a second copy of the rule");
  // The visit id has to be ON the notice, or the classifier above can never key it.
  const crmNotices = readFileSync("src/lib/phoenix-crm/server/notifications.ts", "utf8");
  assert.match(crmNotices, /metadata: \{ visitId: notice\.visitId \},/, "the waiting notice carries its visit id");
  // The same three pieces for the weekly plan: the rule the bell asks, the allowlist entry, and the
  // plan id ON the notice. `recordId` is NOT persisted — notification_events has no column for it —
  // so without the metadata copy the bell cannot tell which week a notice is about.
  assert.match(crmAwaiting, /canReviewTerritory\(viewer, seat, row\.is_test === true\)/, "the bell asks the module's own approve rule, never a second copy");
  assert.match(crmAwaiting, /\.eq\("status", "submitted"\)/, "a week that is approved, returned or back in draft is awaiting nobody");
  assert.match(inAppSource, /"phoenix_crm:plan_waiting": \{ domain: "phoenixCrmPlan", idField: "planId" \}/, "the weekly plan review is in the actionable allowlist");
  assert.match(inAppSource, /const awaitingIds = await phoenixCrmPlanIdsAwaitingDecision\(access\);/, "and the bell asks Phoenix CRM which weeks are still his");
  assert.match(crmNotices, /metadata: \{ planId: notice\.planId \},/, "the plan-to-review notice carries its plan id");
  assert.match(crmNotices, /metadata: \{ \.\.\.\(delivery\.metadata \?\? \{\}\), idempotencyKey: delivery\.idempotencyKey/, "and the deliverer passes it through");
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
