import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// District Manager plans skip the CEO stage entirely: manager (National Manager) approval
// cascades straight to final_approved, HR acknowledges, and the CEO gets read-only visibility
// only -- never a decide action, never a notification. This is a source-pattern "hardening"
// test (like weekly-plans-hardening.test.ts) rather than an executing-functions test, since
// decideEmployeePlan/acknowledgeEmployeePlan make live Supabase RPC calls with no mocking
// harness in this repo.
export function runWeeklyPlansDistrictManagerBypassTests() {
  const planV1Source = readFileSync("src/lib/weekly-planning/plan-v1.ts", "utf8");
  const serviceSource = readFileSync("src/lib/weekly-planning/service.ts", "utf8");
  const workspaceSource = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const approvalsHubSource = readFileSync("src/lib/approvals-hub/service.ts", "utf8");
  const approvalsWorkspaceSource = readFileSync("src/components/approvals-hub/approvals-workspace.tsx", "utf8");
  const planApprovalsBodySource = readFileSync("src/components/approvals-hub/plan-approvals-body.tsx", "utf8");
  const companyRequestsListSource = readFileSync("src/components/approvals-hub/company-requests-list.tsx", "utf8");
  const requestTrackerSource = readFileSync("src/components/approvals-hub/request-tracker.tsx", "utf8");

  // 1. isDistrictManagerPlanTitle must resolve via the shared job-function classifier, not a
  // raw string list -- a literal list previously (in the now-dead legacy workflow.ts) folded
  // Regional Manager and generic "Sales Manager" into the same bucket as District Manager.
  assert.match(
    planV1Source,
    /export function isDistrictManagerPlanTitle\(jobTitle: string \| null\): boolean \{/,
    "plan-v1 must export isDistrictManagerPlanTitle",
  );
  assert.match(
    planV1Source,
    /return resolveJobFunctionRole\(jobTitle\) === "District Manager";/,
    "isDistrictManagerPlanTitle must classify via resolveJobFunctionRole so Regional Manager/Sales Manager titles never match",
  );

  // 2. decideEmployeePlan must reject a direct ceo_* call on a District Manager plan before
  // assertCeoReviewer runs -- otherwise a CEO (or any direct API call) could still push a DM
  // plan through ceo_approve/ceo_reject/ceo_return even though the UI hides the button.
  assert.match(
    serviceSource,
    /else if \(input\.action\.startsWith\("ceo_"\)\) \{[\s\S]*?if \(isDistrictManagerPlanTitle\(plan\.employee_job_title\)\) \{[\s\S]*?throw new Error\("Forbidden: District Manager plans are decided by HR, not the CEO\."\);[\s\S]*?\}[\s\S]*?assertCeoReviewer\(access\);/,
    "decideEmployeePlan must block ceo_* actions on a District Manager plan ahead of assertCeoReviewer, closing the direct-call loophole",
  );

  // 3. The District Manager auto-cascade branch must notify HR and must NEVER notify the CEO;
  // notifyCeo may only fire on the plain (non-cascade) manager_approve path.
  const cascadeBlockMatch = serviceSource.match(
    /const isDistrictManagerPlan = isDistrictManagerPlanTitle\(updated\.employee_job_title\);[\s\S]*?await notifyHr\(updated\);\n\s*\} else if \(input\.action === "manager_approve"\) \{/,
  );
  assert.ok(
    cascadeBlockMatch,
    "the manager_approve auto-cascade block must exist and end with notifyHr before falling through to the plain manager_approve branch",
  );
  assert.doesNotMatch(
    cascadeBlockMatch[0],
    /notifyCeo/,
    "the District Manager (and CEO-self-approval) auto-cascade branch must never notify the CEO",
  );
  assert.match(
    serviceSource,
    /\} else if \(input\.action === "manager_approve"\) \{\s*\n\s*await notifyCeo\(updated\);/,
    "the CEO must still be notified on the normal (non-District-Manager) manager_approve path",
  );

  // 4. summarizePlans must not count a District Manager's manager_approved plan as CEO-pending
  // work, or the CEO's dashboard badge would advertise a decision that will never be theirs.
  assert.match(
    serviceSource,
    /if \(plan\.status === "manager_approved"\) \{\s*\n\s*if \(!isDistrictManagerPlanTitle\(plan\.employeeJobTitle\)\) \{\s*\n\s*summary\.ceoPending \+= 1;/,
    "summarizePlans must exclude District Manager plans from ceoPending",
  );

  // 5. resolveApproverPlanStage -- the single source of truth mirrored by both the server
  // decide guards and the approvals-hub bucketing -- must return null for the CEO on a
  // District Manager's manager_approved plan.
  assert.match(
    serviceSource,
    /if \(status === "manager_approved"\) \{\s*\n\s*if \(isCeo\) \{\s*\n\s*return isDistrictManagerPlanTitle\(jobTitle \?\? null\) \? null : "ceo";/,
    "resolveApproverPlanStage must return null (not \"ceo\") for the CEO on a District Manager's manager_approved plan",
  );

  // 6. The CEO's live decide queue in the plans workspace UI must exclude District Manager
  // plans, or a stale/legacy manager_approved row would still render working Approve/Return/
  // Reject buttons for the CEO.
  assert.match(
    workspaceSource,
    /const ceoQueue = plans\.filter\(\s*\n\s*\(item\) =>\s*\n\s*item\.status === "manager_approved" &&\s*\n\s*access\.role === "CEO" &&\s*\n\s*!isDistrictManagerPlanTitle\(item\.employeeJobTitle\),/,
    "the workspace CEO decide queue must exclude District Manager plans",
  );

  // 7. A dedicated, genuinely read-only queue must exist so District Manager plans stay
  // discoverable to the CEO instead of just disappearing once excluded from ceoQueue (#6).
  // QueueCard (reused here, same as "My Plans") has no onDecision prop at all -- it cannot
  // render a decide action even by mistake.
  assert.match(
    workspaceSource,
    /const districtManagerReadOnlyQueue = plans\.filter\(/,
    "the workspace must build a dedicated read-only queue of District Manager plans for the CEO",
  );
  assert.match(
    workspaceSource,
    /title="District Manager Plans"/,
    "the read-only District Manager section must be rendered in the workspace",
  );
  assert.match(
    workspaceSource,
    /<QueueCard[\s\S]*?plans=\{districtManagerReadOnlyQueue\}[\s\S]*?readOnly[\s\S]*?\/>/,
    "the District Manager section must be passed readOnly so its header renders the view-only eye icon",
  );
  const queueCardMatch = workspaceSource.match(/function QueueCard\([\s\S]*?\n\}\n\nfunction ReviewCard/);
  assert.ok(queueCardMatch, "QueueCard must be defined immediately before ReviewCard");
  assert.doesNotMatch(
    queueCardMatch[0],
    /onDecision/,
    "QueueCard must never accept a decide action -- reusing it for the District Manager section guarantees it stays view-only",
  );

  // 8. Approvals Hub must route a manager_approved District Manager plan into HR's awaiting
  // bucket (stage "hr"), not leave it waiting on a CEO stage that will never claim it.
  assert.match(
    approvalsHubSource,
    /if \(status === "manager_approved" && isDistrictManagerPlan && hrActor\) \{\s*\n\s*awaiting\.push\(\{ \.\.\.base, stage: "hr" \}\);/,
    "getPlanApprovalsForResponder must surface a manager_approved District Manager plan to HR as awaiting",
  );

  // 9. acknowledgeEmployeePlan must auto-cascade a legacy plan stuck at manager_approved
  // (submitted before this feature existed) to final_approved BEFORE running the HR
  // acknowledge RPC, or those plans are permanently orphaned once no stage claims them.
  const acknowledgeMatch = serviceSource.match(/export async function acknowledgeEmployeePlan\([\s\S]*?\n\}\n/);
  assert.ok(acknowledgeMatch, "acknowledgeEmployeePlan must exist");
  assert.match(
    acknowledgeMatch[0],
    /if \(plan\.status === "manager_approved" && isDistrictManagerPlanTitle\(plan\.employee_job_title\)\) \{[\s\S]*?action: "ceo_approve",/,
    "acknowledgeEmployeePlan must cascade a stuck District Manager plan to final_approved via ceo_approve before acknowledging",
  );
  const cascadeIndex = acknowledgeMatch[0].indexOf('action: "ceo_approve"');
  const ackCallIndex = acknowledgeMatch[0].indexOf("await rpcAcknowledgePlan(");
  assert.ok(cascadeIndex > -1, "the ceo_approve cascade call must be present in acknowledgeEmployeePlan");
  assert.ok(ackCallIndex > -1, "the final rpcAcknowledgePlan call must be present in acknowledgeEmployeePlan");
  assert.ok(
    cascadeIndex < ackCallIndex,
    "the legacy-plan cascade must run before the HR acknowledge RPC, not after",
  );

  // 10. Approvals Hub needs its own read-only "District Manager Plans" tab: the CEO's
  // "awaiting" bucket never includes DM plans (#5/#8), so without a dedicated feed the CEO has
  // no page in Approvals Hub that surfaces them at all.
  assert.match(
    approvalsHubSource,
    /export async function getCompanyDistrictManagerPlanRequests\(access: AccessContext\): Promise<CompanyRequestItem\[\]> \{\s*\n\s*return fetchCompanyPlanRequestItems\(access, \{ districtManagersOnly: true \}\);/,
    "approvals-hub must expose a District-Manager-filtered company plan feed",
  );
  assert.match(
    approvalsHubSource,
    /if \(options\?\.districtManagersOnly && !isDistrictManagerPlanTitle\(jobTitle\)\) continue;/,
    "the shared company-plan-request fetcher must filter by isDistrictManagerPlanTitle, the same classifier used everywhere else in this feature",
  );
  assert.match(
    approvalsHubSource,
    /districtManagerRequests: CompanyRequestItem\[\] \| null;/,
    "PlanWorkspaceData must carry the District Manager feed",
  );
  assert.match(
    approvalsHubSource,
    /showCeoTabs \? getCompanyDistrictManagerPlanRequests\(access\)\.catch\(\(\) => \[\]\) : Promise\.resolve\(null\)/,
    "getPlanWorkspaceData must fetch the District Manager feed under the same CEO/Super-Admin gate as Company Plans",
  );

  // 11. The tab must actually be wired up end to end: plan-approvals-body passes the feed into
  // the shared ApprovalsWorkspace under a distinct, correctly-labeled tab.
  assert.match(
    planApprovalsBodySource,
    /secondaryCompanyRequests=\{data\.districtManagerRequests\}/,
    "plan-approvals-body must pass the District Manager feed into the shared workspace",
  );
  assert.match(
    planApprovalsBodySource,
    /secondaryCompanyRequestsTabLabel="District Manager Plans"/,
    "the tab must be labeled \"District Manager Plans\"",
  );

  // 12. The shared ApprovalsWorkspace tab renderer must route this feed through
  // CompanyRequestsList (#13 below proves that component has no decide affordance at all), and
  // the tab itself must be additive -- other approval pages (Vacation/Excuse) that never pass
  // secondaryCompanyRequests must keep behaving exactly as before.
  assert.match(
    approvalsWorkspaceSource,
    /secondaryCompanyRequests\?: CompanyRequestItem\[\] \| null;/,
    "ApprovalsWorkspace must accept the secondary read-only feed as optional, so it stays additive for every other approval page reusing this component",
  );
  assert.match(
    approvalsWorkspaceSource,
    /tab === "secondary-company-requests" \? \(\s*\n\s*<CompanyRequestsList/,
    "the secondary-company-requests tab must render via CompanyRequestsList, the same read-only list component Company Plans already uses",
  );

  // 13. CompanyRequestsList itself must never accept a decide action -- this is what makes the
  // District Manager Plans tab genuinely view-only rather than relying on convention.
  assert.doesNotMatch(
    companyRequestsListSource,
    /onDecision|onApprove|onReject/,
    "CompanyRequestsList must have no decide-action prop at all, so reusing it for District Manager Plans is guaranteed read-only",
  );

  // 14. The plan detail's Approval Tracker must drop the CEO step entirely for a District
  // Manager plan (not just relabel it) -- otherwise the tracker shows "CEO Approval: pending"
  // for a decision the CEO will never make, contradicting every other fix in this file.
  const trackerMatch = approvalsHubSource.match(/function buildPlanTrackerSteps\([\s\S]*?\n\}\n/);
  assert.ok(trackerMatch, "buildPlanTrackerSteps must exist");
  assert.match(
    trackerMatch[0],
    /isDistrictManagerPlan = false,/,
    "buildPlanTrackerSteps must accept an isDistrictManagerPlan flag",
  );
  assert.match(
    trackerMatch[0],
    /if \(!isDistrictManagerPlan\) \{\s*\n\s*steps\.push\(\{\s*\n\s*order: 3,\s*\n\s*stepKey: "ceo",/,
    "the ceo step must only be pushed onto the tracker when the plan is not a District Manager's",
  );
  assert.match(
    approvalsHubSource,
    /steps: buildPlanTrackerSteps\(row, directory\.employees, isDistrictManagerPlan\),/,
    "getPlanApprovalDetail must thread isDistrictManagerPlan into the tracker",
  );

  // 15. planStageLabel's "Current stage" banner must say HR, not CEO, for a District Manager
  // plan sitting at manager_approved -- it's genuinely HR's turn, not a mislabeled CEO wait.
  assert.match(
    approvalsHubSource,
    /case "manager_approved":\s*\n(?:\s*\/\/[^\n]*\n)*\s*return isDistrictManagerPlan \? "HR acknowledgement" : "CEO approval";/,
    "planStageLabel must say HR acknowledgement, not CEO approval, for a District Manager plan",
  );
  assert.match(
    approvalsHubSource,
    /stageLabel: planStageLabel\(status, isDistrictManagerPlan\),/,
    "getPlanApprovalDetail must thread isDistrictManagerPlan into planStageLabel",
  );

  // 16. The CEO/HR tracker rows must never read "Unassigned" before anyone decides -- there's
  // always exactly one CEO and one HR/Super Admin, so approverTitle (e.g. "CEO"/"HR") is the
  // correct fallback; Direct Manager keeps the bare "Unassigned" fallback since a plan can
  // genuinely lack an assigned manager (NSM-with-no-manager edge case).
  assert.match(
    requestTrackerSource,
    /\{step\.approverName \? step\.approverName : step\.approverTitle \?\? "Unassigned"\}/,
    "RequestTracker must fall back to the step's role title before the generic Unassigned placeholder",
  );
  assert.match(
    approvalsHubSource,
    /genericStep: "hr",\s*\n\s*status: hrStatus,\s*\n\s*approverName: ack\?\.hr_id[\s\S]{0,80}approverTitle: "HR",/,
    "the plan tracker's hr step must set approverTitle to \"HR\" so it never shows Unassigned before HR acts",
  );
}
