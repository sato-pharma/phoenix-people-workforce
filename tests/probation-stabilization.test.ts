import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runProbationStabilizationTests() {
  const serviceSource = readFileSync("src/lib/probation/service.ts", "utf8");
  const adminPageSource = readFileSync("app/probation/page.tsx", "utf8");
  const portalPageSource = readFileSync("app/employee-portals/probation/page.tsx", "utf8");
  const exportRouteSource = readFileSync("app/api/exports/route.ts", "utf8");
  const permissionsSource = readFileSync("src/lib/auth/permissions.ts", "utf8");
  const workflowRouteSource = readFileSync("app/api/probation/[id]/workflow/route.ts", "utf8");
  const notificationProcessRouteSource = readFileSync("app/api/notifications/process/route.ts", "utf8");
  const inAppNotificationsSource = readFileSync("src/lib/notifications/in-app.ts", "utf8");
  const portalServiceSource = readFileSync("src/lib/employee-portal/service.ts", "utf8");
  const resignationsSource = readFileSync("src/lib/resignations/service.ts", "utf8");
  const resignationsReportSource = readFileSync("src/components/reports/resignations-report.tsx", "utf8");
  const trackerSource = readFileSync("src/components/probation/probation-tracker.tsx", "utf8");

  assert.match(serviceSource, /getProbationRows\(access: AccessContext\)/);
  assert.match(serviceSource, /canReadProbationEmployee\(access, employee, viewer, employees\)/);
  assert.match(adminPageSource, /isProbationAdministrator\(access\)/);
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
  assert.match(serviceSource, /loadHrAndTrainingReminderRecipients/);
  assert.match(serviceSource, /Direct Manager/);
  assert.match(serviceSource, /Manager of Manager/);
  assert.match(serviceSource, /Training Manager/);
  assert.match(serviceSource, /recipient_emails/);
  assert.doesNotMatch(serviceSource, /recipients:\s*\[employee\.hrId\]/);
  assert.match(serviceSource, /processDueProbationReminderEvents/);
  assert.match(serviceSource, /ctaLabel:\s*"Submit Your Feedback"/);
  assert.match(serviceSource, /ensureSystemProbationReview/);
  assert.match(notificationProcessRouteSource, /processDueProbationReminderEvents/);
  assert.match(notificationProcessRouteSource, /processNotificationOutbox/);
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
}
