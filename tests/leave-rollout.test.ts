import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const backupPath = "supabase/20260512_backup_leave_domain_before_rebuild.sql";
const checklistPath = "docs/leave-management-staging-rollout.md";
const rolloutScriptPath = "scripts/run-leave-staging-rollout.ps1";

const leaveDomainTables = [
  "vacation_attachments",
  "vacation_approvals",
  "vacation_balances",
  "vacation_requests",
  "vacation_settings",
  "vacation_types",
  "leave_approvals",
  "leave_transactions",
  "leave_requests",
  "employee_leave_balances",
  "public_holidays",
  "leave_policies",
  "leave_types",
];

export function runLeaveRolloutTests() {
  assert.equal(existsSync(backupPath), true, "backup SQL script should exist");
  assert.equal(existsSync(checklistPath), true, "staging rollout checklist should exist");
  assert.equal(existsSync(rolloutScriptPath), true, "staging rollout PowerShell script should exist");

  const backupSql = readFileSync(backupPath, "utf8");
  assert.match(backupSql, /create schema if not exists backup/);
  assert.match(backupSql, /leave_domain_backup_manifest/);
  assert.match(backupSql, /to_regclass\(format\('public\.\%I', v_table\)\)/);
  assert.match(backupSql, /like public\.\%I including all/);
  assert.match(backupSql, /insert into %I\.%I select \* from public\.\%I/);
  assert.match(backupSql, /Source table does not exist/);

  for (const table of leaveDomainTables) {
    assert.match(backupSql, new RegExp(`'${table}'`), `backup SQL should include ${table}`);
  }

  const checklist = readFileSync(checklistPath, "utf8");
  for (const phrase of [
    "backup old leave/vacation tables",
    "verify required private functions exist",
    "apply 20260512_leave_management_engine.sql",
    "test `/employee-portals/leave`",
    "test `/employee-portals/leave-approvals`",
    "test `/admin/leave`",
    "confirm old `/api/vacation` routes are gone",
    "rollback notes",
  ]) {
    assert.match(checklist.toLowerCase(), new RegExp(phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const snippet of [
    "information_schema.tables",
    "backup.leave_domain_backup_manifest",
    "to_regprocedure('private.phx_can_access_employee(text)')",
    "from public.leave_policies",
    "from public.leave_types",
    "from public.public_holidays",
    "from public.permissions",
  ]) {
    assert.match(checklist, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const rolloutScript = readFileSync(rolloutScriptPath, "utf8");
  for (const requiredText of [
    "PHOENIX_CONFIRM_STAGING_RLS_RUN",
    "YES_STAGING_ONLY",
    "PHOENIX_STAGING_ENVIRONMENT",
    "PHOENIX_STAGING_DATABASE_URL",
    "Production URL/database guard",
    "20260512_backup_leave_domain_before_rebuild.sql",
    "20260512_leave_management_engine.sql",
    "backup.leave_domain_backup_manifest",
    "private.phx_current_hr_id()",
    "private.phx_current_role()",
    "private.phx_current_scope()",
    "private.phx_can_access_employee(text)",
    "has_table_privilege",
    "Egypt Annual Leave Policy",
    "public.public_holidays",
    "npm run test",
    "npm run typecheck",
    "npm run lint",
    "npm run build",
    "/employee-portals/leave",
    "/employee-portals/leave-approvals",
    "/admin/leave",
    "/api/vacation",
    "docs\\leave-rollout-report.md",
  ]) {
    assert.match(
      rolloutScript,
      new RegExp(requiredText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `rollout script should include ${requiredText}`,
    );
  }

  assert.match(rolloutScript, /exit 1/);
  assert.match(rolloutScript, /Write-RolloutReport -FinalStatus "FAILED"/);
  assert.match(rolloutScript, /Write-RolloutReport -FinalStatus "SAFE"/);
}
