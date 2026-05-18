import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

export function runOperationalEventsTests() {
  const operationsSource = readFileSync("src/lib/operations/events.ts", "utf8");
  assert.match(operationsSource, /export async function getOperationalMonitoringStats/);
  assert.match(operationsSource, /export async function getOperationalAuditLogs/);
  assert.match(operationsSource, /export async function getOperationalRecentActivity/);
  assert.match(operationsSource, /from\("audit_logs"\)/);
  assert.match(operationsSource, /from\("salary_batches"\)/);
  assert.match(operationsSource, /from\("sales_audit_logs"\)/);
  assert.match(operationsSource, /from\("job_offer_audit_logs"\)/);
  assert.match(operationsSource, /from\("notification_delivery_logs"\)/);
  assert.match(operationsSource, /from\("notification_events"\)/);
  assert.match(operationsSource, /@\/lib\/fixture-hygiene/);
  assert.match(operationsSource, /isDisposableFixtureText/);
  assert.match(operationsSource, /businessSalaryBatchActivity/);
  assert.match(
    operationsSource,
    /isDisposablePayrollBatchRow/,
    "Monitoring operational activity must not mix disposable smoke payroll years into the normal business feed.",
  );

  const monitoringPageSource = readFileSync("app/admin/monitoring/page.tsx", "utf8");
  assert.match(monitoringPageSource, /getOperationalMonitoringStats/);
  assert.doesNotMatch(monitoringPageSource, /getAdminMonitoringStats/);

  const monitoringCsvSource = readFileSync("app/api/admin/monitoring/events-csv/route.ts", "utf8");
  assert.match(monitoringCsvSource, /getOperationalMonitoringStats/);
  assert.doesNotMatch(monitoringCsvSource, /getAdminMonitoringStats/);

  const monitoringComponentSource = readFileSync("src/components/admin/monitoring-dashboard.tsx", "utf8");
  assert.match(monitoringComponentSource, /@\/lib\/operations\/events/);
  assert.match(monitoringComponentSource, /stats\.operations\.recent/);

  const auditServiceSource = readFileSync("src/lib/admin/audit.ts", "utf8");
  assert.match(auditServiceSource, /getOperationalAuditLogs/);

  const logsPageSource = readFileSync("app/admin/logs/page.tsx", "utf8");
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
  assert.match(adminServiceSource, /getOperationalMonitoringStats/);
}
