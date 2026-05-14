import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const migrationPath = "supabase/migrations/20260513100825_leave_production_readiness.sql";
const businessPolicyMigrationPath = "supabase/migrations/20260514135726_leave_business_policy_corrections.sql";
const simplifiedEntitlementMigrationPath = "supabase/migrations/20260514163534_simplify_leave_entitlement_policy.sql";
const docsPath = "docs/leave-production-readiness.md";
const moduleOverviewDocsPath = "docs/leave-module-overview.md";
const e2eUsersDocsPath = "docs/leave-e2e-staging-test-users.md";
const e2ePath = "tests/e2e/leave-management.spec.ts";

export function runLeaveProductionReadinessTests() {
  assert.equal(existsSync(migrationPath), true, "production readiness migration should exist");
  assert.equal(existsSync(businessPolicyMigrationPath), true, "business-policy correction migration should exist");
  assert.equal(existsSync(simplifiedEntitlementMigrationPath), true, "simplified entitlement migration should exist");
  assert.equal(existsSync(docsPath), true, "production readiness docs should exist");
  assert.equal(existsSync(moduleOverviewDocsPath), true, "leave module overview docs should exist");
  assert.equal(existsSync(e2eUsersDocsPath), true, "leave E2E staging test-user runbook should exist");
  assert.equal(existsSync(e2ePath), true, "leave Playwright E2E spec should exist");

  const migration = readFileSync(migrationPath, "utf8");
  for (const expected of [
    "create table if not exists public.leave_audit_logs",
    "create table if not exists public.leave_accrual_runs",
    "create table if not exists public.leave_attachment_objects",
    "storage.buckets",
    "leave-attachments",
    "public.phx_leave_submit_request_atomic",
    "public.phx_leave_manager_decision_atomic",
    "public.phx_leave_hr_decision_atomic",
    "public.phx_leave_adjust_balance_atomic",
    "public.phx_leave_run_accrual_atomic",
    "for update",
    "grant execute on function public.phx_leave_submit_request_atomic",
    "to service_role",
    "revoke all on function public.phx_leave_submit_request_atomic",
  ]) {
    assert.match(migration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(migration, /drop table/i, "production readiness migration must not drop tables");
  const businessPolicyMigration = readFileSync(businessPolicyMigrationPath, "utf8");
  for (const expected of [
    "employee_selectable",
    "balance_leave_type_id",
    "payment_status",
    "duration_unit",
    "hr_balance_decision",
    "phx_leave_cancel_request_atomic",
    "p_balance_decision",
    "sick_leave",
    "requires_attachment = case when code = 'sick_leave' then true else requires_attachment end",
    "employee_selectable = code in ('annual_leave', 'emergency_leave', 'sick_leave', 'other')",
  ]) {
    assert.match(businessPolicyMigration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  const simplifiedEntitlementMigration = readFileSync(simplifiedEntitlementMigrationPath, "utf8");
  for (const expected of [
    "annual_days_first_year = 15",
    "annual_days_after_first_year = 21",
    "accrual_method = 'monthly'",
    "accrual_frequency = 'monthly'",
    "check (accrual_method = 'monthly')",
    "check (accrual_frequency = 'monthly')",
    "drop column if exists annual_days_senior",
    "drop column if exists annual_days_disability",
    "drop column if exists senior_after_years",
    "drop column if exists senior_after_age",
    "drop column if exists has_disability",
  ]) {
    assert.match(simplifiedEntitlementMigration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const service = readFileSync("src/lib/leave/service.ts", "utf8");
  for (const rpc of [
    "phx_leave_submit_request_atomic",
    "phx_leave_manager_decision_atomic",
    "phx_leave_hr_decision_atomic",
    "phx_leave_adjust_balance_atomic",
    "phx_leave_run_accrual_atomic",
    "phx_leave_cancel_request_atomic",
  ]) {
    assert.match(service, new RegExp(`\\.rpc\\("${rpc}"`));
  }
  assert.match(service, /createLeaveCorrelationId/);
  assert.match(service, /employeeSelectableLeaveCodes/);
  assert.match(service, /balanceConsumingSubmitLeaveCodes/);
  assert.match(service, /isWithinFirstSixMonths/);
  assert.match(service, /Sick Leave cannot start in the future/);
  assert.match(service, /writeLeaveAuditLog/);
  assert.match(service, /getLeaveAttachmentDownloadUrl/);
  assert.match(service, /listLeaveAuditLogs/);
  assert.match(businessPolicyMigration, /leave\.request\.cancelled/);

  const attachmentRoute = readFileSync("app/api/leave/requests/[id]/attachment/route.ts", "utf8");
  assert.match(attachmentRoute, /getLeaveAttachmentDownloadUrl/);

  const attachmentSource = readFileSync("src/lib/leave/attachments.ts", "utf8");
  assert.match(attachmentSource, /createLeaveAttachmentObjectPath/);
  assert.match(attachmentSource, /createSignedUrl/);
  assert.match(attachmentSource, /leave-attachments/);

  const notificationSource = readFileSync("src/lib/leave/notifications.ts", "utf8");
  assert.match(notificationSource, /leave\.notification\.failed/);

  const docs = readFileSync(docsPath, "utf8");
  for (const phrase of [
    "Production rollout checklist",
    "Rollback checklist",
    "Monitoring checklist",
    "Post-deployment verification checklist",
    "Known risks",
    "Do not modify payroll",
  ]) {
    assert.match(docs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const moduleOverviewDocs = readFileSync(moduleOverviewDocsPath, "utf8");
  for (const phrase of [
    "Employee guide",
    "Manager guide",
    "Admin guide",
    "Attachment handling",
    "Testing checklist",
    "Payroll integration remains intentionally excluded",
  ]) {
    assert.match(moduleOverviewDocs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const e2e = readFileSync(e2ePath, "utf8");
  for (const phrase of [
    "getByTestId",
    "employee submit flow",
    "conflict warning flow",
    "manager approve",
    "HR approve",
    "accrual dry-run",
    "accrual execution",
    "analytics rendering",
    "attachment upload flow",
  ]) {
    assert.match(e2e, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const e2eUsersDocs = readFileSync(e2eUsersDocsPath, "utf8");
  for (const phrase of [
    "Do not use production",
    "E2E_LEAVE_BASE_URL",
    "E2E_LEAVE_EMPLOYEE_LOGIN",
    "E2E_LEAVE_MANAGER_LOGIN",
    "E2E_LEAVE_HR_LOGIN",
    "manager_hr_id",
    "pending_manager",
    "pending_hr",
  ]) {
    assert.match(e2eUsersDocs, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  const requestForm = readFileSync("src/components/leave/leave-request-form.tsx", "utf8");
  for (const testId of [
    "leave-submit-form",
    "leave-request-submit-button",
    "leave-start-date-input",
    "leave-end-date-input",
    "leave-conflict-warning",
  ]) {
    assert.match(requestForm, new RegExp(`data-testid="${testId}"`));
  }

  const workspaces = readFileSync("src/components/leave/leave-workspaces.tsx", "utf8");
  for (const testId of [
    "employee-leave-cancel-button",
    "manager-leave-approve-button",
    "manager-leave-reject-button",
    "hr-leave-approve-button",
    "hr-leave-reject-button",
  ]) {
    assert.match(workspaces, new RegExp(`data-testid="${testId}"`));
  }

  const accrualPanel = readFileSync("src/components/leave/leave-accrual-panel.tsx", "utf8");
  assert.match(accrualPanel, /data-testid="leave-accrual-dry-run-button"/);
  assert.match(accrualPanel, /data-testid="leave-accrual-safe-run-button"/);

  const analyticsPanel = readFileSync("src/components/leave/leave-analytics-panel.tsx", "utf8");
  assert.match(analyticsPanel, /data-testid="leave-admin-analytics"/);

  const activityLog = readFileSync("src/components/leave/leave-activity-log.tsx", "utf8");
  assert.match(activityLog, /Leave Activity & Audit Trail/);
  assert.match(activityLog, /data-testid="leave-activity-log"/);

  const detailModal = readFileSync("src/components/leave/leave-detail-modal.tsx", "utf8");
  assert.match(detailModal, /\/api\/leave\/requests\/\$\{selectedRequest\.id\}\/attachment/);
}
