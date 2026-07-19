import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// sameWorkforceLine is a zero-dependency pure function — safe to import directly
// in the test runner. canReadProbationEmployee lives in the full service (which pulls
// in Supabase, notification, and resignation dependencies that can't load under the
// alias-loader without stubs), so we test the line-matching behaviour via
// sameWorkforceLine directly — that IS the new logic under test.
import { sameWorkforceLine } from "../src/lib/workforce/hierarchy-resolver.ts";

export function runProbationStabilizationTests() {
  const serviceSource = readFileSync("src/lib/probation/service.ts", "utf8");
  const adminPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  const portalPageSource = readFileSync("app/employee-portals/probation/page.tsx", "utf8");
  const exportRouteSource = readFileSync("app/api/exports/route.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");
  const workflowRouteSource = readFileSync("app/api/probation/[id]/workflow/route.ts", "utf8");
  const notificationProcessRouteSource = readFileSync("app/api/notifications/process/route.ts", "utf8");
  const scheduledNotificationProcessingSource = readFileSync("src/lib/notifications/scheduled-processing.ts", "utf8");
  const contractRenewalsCronSource = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8");
  const inAppNotificationsSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  const portalServiceSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  const resignationsSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  const resignationsReportSource = readFileSync("src/components/reports/resignations-report.tsx", "utf8");
  const trackerSource = readFileSync("src/components/probation/probation-tracker.tsx", "utf8");

  assert.match(serviceSource, /getProbationRows\(access: AccessContext\)/);
  assert.match(serviceSource, /canReadProbationEmployee\(access, employee, viewer, employees\)/);
  assert.match(serviceSource, /export function canReadAllProbation/);
  assert.match(serviceSource, /canViewAllProbation\(access\) \|\| access\.role === "CEO"/);
  assert.match(serviceSource, /if \(canReadAllProbation\(access\)\) return true/);
  assert.match(adminPageSource, /isProbationAdministrator\(access\)/);
  assert.match(adminPageSource, /canReadAllProbation\(access\)/);
  assert.match(adminPageSource, /canCreate: canAdminister/);
  assert.match(adminPageSource, /canManageWorkflow: canAdminister/);
  assert.match(adminPageSource, /canExport: canViewAllProbation\(access\)/);
  assert.match(portalPageSource, /getProbationRows\(access\)/);
  assert.doesNotMatch(portalPageSource, /isDsm|isNsm/);
  assert.match(portalPageSource, /canSubmitManagerFeedback/);
  assert.match(permissionsSource, /Employee:\s*\{[\s\S]*?probation:\s*\["read"\]/);
  assert.match(permissionsSource, /"Medical Rep":\s*\{[\s\S]*?probation:\s*\["read"\]/);
  assert.match(permissionsSource, /"Regional Manager":\s*\{[\s\S]*?probation:\s*\["read"\]/);
  assert.match(permissionsSource, /Manager:\s*\{[\s\S]*?probation:\s*\["read"\]/);

  assert.match(exportRouteSource, /assertCanExportProbation\(access\)/);
  assert.match(exportRouteSource, /getProbationRows\(access\)/);

  assert.match(serviceSource, /allowedWorkflowActions/);
  assert.match(serviceSource, /validateWorkflowTransition/);
  assert.match(serviceSource, /const probationDays = 90/);
  assert.match(serviceSource, /baseProbationEndDate/);
  assert.match(serviceSource, /currentProbationEndDate/);
  assert.doesNotMatch(serviceSource, /probation\?\.status === extensionProbationStatus/);
  assert.doesNotMatch(serviceSource, /Extension end date must be later than the current probation end date/);
  assert.match(serviceSource, /getProbationReminderSchedule/);
  assert.match(serviceSource, /lifecycleRiskWindows\.probationWarningDays/);
  assert.match(serviceSource, /lifecycleRiskWindows\.probationCriticalDays/);
  assert.match(serviceSource, /lifecycleRiskWindows\.probationRiskDays/);
  assert.match(serviceSource, /resolveActiveHrApproverHrIds/, "HR approvers must be resolved by role, not hardcoded IDs");
  assert.doesNotMatch(serviceSource, /"HR Manager"/, "\"HR Manager\" is a job title, not an app_auth_users.role value — it must never appear in a role-array literal");
  assert.doesNotMatch(serviceSource, /phase6HrApproverHrIds/, "hardcoded approver IDs must be removed from probation service");
  assert.match(serviceSource, /probationWorkflowApproverHrIds/);
  assert.match(serviceSource, /Direct Manager/);
  assert.match(serviceSource, /Manager of Manager/);
  assert.match(serviceSource, /HR Pilot Approver/);
  assert.doesNotMatch(serviceSource, /loadHrAndTrainingReminderRecipients/);
  assert.doesNotMatch(serviceSource, /\.in\("role", \["HR Specialist", "Super Admin", "Training Manager"\]\)/);
  assert.doesNotMatch(serviceSource, /recipient_emails/);
  assert.doesNotMatch(serviceSource, /recipients:\s*\[employee\.hrId\]/);
  assert.match(serviceSource, /processDueProbationReminderEvents/);
  assert.match(serviceSource, /eventType:\s*"reminder_due"/);
  assert.match(serviceSource, /workflowApproverHrIds:\s*probationWorkflowApproverHrIds/);
  assert.match(serviceSource, /ctaLabel:\s*"Open Probation Review"/);
  assert.match(serviceSource, /\/api\/probation\/redirect/);
  assert.doesNotMatch(serviceSource, /recipientHrId,/);
  assert.doesNotMatch(serviceSource, /recipientHrId:/);
  assert.doesNotMatch(serviceSource, /Approve in Telegram|Reject in Telegram|callback_query/);
  assert.match(serviceSource, /ensureSystemProbationReview/);
  assert.match(notificationProcessRouteSource, /runScheduledNotificationProcessing/);
  assert.match(scheduledNotificationProcessingSource, /processDueProbationReminderEvents/);
  assert.match(scheduledNotificationProcessingSource, /processNotificationOutbox/);
  assert.match(contractRenewalsCronSource, /runScheduledNotificationProcessing/);
  assert.match(inAppNotificationsSource, /\.overlaps\("recipients"/);
  assert.match(inAppNotificationsSource, /mapInAppNotificationRows/);
  assert.match(portalServiceSource, /recipients\.cs/);
  assert.match(portalServiceSource, /category.*probation/);
  assert.match(workflowRouteSource, /expectedUpdatedAt/);
  assert.match(workflowRouteSource, /status: 409/);
  assert.match(workflowRouteSource, /"pass"/);
  assert.match(workflowRouteSource, /"terminate"/);
  assert.doesNotMatch(workflowRouteSource, /"extend"/);
  assert.doesNotMatch(workflowRouteSource, /"upload_letter"/);
  assert.doesNotMatch(workflowRouteSource, /approve_/);
  assert.doesNotMatch(workflowRouteSource, /"complete"/);

  assert.match(serviceSource, /resignEmployeeAndOpenVacancy/);
  assert.match(serviceSource, /\.from\("notification_events"\)/);
  assert.match(serviceSource, /if \(error\) throw error/);
  assert.match(resignationsSource, /vacancyCodeFromEmployee/);
  assert.match(resignationsSource, /Termination\/vacancy reference/);
  assert.match(resignationsSource, /phx_resign_employee_and_open_vacancy/);
  assert.match(resignationsReportSource, /Terminated Employees/);

  assert.match(trackerSource, /SelectedWorkflowAction/);
  assert.match(trackerSource, /Type HR ID to confirm termination/);
  assert.match(trackerSource, /expectedUpdatedAt: workflow\.updatedAt/);
  assert.match(trackerSource, /Start review/);
  assert.match(trackerSource, /Managers Feedback in Probation Period/);
  assert.match(trackerSource, /Feedback Text/);
  assert.doesNotMatch(trackerSource, /Approve extension/);
  assert.doesNotMatch(trackerSource, /Complete decision/);
  assert.doesNotMatch(trackerSource, /Create Probation Evaluation/);
  assert.doesNotMatch(trackerSource, /action === "extend"/);
  assert.doesNotMatch(trackerSource, /action === "upload_letter"/);
  assert.doesNotMatch(trackerSource, /Attach letter/);
  assert.doesNotMatch(readFileSync("app/api/probation/route.ts", "utf8"), /probationEndDate/);
  assert.doesNotMatch(trackerSource, /onClick=\{\(\) => runWorkflow\(row,/);

  // ── Line-scoped probation matching must prefer numeric line_id (canonical
  //    sameWorkforceLine), not text-only lineName — mirrors Coaching/Double-Visit-Analytics. ──
  assert.match(serviceSource, /import \{ sameWorkforceLine \} from "@\/lib\/workforce\/hierarchy-resolver"/);
  assert.match(serviceSource, /return sameWorkforceLine\(employee, viewer\)/);
  assert.doesNotMatch(
    serviceSource,
    /normalizeLineName\(employee\.lineName\)/,
    "Probation line matching must not fall back to the old text-only isSameLine implementation.",
  );

  const adminProbationPageSource = readFileSync("app/(admin)/probation/page.tsx", "utf8");
  assert.match(adminProbationPageSource, /canViewAllProbation\(access\)/);

  // ── Runtime: sameWorkforceLine is the new core of isSameLine in probation service. ──
  // 1) Same line_id matches even when lineName text is stale/differently-cased.
  assert.equal(
    sameWorkforceLine(
      { lineId: 1, lineName: "Anti Infective" },
      { lineId: 1, lineName: "ANTI-INFECTIVE (legacy)" },
    ),
    true,
    "same line_id must match regardless of stale lineName text",
  );

  // 2) Different line_id must NOT match even when both lineName values are blank.
  assert.equal(
    sameWorkforceLine({ lineId: 1, lineName: null }, { lineId: 2, lineName: null }),
    false,
    "different line_id must not match even when lineName coincidentally matches (both null)",
  );

  // 3) Neither side has line_id → normalized lineName text fallback preserves legacy behaviour.
  assert.equal(
    sameWorkforceLine({ lineName: "Pedia" }, { lineName: "pedia" }),
    true,
    "when no line_id is present, normalized lineName text fallback must still match",
  );
  assert.equal(
    sameWorkforceLine({ lineName: "Cardiovascular" }, { lineName: "pedia" }),
    false,
    "when no line_id, different normalized lineName must not match",
  );

  // 4) canViewAllProbation grants TM + MM company-wide — verified at source level.
  assert.match(
    serviceSource,
    /canViewAllProbation[\s\S]{0,400}Training Manager[\s\S]{0,200}Marketing Manager|canViewAllProbation[\s\S]{0,400}Marketing Manager[\s\S]{0,200}Training Manager/,
    "canViewAllProbation must include both Training Manager and Marketing Manager",
  );
}
