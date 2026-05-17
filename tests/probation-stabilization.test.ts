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
  assert.match(serviceSource, /probation\?\.status === extensionProbationStatus/);
  assert.match(serviceSource, /Extension end date must be later than the current probation end date/);
  assert.match(serviceSource, /getProbationReminderSchedule/);
  assert.match(serviceSource, /daysAfterHire: 30/);
  assert.match(serviceSource, /daysAfterHire: 60/);
  assert.match(serviceSource, /daysAfterHire: 75/);
  assert.match(serviceSource, /recipients:\s*\[employee\.managerHrId\]/);
  assert.match(serviceSource, /processDueProbationReminderEvents/);
  assert.match(notificationProcessRouteSource, /processDueProbationReminderEvents/);
  assert.match(notificationProcessRouteSource, /processNotificationOutbox/);
  assert.match(workflowRouteSource, /expectedUpdatedAt/);
  assert.match(workflowRouteSource, /status: 409/);
  assert.match(workflowRouteSource, /"pass"/);
  assert.match(workflowRouteSource, /"extend"/);
  assert.match(workflowRouteSource, /"terminate"/);
  assert.doesNotMatch(workflowRouteSource, /approve_/);
  assert.doesNotMatch(workflowRouteSource, /"complete"/);

  assert.match(serviceSource, /payroll_eligible = false/);
  assert.match(serviceSource, /organogram_visible = false/);
  assert.match(serviceSource, /\.from\("app_auth_users"\)/);
  assert.match(serviceSource, /\.from\("notification_events"\)/);
  assert.match(serviceSource, /if \(error\) throw error/);

  assert.match(trackerSource, /SelectedWorkflowAction/);
  assert.match(trackerSource, /Type HR ID to confirm termination/);
  assert.match(trackerSource, /expectedUpdatedAt: workflow\.updatedAt/);
  assert.match(trackerSource, /Start review/);
  assert.doesNotMatch(trackerSource, /Approve extension/);
  assert.doesNotMatch(trackerSource, /Complete decision/);
  assert.doesNotMatch(trackerSource, /Create Probation Evaluation/);
  assert.doesNotMatch(readFileSync("app/api/probation/route.ts", "utf8"), /probationEndDate/);
  assert.doesNotMatch(trackerSource, /onClick=\{\(\) => runWorkflow\(row,/);
}
