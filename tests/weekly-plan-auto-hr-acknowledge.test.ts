import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { EMPLOYEE_PLAN_TRANSITIONS, getNextEmployeePlanStatus } from "../src/lib/weekly-planning/plan-v1.ts";

// Owner instruction 2026-09-02: "in weekly plans make HR acknowledgment automatic after the final
// approval". A weekly/monthly plan used to stop at final_approved and wait for a human HR click
// before reaching hr_acknowledged. It now acknowledges itself the moment it lands on
// final_approved, by whichever of the two routes got it there.
//
// What this test protects, in order of how expensive the regression would be:
//
//  1. BOTH routes into final_approved must auto-acknowledge. The direct ceo_approve is the obvious
//     one; the second is the manager_approve cascade (CEO-as-own-manager, and the District Manager
//     CEO-bypass), which reaches final_approved inside the SAME request without ever passing
//     through the ceo_approve branch. Wiring only the obvious one leaves every District Manager
//     plan — the ones with no CEO stage at all — stuck exactly where the owner asked them not to
//     be, and nothing goes red.
//  2. It must go through the acknowledge RPC, never a bare status flip. phx_weekly_plan_acknowledge
//     writes the employee_plan_hr_acknowledgements row and the hr_acknowledge decision row as one
//     transaction. A status-only update would satisfy every screen and still trip drift detector D6
//     ("hr_acknowledged plans with no acknowledgement row").
//  3. It must be best-effort. The approval already committed in rpcDecidePlan before this runs, so
//     a throw here would fail the approver's request over a step they did not ask for, and the
//     manual HR button must stay as the fallback.
//
// The plan-v1 transition is exercised for real (it is pure). The service wiring is source-pinned
// against a SLICE of each function, because reaching it needs a database — and because a pin that
// searches the whole 3,000-line file passes on a string belonging to some other function.

function sliceFunction(source: string, marker: string, label: string) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${label} must exist - this test slices it by marker`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${label} must be a closed function - this test slices it`);
  return source.slice(start, end);
}

export function runWeeklyPlanAutoHrAcknowledgeTests() {
  // ---- The transition the automatic path rides on must actually exist ------------------------
  assert.equal(
    getNextEmployeePlanStatus("final_approved", "hr_acknowledge"),
    "hr_acknowledged",
    "final_approved + hr_acknowledge must reach hr_acknowledged - the automatic step runs the same transition as the manual one",
  );
  assert.ok(
    EMPLOYEE_PLAN_TRANSITIONS.hr_acknowledge.from.includes("hr_acknowledged"),
    "hr_acknowledge must remain re-runnable from hr_acknowledged, so a real HR person can still acknowledge on top of the automatic one",
  );
  assert.equal(
    EMPLOYEE_PLAN_TRANSITIONS.ceo_approve.to,
    "final_approved",
    "ceo_approve is what lands a plan on final_approved - the status the automatic acknowledgement triggers on",
  );
  // revise sends an acknowledged plan back to draft; it must then be able to travel the whole way
  // round again, or a corrected plan would never re-acknowledge.
  assert.equal(
    getNextEmployeePlanStatus("hr_acknowledged", "revise"),
    "draft",
    "an acknowledged plan must still be revisable - the automatic acknowledgement must not become a dead end",
  );

  const service = readFileSync("src/lib/weekly-planning/service.ts", "utf8");

  // ---- The helper itself ---------------------------------------------------------------------
  const helper = sliceFunction(
    service,
    "async function autoAcknowledgeFinalApprovedPlan",
    "autoAcknowledgeFinalApprovedPlan",
  );
  assert.match(
    helper,
    /if \(plan\.status !== "final_approved"\) return plan;/,
    "the automatic acknowledgement must no-op on any status other than final_approved",
  );
  assert.match(
    helper,
    /await rpcAcknowledgePlan\(\{/,
    "it must run the acknowledge RPC, which writes the acknowledgement row - a bare status update would trip drift detector D6",
  );
  assert.match(
    helper,
    /hrId: AUTO_HR_ACK_HR_ID/,
    "the automatic acknowledgement must be recorded against its own sentinel actor, never against the approver",
  );
  assert.match(
    helper,
    /expectedRevision: plan\.revision/,
    "it must pass the revision it read, so the RPC's optimistic-concurrency guard still applies",
  );
  assert.match(
    helper,
    /catch \(error\)[\s\S]*logError\([\s\S]*return plan;/,
    "it must be best-effort - the approval already committed, so a failure must log and leave the plan at final_approved rather than throw",
  );
  assert.match(
    helper,
    /await notifyEmployeeAcknowledged\(acknowledged\)/,
    "the submitter must still be told their plan was acknowledged, exactly as the manual path tells them",
  );

  // ---- Both routes into final_approved must call it ------------------------------------------
  const decide = sliceFunction(service, "export async function decideEmployeePlan", "decideEmployeePlan");
  const autoAckCalls = decide.match(/autoAcknowledgeFinalApprovedPlan\(access, updated\)/g) ?? [];
  assert.equal(
    autoAckCalls.length,
    2,
    "BOTH routes into final_approved must auto-acknowledge: the direct ceo_approve, and the manager_approve cascade that District Manager plans take instead of a CEO decision",
  );
  const cascadeIndex = decide.indexOf("auto-cascaded from manager approval");
  assert.ok(cascadeIndex >= 0, "the manager_approve cascade must still exist - this test locates the cascade branch by its audit summary");
  assert.ok(
    decide.indexOf("autoAcknowledgeFinalApprovedPlan", cascadeIndex) >= 0,
    "the cascade branch must auto-acknowledge - a District Manager plan never passes through the ceo_approve branch",
  );
  assert.match(
    decide,
    /updated = await autoAcknowledgeFinalApprovedPlan\(access, updated\);\s*\n\s*await notifyHr\(updated\)/,
    "the acknowledgement must run BEFORE notifyHr, so HR's message reflects the state the plan is actually in",
  );

  // ---- HR's notification must tell the truth about which state the plan is in ------------------
  const notifyHr = sliceFunction(service, "async function notifyHr(", "notifyHr");
  assert.match(
    notifyHr,
    /const autoAcknowledged = plan\.status === "hr_acknowledged";/,
    "notifyHr must branch on the plan's real status, not assume the automatic acknowledgement succeeded",
  );
  assert.match(
    notifyHr,
    /no action needed/,
    "when the plan is already acknowledged, HR must be told no action is needed",
  );
  assert.match(
    notifyHr,
    /needs HR acknowledgement/,
    "the action-needed wording must survive for the one case that still reaches HR: the automatic acknowledgement failed and the plan is still final_approved",
  );
  assert.match(
    notifyHr,
    /additionalMetadata: \{ audience: "hr_awareness" \}/,
    "the no-action-needed copy must be tagged hr_awareness so the bell does not auto-archive it the instant the plan leaves HR's awaiting bucket",
  );

  // ---- The manual path stays as the fallback --------------------------------------------------
  const manual = sliceFunction(service, "export async function acknowledgeEmployeePlan", "acknowledgeEmployeePlan");
  assert.match(
    manual,
    /if \(!isHrReviewer\(access, employee\)\)/,
    "the manual acknowledge endpoint must stay gated on HR - making the step automatic must not open it to everyone",
  );
  assert.match(
    manual,
    /hrId,\n/,
    "the manual path must still record the real HR person as the actor, distinct from the automatic sentinel",
  );
  assert.doesNotMatch(
    manual,
    /AUTO_HR_ACK_HR_ID/,
    "a human acknowledgement must never be filed under the automatic sentinel - the two must stay distinguishable in the audit trail",
  );

  // The sentinel is the ON CONFLICT key (plan_id, hr_id) on employee_plan_hr_acknowledgements, so
  // it has to be a stable constant. An hr_id derived per call (a uuid, a timestamp) would insert a
  // fresh row on every re-approval instead of updating in place.
  assert.match(
    service,
    /const AUTO_HR_ACK_HR_ID = "[A-Z0-9-]+";/,
    "the sentinel actor must be a fixed string constant - it doubles as the acknowledgement table's conflict key",
  );

  // ---- The HR card must stop reading as a work queue -----------------------------------------
  // It lists final_approved AND hr_acknowledged plans. Now that nearly every row arrives already
  // acknowledged, a live Acknowledge button on all of them reads as "these are waiting for you".
  const workspaceUi = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  assert.match(
    workspaceUi,
    /p\.status === "hr_acknowledged" \? \([\s\S]{0,400}?Acknowledged[\s\S]{0,200}?\) : \([\s\S]{0,400}?onDecision\(p\.id, "hr_acknowledge"\)/,
    "the HR card must show an already-acknowledged plan as acknowledged, and keep the Acknowledge button only for one still at final_approved",
  );

  // The HR queue keys on final_approved, so an auto-acknowledged plan drops out of it by itself.
  // The queue must not be narrowed to hide the fallback case the automatic path leaves behind.
  const approvalsHub = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  assert.match(
    approvalsHub,
    /status === "final_approved" && hrActor/,
    "HR's awaiting bucket must still pick up a final_approved plan - that is exactly the plan whose automatic acknowledgement failed",
  );
}
