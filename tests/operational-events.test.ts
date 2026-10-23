import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";

export function runOperationalEventsTests() {
  const operationsSource = readFileSync("src/lib/operations/events.ts", "utf8");
  assert.match(operationsSource, /export async function getOperationalAuditLogs/);
  assert.match(operationsSource, /export async function getOperationalRecentActivity/);
  assert.match(operationsSource, /from\("audit_logs"\)/);
  assert.match(operationsSource, /from\("salary_batches"\)/);
  assert.match(operationsSource, /from\("sales_audit_logs"\)/);
  // job_offer_audit_logs was DROPPED; reading it failed on every call and the failure became an
  // empty "Recruitment" feed that looked like a quiet day (retired 23 Oct 2026).
  assert.doesNotMatch(operationsSource, /job_offer_audit_logs/, "the activity feed must not read the dropped offer audit table");
  assert.doesNotMatch(operationsSource, /"Recruitment"/, "no Recruitment source is left to label");
  // A failed source is NAMED, never silently empty.
  assert.match(operationsSource, /staleSources\.push\(label\)/, "a failed activity source must be named in staleSources");
  assert.doesNotMatch(operationsSource, /result\.error \? \[\]/, "a failed read must not quietly become []");
  assert.doesNotMatch(operationsSource, /staleSources: \[\],/, "staleSources must not be hard-wired to empty");
  // The Monitoring page's aggregate went with the page.
  assert.doesNotMatch(operationsSource, /getOperationalMonitoringStats/);
  assert.doesNotMatch(operationsSource, /getEmailDeliveryMonitoring/);
  assert.doesNotMatch(
    operationsSource,
    /from\("notification_delivery_logs"\)/,
    "notification_delivery_logs was retired (zero writers, zero rows)",
  );
  assert.match(operationsSource, /@\/lib\/fixture-hygiene/);
  assert.match(operationsSource, /businessSalaryBatchActivity/);
  assert.match(
    operationsSource,
    /isDisposablePayrollBatchRow/,
    "Operational activity must not mix disposable smoke payroll years into the normal business feed.",
  );

  // Monitoring retired: the page forwards, the dashboard and its CSV route are gone.
  const monitoringPageSource = readFileSync("app/(admin)/admin/monitoring/page.tsx", "utf8");
  assert.match(monitoringPageSource, /redirect\("\/admin\/system-audit"\)/);
  assert.ok(!existsSync("app/api/admin/monitoring/events-csv/route.ts"), "the Monitoring CSV route was retired");
  assert.ok(!existsSync("src/components/admin/monitoring-dashboard.tsx"), "the Monitoring dashboard was retired");

  const auditServiceSource = readFileSync("src/lib/admin/audit.ts", "utf8");
  assert.match(auditServiceSource, /getOperationalAuditLogs/);

  const logsPageSource = readFileSync("app/(admin)/admin/logs/page.tsx", "utf8");
  assert.match(logsPageSource, /getAuditLogs/);

  const overviewSource = readFileSync("src/lib/overview/service.ts", "utf8");
  assert.match(overviewSource, /getOperationalRecentActivity/);
  assert.doesNotMatch(overviewSource, /sales_audit_logs/);
  assert.doesNotMatch(overviewSource, /job_offer_audit_logs/);
  assert.doesNotMatch(overviewSource, /salary_batches\?/);

  const commandCenterSource = readFileSync("src/lib/admin/command-center.ts", "utf8");
  assert.match(commandCenterSource, /getOperationalRecentActivity/);
  assert.match(commandCenterSource, /operations: OperationalActivitySummary/);

  const adminServiceSource = readFileSync("src/lib/admin/service.ts", "utf8");
  assert.doesNotMatch(adminServiceSource, /getAdminMonitoringStats/, "the dead Monitoring wrapper was removed");
}
