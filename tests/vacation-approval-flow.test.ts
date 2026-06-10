import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateStepAction,
  genericStepName,
  isSequentialWorkflowType,
  resolveActionAvailability,
  resolveActiveStep,
  resolveStageLabel,
  stepOrderForStepKey,
} from "../src/lib/vacation/approval-flow.ts";
import type {
  VacationApprovalStepState,
  VacationApprovalStepStatus,
  VacationWorkflowStepKey,
} from "../src/lib/vacation/types.ts";

function step(
  stepKey: VacationWorkflowStepKey,
  status: VacationApprovalStepStatus,
): VacationApprovalStepState {
  return { order: stepOrderForStepKey(stepKey), status, stepKey };
}

export function runVacationApprovalFlowTests() {
  // ---- Type scope: only Annual / Other / Compensatory are sequential ----
  for (const type of ["annual", "other", "compensatory", "emergency"] as const) {
    assert.equal(isSequentialWorkflowType(type), true, `${type} should use the sequential workflow`);
  }
  assert.equal(isSequentialWorkflowType("sick"), false, "only sick keeps the legacy parallel flow");

  // ---- Generic backend step identity ----
  assert.equal(genericStepName("direct_manager"), "management_approval_1");
  assert.equal(genericStepName("manager_of_manager"), "management_approval_2");
  assert.equal(genericStepName("hr"), "hr_acknowledgement");

  // ---- Chain shapes (creation expectation) ----
  const fullChain = [step("direct_manager", "pending"), step("manager_of_manager", "pending"), step("hr", "pending")];
  const shortChain = [step("direct_manager", "pending"), step("hr", "pending")]; // no manager-of-manager

  // ---- Sequencing: first management approver acts first ----
  const mgmt1First = evaluateStepAction({
    steps: fullChain,
    actorStep: { stepKey: "direct_manager", order: 1 },
    decision: "approve",
  });
  assert.equal(mgmt1First.allowed, true, "first management approver can approve first");
  assert.equal(mgmt1First.isFinal, false);
  assert.equal(mgmt1First.nextStatus, "pending_manager", "still pending the second management approver");

  // Second management approver CANNOT approve before the first.
  const mgmt2Blocked = evaluateStepAction({
    steps: fullChain,
    actorStep: { stepKey: "manager_of_manager", order: 2 },
    decision: "approve",
  });
  assert.equal(mgmt2Blocked.allowed, false, "second management approver is blocked before the first approves");
  assert.match(mgmt2Blocked.reason ?? "", /previous management approval/i);

  // After the first approves, the second can approve → hands off to HR.
  const afterMgmt1 = [step("direct_manager", "approved"), step("manager_of_manager", "pending"), step("hr", "pending")];
  const mgmt2Ok = evaluateStepAction({
    steps: afterMgmt1,
    actorStep: { stepKey: "manager_of_manager", order: 2 },
    decision: "approve",
  });
  assert.equal(mgmt2Ok.allowed, true, "second management approver can approve after the first");
  assert.equal(mgmt2Ok.nextStatus, "pending_hr", "last management approval hands off to HR acknowledgement");
  assert.equal(mgmt2Ok.isFinal, false);

  // ---- Fallback: no second management approver → after first approval go straight to HR ----
  const mgmt1NoMom = evaluateStepAction({
    steps: shortChain,
    actorStep: { stepKey: "direct_manager", order: 1 },
    decision: "approve",
  });
  assert.equal(mgmt1NoMom.nextStatus, "pending_hr", "with no manager-of-manager, first approval goes to HR");

  // ---- HR acknowledgement gating ----
  const hrBeforeMgmt = evaluateStepAction({
    steps: fullChain,
    actorStep: { stepKey: "hr", order: 3 },
    decision: "approve",
  });
  assert.equal(hrBeforeMgmt.allowed, false, "HR cannot acknowledge before management approvals complete");
  assert.match(hrBeforeMgmt.reason ?? "", /management approvals are completed/i);

  const allMgmtApproved = [step("direct_manager", "approved"), step("manager_of_manager", "approved"), step("hr", "pending")];
  const hrAck = evaluateStepAction({
    steps: allMgmtApproved,
    actorStep: { stepKey: "hr", order: 3 },
    decision: "approve",
  });
  assert.equal(hrAck.allowed, true, "HR can acknowledge after management approvals complete");
  assert.equal(hrAck.nextStatus, "approved");
  assert.equal(hrAck.isFinal, true);

  // ---- HR may reject at any time ----
  const hrRejectEarly = evaluateStepAction({
    steps: fullChain,
    actorStep: { stepKey: "hr", order: 3 },
    decision: "reject",
  });
  assert.equal(hrRejectEarly.allowed, true, "HR can reject at any stage");
  assert.equal(hrRejectEarly.nextStatus, "rejected");
  assert.equal(hrRejectEarly.isFinal, true);

  // Management rejection (of the active step) is final.
  const mgmtReject = evaluateStepAction({
    steps: fullChain,
    actorStep: { stepKey: "direct_manager", order: 1 },
    decision: "reject",
  });
  assert.equal(mgmtReject.nextStatus, "rejected");
  assert.equal(mgmtReject.isFinal, true);

  // ---- resolveActiveStep ----
  assert.equal(resolveActiveStep(fullChain)?.stepKey, "direct_manager");
  assert.equal(resolveActiveStep(afterMgmt1)?.stepKey, "manager_of_manager");
  assert.equal(resolveActiveStep(allMgmtApproved)?.stepKey, "hr");

  // ---- Dynamic, role-aware stage labels (never "Final Approval") ----
  const titles = { direct_manager: "District Sales Manager", manager_of_manager: "Regional Sales Manager", hr: null };
  assert.equal(
    resolveStageLabel({ status: "needs_assignment", vacationType: "annual", steps: fullChain, titles }),
    "Needs HR Assignment",
  );
  assert.equal(
    resolveStageLabel({ status: "pending_manager", vacationType: "annual", steps: fullChain, titles }),
    "Waiting for District Sales Manager Approval",
    "stage label must use the actual assigned approver title (dynamic)",
  );
  assert.equal(
    resolveStageLabel({ status: "pending_hr", vacationType: "annual", steps: allMgmtApproved, titles }),
    "Approved by Management - Pending HR Acknowledgement",
  );
  assert.equal(resolveStageLabel({ status: "approved", vacationType: "annual" }), "Recorded by HR");
  assert.equal(resolveStageLabel({ status: "approved", vacationType: "sick" }), "Approved", "sick keeps its own label");
  assert.equal(
    resolveStageLabel({
      status: "rejected",
      vacationType: "annual",
      steps: [step("direct_manager", "rejected"), step("hr", "pending")],
      titles,
    }),
    "Rejected by District Sales Manager",
  );
  assert.equal(
    resolveStageLabel({
      status: "rejected",
      vacationType: "annual",
      steps: [step("direct_manager", "approved"), step("hr", "rejected")],
      titles,
    }),
    "Rejected by HR",
  );
  // Governance: HR is acknowledgement/recording, never "Final Approval".
  for (const status of ["pending_hr", "approved", "rejected"] as const) {
    const label = resolveStageLabel({ status, vacationType: "annual", steps: allMgmtApproved, titles });
    assert.doesNotMatch(label, /final approval/i, `stage label for ${status} must not say "Final Approval"`);
  }

  // ---- resolveActionAvailability ----
  // HR on a request still pending management: reject enabled, acknowledge disabled with reason.
  const hrAvailEarly = resolveActionAvailability({
    status: "pending_manager",
    steps: fullChain,
    actorStep: { stepKey: "hr", order: 3 },
    isHrActor: true,
  });
  assert.equal(hrAvailEarly.reject.enabled, true, "HR can always reject");
  assert.equal(hrAvailEarly.acknowledge.enabled, false);
  assert.match(hrAvailEarly.acknowledge.disabledReason ?? "", /management approvals are completed/i);

  // Active management approver: approve + reject enabled.
  const mgmtAvail = resolveActionAvailability({
    status: "pending_manager",
    steps: fullChain,
    actorStep: { stepKey: "direct_manager", order: 1 },
    isHrActor: false,
  });
  assert.equal(mgmtAvail.approve.enabled, true);
  assert.equal(mgmtAvail.reject.enabled, true);

  // Second management approver before the first: approve disabled, with a clear reason.
  const mgmt2Avail = resolveActionAvailability({
    status: "pending_manager",
    steps: fullChain,
    actorStep: { stepKey: "manager_of_manager", order: 2 },
    isHrActor: false,
  });
  assert.equal(mgmt2Avail.approve.enabled, false);
  assert.match(mgmt2Avail.approve.disabledReason ?? "", /previous management approval/i);

  // Needs HR Assignment: HR can assign.
  const assignAvail = resolveActionAvailability({
    status: "needs_assignment",
    steps: [step("hr", "pending")],
    actorStep: { stepKey: "hr", order: 3 },
    isHrActor: true,
  });
  assert.equal(assignAvail.assign.enabled, true, "HR can assign on a Needs-HR-Assignment request");

  // ---- Source guards: Sick keeps the legacy path; new engine functions exist ----
  const serviceSource = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");
  assert.match(serviceSource, /isSequentialWorkflowType\(input\.request\.vacationType\)/, "decision path branches by workflow type");
  assert.match(serviceSource, /async function applyVacationDecisionLegacy\(/, "legacy parallel path is preserved for Sick/Emergency");
  assert.match(serviceSource, /async function applyVacationDecisionSequential\(/, "sequential path exists");
  assert.match(serviceSource, /export async function assignVacationManagementApprover\(/, "needs-assignment resume exists");
  assert.match(serviceSource, /export async function getVacationActionCenterData\(/, "action center feed exists");
  assert.match(serviceSource, /initialRequestStatus = "needs_assignment"/, "missing first manager routes to needs_assignment for sequential types");
}
