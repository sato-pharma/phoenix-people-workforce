import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { findAccessRegistryEntry } from "../src/lib/security/access-registry.ts";

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function sliceBetween(content: string, start: string, end: string) {
  const startIndex = content.indexOf(start);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  const endIndex = content.indexOf(end, startIndex + start.length);
  assert.ok(endIndex >= 0, `missing end marker: ${end}`);
  return content.slice(startIndex, endIndex);
}

export function runSystemCleanupCenterTests() {
  const service = source("../src/lib/admin/system-cleanup.ts");
  const permissions = source("../src/lib/auth/permissions.ts");
  const actionsRoute = source("../app/api/admin/system-cleanup/actions/route.ts");
  const recordsRoute = source("../app/api/admin/system-cleanup/records/route.ts");
  const page = source("../app/admin/system-cleanup/page.tsx");
  const center = source("../src/components/admin/system-cleanup-center.tsx");
  const migrationPath = new URL(
    "../supabase/migrations/20260612093625_admin_system_cleanup_center.sql",
    import.meta.url,
  );
  const migration = readFileSync(migrationPath, "utf8");

  assert.ok(existsSync(migrationPath), "admin cleanup migration must exist");

  assert.match(permissions, /\|\s+"system_cleanup"/, "permission resources must include system_cleanup");
  assert.match(permissions, /system_cleanup:\s*allActions/, "Super Admin must receive system_cleanup allActions");
  const ceoMatrix = sliceBetween(permissions, "  CEO: {", '  "Finance Manager": {');
  assert.equal(/system_cleanup/.test(ceoMatrix), false, "CEO must not receive system_cleanup permissions");

  assert.match(service, /access\.role !== "Super Admin"/, "cleanup service must hard-check Super Admin role");
  assert.match(service, /assertPermission\(access,\s*"system_cleanup"/, "cleanup service must also assert system_cleanup permission");
  assert.match(recordsRoute, /resolveAccessContext\(request\)/, "records API must resolve the current access context");
  assert.match(recordsRoute, /listCleanupRecords\(access,\s*filters\)/, "records API must call the guarded cleanup lister");
  assert.match(page, /assertSystemCleanupAccess\(access,\s*"read"\)/, "page must use the cleanup access guard");

  assert.match(actionsRoute, /assertSameOriginMutation\(request\)/, "cleanup POST must enforce same-origin CSRF");
  assert.match(actionsRoute, /executeCleanupAction\(access/, "cleanup POST must call the guarded execute path");
  assert.match(actionsRoute, /previewCleanupAction\(access/, "cleanup POST must call the guarded preview path");
  assert.match(service, /SYSTEM_CLEANUP_MAX_BULK\s*=\s*25/, "bulk cleanup must be capped at 25 records");
  assert.match(service, /DEFAULT_CLEANUP_NOTE\s*=\s*"No cleanup note provided\."/, "blank cleanup notes must be accepted with a safe history fallback");
  assert.match(service, /const reason = optionalCleanupNote\(input\.reason\)/, "cleanup execute must not require a manually entered reason");
  assert.match(center, /function handleExecuteClick\(\)/, "cleanup UI must validate delete prerequisites on click");
  assert.match(center, /Cleanup note \(optional\)/, "cleanup UI must label the note as optional");
  assert.match(center, /Check the confirmation box before deleting/, "cleanup UI must explain missing confirmation instead of silently disabling delete");
  assert.doesNotMatch(center, /reason of at least 10 characters/, "cleanup UI must not require a reason before deletion");
  assert.doesNotMatch(center, /disabled=\{executeDisabled\}/, "delete button must not be hard-disabled by hidden reason/confirmation state");

  assert.match(service, /cleanupModuleRegistry/, "cleanup modules must be routed through an internal registry");
  assert.match(service, /deleteVacationRequestAsAdmin/, "vacation cleanup must reuse existing vacation delete service");
  assert.match(service, /deleteOutstationRequestAsAdmin/, "outstation cleanup must reuse existing outstation delete service");
  assert.match(service, /outstationPayrollTripId/, "outstation cleanup must use canonical payroll trip ids");
  assert.match(service, /imported_payroll_batch_id != null \|\| row\.imported_to_payroll_at != null/, "payroll-linked outstation rows must be blocked");

  assert.match(service, /selectMaybeSingle\("weekly_plans"/, "weekly cleanup must snapshot the plan header");
  assert.match(service, /selectChildren\("weekly_plan_days"/, "weekly cleanup must snapshot child day rows");
  assert.match(service, /selectChildren\("weekly_plan_approval_tokens"/, "weekly cleanup must snapshot approval tokens");
  assert.match(service, /\.from\("weekly_plans"\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\("id", input\.loaded\.recordId\)/, "weekly cleanup must delete only the selected plan header");

  assert.match(service, /\.from\("admin_cleanup_events"\)[\s\S]*?\.insert\(/, "cleanup must write a cleanup history event before execution");
  assert.match(service, /finishCleanupEvent\(\{ cleanupEventId, status: "succeeded" \}\)/, "successful cleanup must complete the cleanup event");
  assert.match(service, /entityType:\s*"system_cleanup"/, "cleanup service must write the required cleanup audit log");
  assert.match(service, /entityType:\s*"weekly_plan"/, "weekly cleanup must also write the module audit log");
  assert.match(source("../src/lib/admin/audit.ts"), /"system_cleanup"/, "audit entity types must include system_cleanup");

  assert.match(migration, /create table if not exists public\.admin_cleanup_events/, "migration must create admin_cleanup_events");
  assert.match(migration, /alter table public\.admin_cleanup_events enable row level security/, "cleanup history must enable RLS");
  assert.match(migration, /revoke all on table public\.admin_cleanup_events from anon, authenticated/, "browser roles must be revoked");
  assert.match(migration, /grant select, insert, update on table public\.admin_cleanup_events to service_role/, "service_role must be the only direct writer");
  assert.match(migration, /admin_cleanup_events_employee_created_idx/, "migration must index cleanup history by employee/date");
  assert.match(migration, /admin_cleanup_events_module_record_idx/, "migration must index cleanup history by module/record");
  assert.match(migration, /admin_cleanup_events_actor_created_idx/, "migration must index cleanup history by actor/date");

  const actionRegistry = findAccessRegistryEntry("/api/admin/system-cleanup/actions", "POST");
  assert.ok(actionRegistry, "system cleanup action route must be registered");
  assert.equal(actionRegistry.audit.required, true, "system cleanup actions must require audit classification");
  assert.equal(actionRegistry.audit.classification, "mutation", "system cleanup actions must be classified as mutations");
  assert.equal(actionRegistry.csrf.required, true, "system cleanup actions must require CSRF protection");
  assert.deepEqual(actionRegistry.permission, { resource: "system_cleanup", action: "delete" }, "cleanup action registry must require system_cleanup delete");
}
