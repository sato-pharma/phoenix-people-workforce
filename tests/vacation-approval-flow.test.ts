import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  evaluateStepAction,
  genericStepName,
  isHrApproverDirectReport,
  isHrOnlyChain,
  isSequentialWorkflowType,
  resolveActionAvailability,
  resolveActiveStep,
  resolveStageLabel,
  shouldIncludeManagerOfManagerStep,
  shouldIncludeThirdManagementStep,
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

  // ---- Who the second management approver is (owner rule 2026-08-15, corrected 2026-08-19) ----
  // A District Manager's chain never includes the CEO, and never skips the National Sales
  // Manager. #2149 got only the first half: it dropped the second step for EVERY District
  // Manager, which silently removed the NSM from the chain of every DM who reports through a
  // Regional Sales Manager (live: B-74 Ahmed Mohamed Abdallah -> RSM Hany Saad -> HR, with NSM
  // Ali Mohamed Ali Elsayed skipped on his 16 and 19 Aug 2026 requests).
  const approver = (jobTitle: string | null, hrId = "X-1") => ({ hrId, jobTitle, positionTitle: null });
  const nsm = approver("National Sales Manager", "A-12");
  const ceo = approver("Ceo", "AA");

  assert.equal(
    shouldIncludeManagerOfManagerStep({ managerOfManager: nsm, requesterRole: "District Manager" }),
    true,
    "a District Manager reporting through a Regional Manager MUST still escalate to the National Sales Manager",
  );
  assert.equal(
    shouldIncludeManagerOfManagerStep({ managerOfManager: ceo, requesterRole: "District Manager" }),
    false,
    "a District Manager reporting straight to the NSM must not escalate to the CEO",
  );
  // Position title wins over job title, matching the canonical organogram classifier.
  assert.equal(
    shouldIncludeManagerOfManagerStep({
      managerOfManager: { hrId: "A-12", jobTitle: "Ceo", positionTitle: "National Sales Manager" },
      requesterRole: "District Manager",
    }),
    true,
    "the seat's position title decides the second approver's level, not a stale job title",
  );
  // Every other requester keeps the step whenever a manager-of-manager exists.
  for (const role of ["Medical Rep", "Regional Manager", "Product Manager"]) {
    assert.equal(
      shouldIncludeManagerOfManagerStep({ managerOfManager: ceo, requesterRole: role }),
      true,
      `${role} keeps the manager-of-manager step — the CEO drop is a District Manager rule only`,
    );
  }
  // Top-of-org reports have nobody above their manager: no second step, any role.
  assert.equal(
    shouldIncludeManagerOfManagerStep({ managerOfManager: null, requesterRole: "Medical Rep" }),
    false,
    "no manager-of-manager means no second step (CEO direct reports must still be able to submit)",
  );
  assert.equal(
    shouldIncludeManagerOfManagerStep({ managerOfManager: approver("National Sales Manager", ""), requesterRole: "District Manager" }),
    false,
    "an unidentifiable approver (no HR id) cannot be assigned a step",
  );

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
  assert.match(serviceSource, /export async function getVacationActionCenterData\(/, "action center feed exists");

  // ---- Approvals Hub guards: Vacation Approvals page/component/nav + employee tracking ----
  const navSource = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
  assert.match(navSource, /\/admin\/approvals\/vacation/, "nav exposes the Vacation Approvals page");
  const vacPage = readFileSync(new URL("../app/(admin)/admin/approvals/vacation/page.tsx", import.meta.url), "utf8");
  assert.match(vacPage, /getVacationWorkspaceData/, "vacation approvals page loads the responder workspace data");
  const decisionActions = readFileSync(new URL("../src/components/approvals-hub/decision-actions.tsx", import.meta.url), "utf8");
  assert.match(decisionActions, /Acknowledge \(HR\)/, "HR action is acknowledgement");
  assert.doesNotMatch(decisionActions, /Final Approval/i, "must never label HR as 'Final Approval'");
  assert.match(decisionActions, /A reason is required/, "reject/return require a reason");
  const assignRoute = readFileSync(new URL("../app/api/vacations/requests/[id]/assign/route.ts", import.meta.url), "utf8");
  assert.match(assignRoute, /assignVacationManagementApprover/, "assign route resumes a needs-assignment request");
  const reportSource = readFileSync(new URL("../src/components/vacation/vacation-report.tsx", import.meta.url), "utf8");
  assert.match(reportSource, /dynamicStatusLabel/, "employee tracking uses dynamic role-aware stage labels");
  assert.match(reportSource, /Recorded by HR/, "approved sequential leave shows 'Recorded by HR'");

  // ---- Audit findings M4 + M5 ----

  // M4: the legacy (Sick) parallel path's direct-manager step now goes through the same
  // runtime-overridable workflow-registry role check the sequential path already uses for its
  // pending_manager decision. The HR step is deliberately NOT covered here (see the inline
  // comment in service.ts) — the registry's hr_approve/hr_reject actions are seeded
  // `from: ["pending_hr"]` only, and Sick's overall status never leaves "pending_manager", so
  // wiring the HR step in would require a registry-seed migration, not an app-code change.
  const legacyFunctionSource = serviceSource.slice(serviceSource.indexOf("async function applyVacationDecisionLegacy("));
  assert.match(
    legacyFunctionSource,
    /if \(input\.access && step\.stepKey === "direct_manager"\) \{\s*const \{ actionKey \} = vacationDecisionAction\(\{/,
    "Sick leave's direct-manager decision is now gated by the workflow registry, matching the sequential flow's pending_manager check",
  );

  // M5: updateVacationRequestAsAdmin previously wrote without a compare-and-swap status guard,
  // unlike every other status-changing write in this file (which all use .eq("id", ...).eq("status",
  // expectedStatus) so a concurrent admin edit can't silently clobber a concurrently-decided status).
  const adminUpdateSource = serviceSource.slice(
    serviceSource.indexOf("export async function updateVacationRequestAsAdmin("),
    serviceSource.indexOf("export async function deleteVacationRequestAsAdmin("),
  );
  assert.match(
    adminUpdateSource,
    /\.eq\("id", existing\.id\)\s*\.eq\("status", existing\.status\)/,
    "admin update now uses the same compare-and-swap guard as every other vacation status write",
  );
  assert.match(
    adminUpdateSource,
    /if \(!data\) throw new Error\("Vacation request was updated by another user\. Refresh and try again\."\);/,
    "a lost race surfaces a clear conflict error instead of silently returning stale/undefined data",
  );

  // ---- Third management level (owner rule 2026-10-08) ----
  // Medical Rep -> District Manager -> Regional Manager -> National Sales Manager -> HR. The chain
  // used to stop at the Regional Manager, so the NSM never saw 6 active Medical Reps' requests.
  assert.equal(genericStepName("manager_level_3"), "management_approval_3");
  assert.ok(
    stepOrderForStepKey("manager_of_manager") < stepOrderForStepKey("manager_level_3") &&
      stepOrderForStepKey("manager_level_3") < stepOrderForStepKey("hr"),
    "the third management step sits between the second and HR",
  );
  const rsm = approver("Regional Sales Manager", "PD-0001");
  const dsm = approver("District Sales Manager", "D-1");
  assert.equal(
    shouldIncludeThirdManagementStep({ managerOfManager: rsm, includesManagerOfManagerStep: true, thirdManager: nsm }),
    true,
    "Medical Rep -> DSM -> Regional Manager -> NSM: the NSM is the third approver",
  );
  assert.equal(
    shouldIncludeThirdManagementStep({ managerOfManager: nsm, includesManagerOfManagerStep: true, thirdManager: ceo }),
    false,
    "once the NSM has been reached the chain stops — never the CEO",
  );
  assert.equal(
    shouldIncludeThirdManagementStep({ managerOfManager: rsm, includesManagerOfManagerStep: true, thirdManager: ceo }),
    false,
    "a third approver who is not the NSM is never added",
  );
  assert.equal(
    shouldIncludeThirdManagementStep({ managerOfManager: dsm, includesManagerOfManagerStep: true, thirdManager: null }),
    false,
    "no one above the second approver means no third step",
  );
  assert.equal(
    shouldIncludeThirdManagementStep({ managerOfManager: rsm, includesManagerOfManagerStep: false, thirdManager: nsm }),
    false,
    "no third step without a second step",
  );

  // ---- The HR team has ONE approval: the HR Manager, first and final (owner, 2026-11-08) ----
  // Their chain was HR Manager -> CEO -> HR Manager again (Yasmeena Elsafory's request of 8 Nov 2026).
  assert.equal(
    isHrApproverDirectReport({ directManagerHrId: "b-10", hrApproverHrIds: ["B-10", null] }),
    true,
    "someone who reports straight to the HR approver is on the HR team, whatever the id's casing",
  );
  assert.equal(
    isHrApproverDirectReport({ directManagerHrId: "D-1", hrApproverHrIds: ["B-10"] }),
    false,
    "everyone else keeps the ordinary management chain",
  );
  assert.equal(
    isHrApproverDirectReport({ directManagerHrId: null, hrApproverHrIds: ["B-10", null] }),
    false,
    "no direct manager is the needs-assignment path, never an HR-only chain",
  );
  const hrOnlyChain = [step("hr", "pending")];
  assert.equal(isHrOnlyChain(hrOnlyChain), true);
  assert.equal(isHrOnlyChain([step("direct_manager", "pending"), step("hr", "pending")]), false);
  assert.equal(isHrOnlyChain([]), false, "an empty chain is not an HR-only chain");
  const hrOnlyApprove = evaluateStepAction({
    steps: hrOnlyChain,
    actorStep: { stepKey: "hr", order: stepOrderForStepKey("hr") },
    decision: "approve",
  });
  assert.equal(hrOnlyApprove.allowed, true, "the HR Manager may approve at once — nobody comes first");
  assert.equal(hrOnlyApprove.nextStatus, "approved");
  assert.equal(hrOnlyApprove.isFinal, true, "his approval is the final one");
  assert.equal(
    resolveStageLabel({ status: "pending_hr", vacationType: "annual", steps: hrOnlyChain }),
    "Waiting for HR Manager Approval",
    "an HR-team request never claims management already approved it",
  );
  assert.equal(
    resolveStageLabel({ status: "pending_manager", vacationType: "sick", steps: hrOnlyChain }),
    "Waiting for HR Manager Approval",
  );
  const hrTeamServiceSource = readFileSync(new URL("../src/lib/vacation/service.ts", import.meta.url), "utf8");
  assert.match(
    hrTeamServiceSource,
    /if \(isHrApproverDirectReport\(\{ directManagerHrId: manager\.hrId, hrApproverHrIds: hrApprovers\.map\(\(row\) => row\.hrId\) \}\)\) \{\s*return hrApprovers;/,
    "the submit chain for the HR team is the HR step alone",
  );
  assert.match(
    hrTeamServiceSource,
    /if \(isHrOnlyChain\(approvalRecipients\)\) \{\s*includesManagerOfManagerStep = false;\s*if \(usesSequentialWorkflow\) initialRequestStatus = "pending_hr";/,
    "an HR-team request starts at HR, not at a management stage nobody holds",
  );

  const threeLevelChain = [
    step("direct_manager", "pending"),
    step("manager_of_manager", "pending"),
    step("manager_level_3", "pending"),
    step("hr", "pending"),
  ];
  const level3Early = evaluateStepAction({
    steps: threeLevelChain,
    actorStep: { stepKey: "manager_level_3", order: stepOrderForStepKey("manager_level_3") },
    decision: "approve",
  });
  assert.equal(level3Early.allowed, false, "the NSM cannot approve before the first two approvers");
  const afterSecond = [
    step("direct_manager", "approved"),
    step("manager_of_manager", "approved"),
    step("manager_level_3", "pending"),
    step("hr", "pending"),
  ];
  assert.equal(resolveActiveStep(afterSecond)?.stepKey, "manager_level_3", "the NSM is next once two approvers have approved");
  const secondApproves = evaluateStepAction({
    steps: [step("direct_manager", "approved"), step("manager_of_manager", "pending"), step("manager_level_3", "pending"), step("hr", "pending")],
    actorStep: { stepKey: "manager_of_manager", order: stepOrderForStepKey("manager_of_manager") },
    decision: "approve",
  });
  assert.equal(secondApproves.nextStatus, "pending_manager", "the second approval hands to the NSM, not to HR");
  const nsmApproves = evaluateStepAction({
    steps: afterSecond,
    actorStep: { stepKey: "manager_level_3", order: stepOrderForStepKey("manager_level_3") },
    decision: "approve",
  });
  assert.equal(nsmApproves.allowed, true);
  assert.equal(nsmApproves.nextStatus, "pending_hr", "only the NSM's approval hands the request to HR acknowledgement");
  const hrEarly = evaluateStepAction({
    steps: [step("direct_manager", "approved"), step("manager_of_manager", "approved"), step("manager_level_3", "pending"), step("hr", "pending")],
    actorStep: { stepKey: "hr", order: stepOrderForStepKey("hr") },
    decision: "approve",
  });
  assert.equal(hrEarly.allowed, false, "HR cannot acknowledge before the NSM has approved");

  // ---- Return for edit: every approval, every type, manager or HR (owner, 2026-10-08) ----
  // HR could not return at all ("HR cannot return requests to the employee"). It decides nothing
  // when it returns, so the result is never final, and it is allowed at any stage like a rejection.
  const hrReturn = evaluateStepAction({
    steps: [step("direct_manager", "pending"), step("hr", "pending")],
    actorStep: { stepKey: "hr", order: 3 },
    decision: "return",
  });
  assert.equal(hrReturn.allowed, true, "HR may return a request for the employee to edit, even before management has approved");
  assert.equal(hrReturn.nextStatus, "returned");
  assert.equal(hrReturn.isFinal, false, "a return decides nothing, so it is never final");

  const hrAvail = resolveActionAvailability({
    status: "pending_hr",
    steps: [step("direct_manager", "approved"), step("hr", "pending")],
    actorStep: { stepKey: "hr", order: 3 },
    isHrActor: true,
  });
  assert.equal(hrAvail.return.enabled, true, "the HR viewer is offered the return button");
  const mgrAvail = resolveActionAvailability({
    status: "pending_manager",
    steps: [step("direct_manager", "pending"), step("hr", "pending")],
    actorStep: { stepKey: "direct_manager", order: 1 },
    isHrActor: false,
  });
  assert.equal(mgrAvail.return.enabled, true, "the manager keeps the return button");
  const returnedAvail = resolveActionAvailability({
    status: "returned",
    steps: [step("direct_manager", "pending"), step("hr", "pending")],
    actorStep: { stepKey: "direct_manager", order: 1 },
    isHrActor: false,
  });
  assert.equal(returnedAvail.return.enabled, false, "nothing is actionable while the employee holds the request");

  // Source guards for the parts that need a database to run.
  const workflowSource = readFileSync(new URL("../src/lib/vacation/workflow.ts", import.meta.url), "utf8");
  assert.match(workflowSource, /"hr_return"/, "HR's return is its own registry action, from pending_hr");
  const returnHelper = serviceSource.slice(
    serviceSource.indexOf("async function returnVacationToEmployee("),
    serviceSource.indexOf("async function applyVacationDecision("),
  );
  assert.ok(returnHelper.length > 200, "the shared return helper exists");
  assert.match(
    legacyFunctionSource.slice(0, legacyFunctionSource.indexOf("const decisionValue")),
    /input\.decision === "return"\) \{\s*return returnVacationToEmployee/,
    "Sick leave has a return branch: without it a return fell through to the rejection path and REJECTED the request",
  );
  assert.doesNotMatch(
    serviceSource,
    /A return reason is required\./,
    "a plain Return for edit carries no comment, so the service must not demand one (the with-comment button demands it on screen)",
  );
  assert.match(serviceSource, /A rejection reason is required\./, "a rejection still needs its reason");
  const resubmitSource = serviceSource.slice(serviceSource.indexOf("export async function resubmitVacationRequest("));
  assert.match(resubmitSource, /edits\?: ResubmitVacationEdits/, "the employee can edit the request while resubmitting it");
  assert.match(resubmitSource, /validateVacationSubmissionDates\(/, "an edit passes the same date rules as a new submission");
  assert.match(resubmitSource, /vacationApprovalStepsTable\)\s*\.update\(\{[^}]*status: "pending"/, "changed dates start the approval chain again");

  const hubSource = readFileSync(new URL("../src/components/action-center/action-center-hub.tsx", import.meta.url), "utf8");
  assert.match(hubSource, /Return for Edit with Comment/, "Action Center offers the commented return");
  assert.match(hubSource, /key: "return_plain", label: "Return for Edit"/, "Action Center offers the one-click return");
  const detailSource = readFileSync(new URL("../src/components/approvals-hub/vacation-request-detail.tsx", import.meta.url), "utf8");
  assert.match(detailSource, /returnWithoutComment/, "the vacation approval page offers both returns");
  assert.match(decisionActions, /returnPlain: false/, "the one-click return needs no reason on screen");
  const panelSource = readFileSync(new URL("../src/components/vacation/returned-request-panel.tsx", import.meta.url), "utf8");
  assert.match(panelSource, /Edit and resubmit/, "the employee can edit a returned request");
  assert.match(panelSource, /Resubmit without changes/, "the employee can resubmit a returned request as it stands");

  // A return cannot write manager_decision (its check allows only approved/rejected), so after HR returns
  // a request the direct manager already approved it still reads "approved" - History and All Decisions
  // listed the return as an approval. The request's current status must win.
  // History builds its leave rows in approval-history-outcome.ts (tests/approval-history-final-state.test.ts
  // runs that rule on real shapes); All Decisions still builds them inline in the hub service.
  const historyOutcomeSource = readFileSync(new URL("../src/lib/action-center/approval-history-outcome.ts", import.meta.url), "utf8");
  const hubServiceSource = readFileSync(new URL("../src/lib/approvals-hub/service.ts", import.meta.url), "utf8");
  assert.match(
    historyOutcomeSource,
    /norm\(row\.status\) === "returned" \? \("returned" as const\) : null/,
    "History must show a returned request as returned even when manager_decision still reads approved",
  );
  assert.match(
    hubServiceSource,
    /row\.status === "returned" \? \("returned" as const\) : decodeDecision\(/,
    "All Decisions must show a returned request as returned even when manager_decision still reads approved",
  );

  // Owner rule, 2026-10-08: a compensatory leave needs a photo of the event, so it cannot be submitted
  // before the event date has arrived (the leave day itself was already checked against the event date).
  const compensatoryDetailsSource = serviceSource.slice(
    serviceSource.indexOf("function validateCompensatoryDetails("),
    serviceSource.indexOf("function validateCompensatoryDetails(") + 2500,
  );
  assert.match(
    compensatoryDetailsSource,
    /eventDate > getVacationPolicyToday\(\)/,
    "the server refuses a compensatory leave whose event has not taken place yet",
  );
  const requestFormSource = readFileSync(new URL("../src/components/vacation/vacation-request-form.tsx", import.meta.url), "utf8");
  assert.match(
    requestFormSource,
    /compensatoryEventDate > todayDateOnly\(\)/,
    "the form blocks submitting a compensatory leave before its event date",
  );
}
