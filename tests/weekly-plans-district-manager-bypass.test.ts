import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { getNextEmployeePlanStatus, isDistrictManagerPlanSubmitter } from "../src/lib/weekly-planning/plan-v1.ts";

// District Manager plans skip the CEO stage entirely: the manager's (National Manager's)
// approval IS the final approval -- it lands straight on final_approved in ONE decision that
// writes NO ceo_approve row, HR acknowledges, and the CEO gets read-only visibility only.
// Mostly a source-pattern "hardening" test (like weekly-plans-hardening.test.ts) because
// decideEmployeePlan/acknowledgeEmployeePlan make live Supabase RPC calls with no mocking
// harness in this repo -- but the core state-machine invariant is pinned by executing the pure
// getNextEmployeePlanStatus directly (section 0), which is the one place the whole fix hinges.
export function runWeeklyPlansDistrictManagerBypassTests() {
  // 0. THE INVARIANT, EXECUTED. A District Manager plan's single manager_approve must resolve
  // to final_approved (bypassCeo) -- never manager_approved, which is the state that used to
  // force a second, fabricated ceo_approve row attributed to the approving manager. This is a
  // pure function, so it is asserted by calling it, not by reading source. Reverting the
  // plan-v1 bypass makes exactly this block go red.
  assert.equal(
    getNextEmployeePlanStatus("submitted", "manager_approve", { bypassCeo: true }),
    "final_approved",
    "a District Manager manager_approve (bypassCeo) must land on final_approved in one decision",
  );
  assert.equal(
    getNextEmployeePlanStatus("submitted", "manager_approve", { bypassCeo: false }),
    "manager_approved",
    "a non-bypass manager_approve must still rest at manager_approved (CEO stage intact for other roles)",
  );
  assert.equal(
    getNextEmployeePlanStatus("submitted", "manager_approve"),
    "manager_approved",
    "bypassCeo must default to false -- every existing caller keeps the four-stage flow",
  );
  // bypassCeo is scoped to manager_approve only: it must not perturb any other transition.
  assert.equal(
    getNextEmployeePlanStatus("manager_approved", "ceo_approve", { bypassCeo: true }),
    "final_approved",
    "bypassCeo must not change the real ceo_approve transition (still manager_approved -> final_approved)",
  );
  assert.equal(
    getNextEmployeePlanStatus("draft", "submit", { bypassCeo: true }),
    "submitted",
    "bypassCeo must be inert for non-manager_approve actions",
  );

  // 0b. WHO IS A DISTRICT MANAGER, EXECUTED. An acting District Manager keeps her Medical
  // Representative title and holds the District Manager APP ROLE (owner rule 2026-08-22). Reading
  // the title alone put her plans at manager_approved, waiting on a CEO stage a DM plan does not
  // have (her week-37 plan, 2026-09-10). The app role must count as well as the title.
  assert.equal(
    isDistrictManagerPlanSubmitter("Medical Representative", "District Manager"),
    true,
    "an acting District Manager (Medical Representative title, District Manager app role) must follow the District Manager plan pipeline",
  );
  assert.equal(
    isDistrictManagerPlanSubmitter("District Sales Manager", null),
    true,
    "a District Manager by title still follows the pipeline when the app role is unknown",
  );
  assert.equal(
    isDistrictManagerPlanSubmitter("Medical Representative", "Medical Rep"),
    false,
    "a Medical Representative with no District Manager role keeps the CEO stage",
  );
  assert.equal(
    isDistrictManagerPlanSubmitter("National Sales Manager", "National Sales Manager"),
    false,
    "a National Sales Manager plan keeps the CEO stage",
  );
  assert.equal(isDistrictManagerPlanSubmitter(null, undefined), false, "no title and no role is not a District Manager");

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

  // 2. decideEmployeePlan must reject a direct ceo_* call on a District Manager plan --
  // otherwise a CEO (or any direct API call) could still push a DM plan through
  // ceo_approve/ceo_reject/ceo_return even though the UI hides the button. The DM check runs
  // after assertPermission/assertCeoReviewer (not before) so it doesn't disturb the existing
  // proximity those two are pinned by in weekly-plans-permission-scope.test.ts -- the security
  // property is the same either way: no caller, CEO or not, can complete a ceo_* decide on a
  // DM plan.
  assert.match(
    serviceSource,
    /else if \(input\.action\.startsWith\("ceo_"\)\) \{[\s\S]*?assertCeoReviewer\(access\);[\s\S]*?if \(isDistrictManagerPlanTitle\(plan\.employee_job_title\)\) \{[\s\S]*?throw new Error\("Forbidden: District Manager plans are decided by HR, not the CEO\."\);[\s\S]*?\}/,
    "decideEmployeePlan must block ceo_* actions on a District Manager plan, closing the direct-call loophole",
  );

  // 3. The District Manager path must be a SINGLE bypass decision, not a two-call cascade:
  // decideEmployeePlan computes bypassCeo for a DM manager_approve and passes it to the ONE
  // rpcDecidePlan call. That call reaches final_approved directly, so no second ceo_approve
  // call is made and no ceo_approve row is written under the manager's identity.
  assert.match(
    serviceSource,
    /const isDistrictManagerPlan = isDistrictManagerPlanSubmitter\(plan\.employee_job_title, await authRoleForHrId\(plan\.employee_hr_id\)\);[\s\S]*?const bypassCeo = input\.action === "manager_approve" && isDistrictManagerPlan && !hasSecondApprover;/,
    "decideEmployeePlan must derive bypassCeo from a District Manager manager_approve, reading the submitter's app role as well as the title",
  );
  // The ceo_* guard (section 2) stays TITLE-only on purpose: a plan by an acting District Manager
  // that already rests at manager_approved from before the app-role check must keep the one
  // decision path it has. Widening that guard to the app role would strand it.
  assert.doesNotMatch(
    serviceSource,
    /isDistrictManagerPlanSubmitter\([^)]*\)\) \{\s*\n\s*throw new Error\("Forbidden: District Manager plans are decided by HR, not the CEO\."\);/,
    "the ceo_* guard must stay title-only so a pre-existing manager_approved plan is never stranded",
  );
  assert.match(
    serviceSource,
    /getNextEmployeePlanStatus\(plan\.status, input\.action, \{ comment: input\.comment, bypassCeo \}\)/,
    "the client-side next-status computation must honour bypassCeo so the audit log records final_approved for a DM plan",
  );
  // The single decide call carries bypassCeo through to the RPC (which mirrors it server-side).
  assert.match(
    serviceSource,
    /returnNotes: input\.returnNotes,\s*\n\s*bypassCeo,\s*\n\s*\}\);/,
    "the first (and only) rpcDecidePlan call must pass bypassCeo",
  );
  // The DM branch acknowledges + notifies HR and NEVER notifies the CEO.
  const bypassBranchMatch = serviceSource.match(
    /if \(bypassCeo\) \{[\s\S]*?await notifyHr\(updated\);\s*\n\s*\} else if \(input\.action === "manager_approve" && access\.role === "CEO"\) \{/,
  );
  assert.ok(
    bypassBranchMatch,
    "the bypassCeo branch must exist, acknowledge on HR's behalf, and precede the genuine-CEO branch",
  );
  assert.doesNotMatch(
    bypassBranchMatch[0],
    /notifyCeo/,
    "the District Manager bypass branch must never notify the CEO",
  );
  assert.match(
    serviceSource,
    /\} else if \(input\.action === "manager_approve"\) \{\s*\n\s*await notifyCeo\(updated\);/,
    "the CEO must still be notified on the normal (non-District-Manager) manager_approve path",
  );
  // A genuine ceo_approve row is only written on the real CEO branch (CEO approving an NSM plan),
  // never for a District Manager plan. There must be exactly one `action: "ceo_approve"` decide
  // call in decideEmployeePlan, and it must sit under the `access.role === "CEO"` branch.
  const ceoApproveCascades = serviceSource
    .slice(
      serviceSource.indexOf("export async function decideEmployeePlan"),
      serviceSource.indexOf("export async function", serviceSource.indexOf("export async function decideEmployeePlan") + 1),
    )
    .match(/action: "ceo_approve"/g) ?? [];
  assert.equal(
    ceoApproveCascades.length,
    1,
    "decideEmployeePlan must issue at most one ceo_approve cascade (the genuine CEO-of-NSM case), never one for a District Manager plan",
  );
  assert.match(
    serviceSource,
    /else if \(input\.action === "manager_approve" && access\.role === "CEO"\) \{[\s\S]*?action: "ceo_approve",/,
    "the sole ceo_approve cascade must be gated on access.role === \"CEO\" (a real CEO decision), not on the DM bypass",
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
    /if \(status === "manager_approved"\) \{[\s\S]*?if \(isCeo\) \{\s*\n\s*return isDistrictManagerPlan \? null : "ceo";/,
    "resolveApproverPlanStage must return null (not \"ceo\") for the CEO on a District Manager's manager_approved plan",
  );

  // 6. The CEO's live decide queue in the plans workspace UI must exclude District Manager
  // plans, or a stale/legacy manager_approved row would still render working Approve/Return/
  // Reject buttons for the CEO.
  assert.match(
    workspaceSource,
    /const ceoQueue = plans\.filter\(\s*\n\s*\(item\) =>\s*\n\s*item\.status === "manager_approved" &&\s*\n\s*\(\(access\.role === "CEO" && !isDistrictManagerPlanTitle\(item\.employeeJobTitle\)\) \|\|\s*\n\s*isSecondStagePlanForViewer\(item\)\),/,
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

  // 8. A District Manager plan can no longer rest at manager_approved (section 0: its single
  // manager approval cascades straight to final_approved), so the Approvals Hub must NOT surface
  // a manager_approved DM plan to HR's awaiting bucket. That branch was dead code -- if it were
  // ever hit, Acknowledge would call phx_weekly_plan_acknowledge, which only accepts
  // final_approved/hr_acknowledged and would throw. HR still reaches a DM plan through the normal
  // final_approved awaiting path just above.
  assert.doesNotMatch(
    approvalsHubSource,
    /status === "manager_approved" && isDistrictManagerPlan && hrActor/,
    "getPlanApprovalsForResponder must NOT surface a manager_approved District Manager plan to HR -- that state is now impossible and acknowledging it would throw",
  );

  // 9. acknowledgeEmployeePlan must NOT fabricate a ceo_approve. The former HACK advanced a
  // District Manager plan stuck at manager_approved by issuing a ceo_approve under the
  // acknowledging HR user's own identity -- the same fabricated-CEO-row defect this change
  // removes at its source. With the bypass (section 0), a DM plan reaches final_approved from
  // its single manager approval and never rests at manager_approved, so there is no stuck-plan
  // case left to cascade, and acknowledge simply acknowledges.
  const acknowledgeMatch = serviceSource.match(/export async function acknowledgeEmployeePlan\([\s\S]*?\n\}\n/);
  assert.ok(acknowledgeMatch, "acknowledgeEmployeePlan must exist");
  assert.doesNotMatch(
    acknowledgeMatch[0],
    /action: "ceo_approve"/,
    "acknowledgeEmployeePlan must never issue a ceo_approve -- fabricating a CEO decision under the HR user's identity is the exact defect being removed",
  );
  assert.doesNotMatch(
    acknowledgeMatch[0],
    /rpcDecidePlan/,
    "acknowledgeEmployeePlan must not run a decision RPC at all; it acknowledges an already-final_approved plan",
  );
  assert.match(
    acknowledgeMatch[0],
    /await rpcAcknowledgePlan\(\{\s*\n\s*comment,\s*\n\s*expectedRevision: plan\.revision,/,
    "acknowledgeEmployeePlan must acknowledge against the plan's own revision, with no intervening decide",
  );

  // 10. Approvals Hub needs its own read-only "District Manager Plans" tab: the CEO's
  // "awaiting" bucket never includes DM plans (#5/#8), so without a dedicated feed the CEO has
  // no page in Approvals Hub that surfaces them at all. Since 2026-10-16 the same feed also carries the
  // weeks a district manager plans in Phoenix CRM, merged beside the legacy ones (docs/phoenix-crm-manager-plan.md) —
  // a district manager's only ("dm"): a regional, national or product manager's week goes to Company Plans (2026-10-17).
  assert.match(
    approvalsHubSource,
    /export async function getCompanyDistrictManagerPlanRequests\(access: AccessContext\): Promise<CompanyRequestItem\[\]> \{\s*\n\s*const \[legacy, crm\] = await Promise\.all\(\[\s*\n\s*fetchCompanyPlanRequestItems\(access, \{ districtManagersOnly: true \}\),\s*\n\s*fetchCrmManagerPlanRequestItems\(access, null, "dm"\),\s*\n\s*\]\);\s*\n\s*return mergeCompanyPlanFeeds\(legacy, crm\);/,
    "approvals-hub must expose a District-Manager-filtered company plan feed, with the district managers' Phoenix CRM weeks merged beside it",
  );
  assert.match(
    approvalsHubSource,
    /options\?\.districtManagersOnly &&\s*\n\s*!isDistrictManagerPlanTitle\(jobTitle\) &&\s*\n\s*!hasDistrictManagerAppRole\?\.\(String\(row\.employee_hr_id \?\? ""\)\)\s*\n\s*\) \{\s*\n\s*continue;/,
    "the District Manager feed must admit a plan by title OR by the submitter's District Manager app role (an acting DM is titled Medical Representative)",
  );
  assert.match(
    approvalsHubSource,
    /const isDistrictManagerPlan =\s*\n\s*isDistrictManagerPlanTitle\(String\(row\.employee_job_title \?\? ""\)\) \|\|\s*\n\s*\(!keptCeoStage && isDistrictManagerPlanSubmitter\(null, await authRoleForHrId\(employeeHrId\)\)\);/,
    "the plan detail must treat an acting District Manager's plan as a DM plan, unless it really went through a CEO stage",
  );
  assert.match(
    approvalsHubSource,
    /districtManagerRequests: CompanyRequestItem\[\] \| null;/,
    "PlanWorkspaceData must carry the District Manager feed",
  );
  assert.match(
    approvalsHubSource,
    /showCeoTabs\s*\n?\s*\? getCompanyDistrictManagerPlanRequests\(access\)\.catch\(\(\) => \[\]\)\s*\n?\s*: getSecondApproverPlanRequests\(access\)\.catch\(\(\) => null\)/,
    "getPlanWorkspaceData must fetch the District Manager feed under the same CEO/Super-Admin gate as Company Plans (the second approver gets only his own DMs' feed otherwise)",
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
    /if \(!isDistrictManagerPlan \|\| hasSecondApprover\) \{\s*\n\s*steps\.push\(\{\s*\n\s*order: 3,\s*\n\s*stepKey: "ceo",/,
    "the ceo step must only be pushed onto the tracker when the plan is not a District Manager's (or that DM's manager has a second approver)",
  );
  assert.match(
    approvalsHubSource,
    /steps: buildPlanTrackerSteps\(row, directory\.employees, isDistrictManagerPlan, hasSecondApprover\),/,
    "getPlanApprovalDetail must thread isDistrictManagerPlan into the tracker",
  );

  // 15. planStageLabel no longer special-cases District Manager plans at manager_approved. A DM
  // plan can never rest at manager_approved (section 0), so that branch only ever described the
  // now-impossible stuck state. manager_approved is therefore always the CEO stage (only non-DM
  // plans ever reach it), and a DM plan's HR turn is labeled through the final_approved case.
  assert.match(
    approvalsHubSource,
    /case "manager_approved":\s*\n(?:\s*\/\/[^\n]*\n)*\s*return "CEO approval";/,
    "planStageLabel's manager_approved case must resolve to \"CEO approval\" (only non-DM plans ever rest there)",
  );
  assert.doesNotMatch(
    approvalsHubSource,
    /return isDistrictManagerPlan \? "HR acknowledgement" : "CEO approval";/,
    "planStageLabel must no longer branch on isDistrictManagerPlan for the impossible manager_approved DM state",
  );
  assert.match(
    approvalsHubSource,
    /stageLabel: hasSecondApprover && status === "manager_approved" \? "Second approver review" : planStageLabel\(status\),/,
    "getPlanApprovalDetail must call planStageLabel with status only -- the isDistrictManagerPlan arg is gone",
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
