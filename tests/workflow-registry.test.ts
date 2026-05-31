import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(path, "utf8");
}

export function runWorkflowRegistryTests() {
  const migration = source("supabase/migrations/20260527083111_workflow_registry.sql");
  const permissions = source("src/lib/auth/permissions.ts");
  const navigation = source("src/config/system-navigation.ts");
  const service = source("src/lib/workflow-registry/service.ts");
  const listRoute = source("app/api/admin/workflow-registry/route.ts");
  const moduleRoute = source("app/api/admin/workflow-registry/[moduleKey]/route.ts");
  const page = source("app/admin/workflow-control/page.tsx");
  const legacyPage = source("app/admin/workflow-registry/page.tsx");
  const manager = source("src/components/admin/workflow-registry-manager.tsx");

  assert.match(migration, /create table if not exists public\.workflow_registry_modules/);
  assert.match(migration, /statuses jsonb not null default '\[\]'::jsonb/);
  assert.match(migration, /actions jsonb not null default '\[\]'::jsonb/);
  assert.match(migration, /alter table public\.workflow_registry_modules enable row level security/);
  assert.match(migration, /revoke all on table public\.workflow_registry_modules from public, anon, authenticated/);
  assert.match(migration, /to service_role\s+using \(true\)\s+with check \(true\)/);
  assert.match(migration, /'outstation_expenses'/);
  assert.match(migration, /"key":"add_to_payroll"/);
  assert.match(migration, /"lock edit\/delete"/);

  assert.match(permissions, /\|\s+"workflow_registry"/);
  assert.match(permissions, /workflow_registry: allActions/);
  assert.match(permissions, /workflow_registry: \["read"\]/);
  assert.match(navigation, /href: "\/admin\/workflow-control"/);
  assert.match(navigation, /label: "Workflow Control"/);
  assert.match(navigation, /resource: "workflow_registry"/);

  assert.match(service, /export async function getWorkflowRegistryDashboard/);
  assert.match(service, /export async function resolveWorkflowRegistryTransition/);
  assert.match(service, /writeRequiredAuditLog/);
  assert.match(service, /entityType: "workflow_registry"/);
  assert.match(service, /only Super Admin can manage the Workflow Registry/);

  assert.match(listRoute, /assertPermission\(access, "workflow_registry", "read"\)/);
  assert.match(listRoute, /assertPermission\(access, "workflow_registry", "create"\)/);
  assert.match(moduleRoute, /assertPermission\(access, "workflow_registry", "update"\)/);
  assert.match(moduleRoute, /assertPermission\(access, "workflow_registry", "delete"\)/);

  assert.match(page, /WorkflowRegistryManager/);
  assert.match(legacyPage, /redirect\("\/admin\/workflow-control"\)/);
  assert.match(manager, /Workflow Control/);
  assert.match(manager, /Add workflow/);
  assert.match(manager, /WorkflowMap/);
  assert.match(manager, /Status boxes/);
  assert.match(manager, /Workflow arrows/);
  assert.doesNotMatch(manager, /Statuses JSON/);
  assert.doesNotMatch(manager, /Actions JSON/);
  assert.match(manager, /Change history/);
}
