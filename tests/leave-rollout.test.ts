import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const backupPath = "supabase/20260512_backup_leave_domain_before_rebuild.sql";
const checklistPath = "docs/leave-management-staging-rollout.md";

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
}
