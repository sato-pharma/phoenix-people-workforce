import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260601221112_access_identity_integrity_hardening.sql", import.meta.url),
  "utf8",
);
const accessControlSource = readFileSync(new URL("../src/lib/admin/access-control.ts", import.meta.url), "utf8");
const usersRouteSource = readFileSync(new URL("../app/api/admin/users/route.ts", import.meta.url), "utf8");
const usersBulkRouteSource = readFileSync(new URL("../app/api/admin/users/bulk/route.ts", import.meta.url), "utf8");
const usersBulkActionRouteSource = readFileSync(new URL("../app/api/admin/users/bulk-action/route.ts", import.meta.url), "utf8");
const setupLinkRouteSource = readFileSync(new URL("../app/api/admin/users/setup-link/route.ts", import.meta.url), "utf8");
const permissionsRouteSource = readFileSync(new URL("../app/api/admin/permissions/route.ts", import.meta.url), "utf8");

function assertContains(source: string, pattern: RegExp, message: string) {
  assert.match(source, pattern, message);
}

export function runAccessIdentityHardeningTests() {
  assertContains(accessControlSource, /export function assertSuperAdminUserAdminActor/, "service must expose a Super Admin-only user-admin guard");
  assertContains(accessControlSource, /only Super Admin can manage user access/, "service must reject non-Super-Admin user-admin actors");
  assertContains(accessControlSource, /assertSuperAdminUserAdminActor\(actor\);[\s\S]*const loginId/, "upsertAccessUser must guard before mutation work");
  assertContains(accessControlSource, /updateAccessUserStatus[\s\S]*assertSuperAdminUserAdminActor\(actor\);/, "status updates must guard before mutation work");

  assertContains(usersRouteSource, /assertSuperAdminUserMutation\(access\);[\s\S]*parseAccessUserRequest/, "POST /api/admin/users must block non-Super-Admin before parsing mutation payload");
  assertContains(usersRouteSource, /assertSuperAdminUserMutation\(access\);[\s\S]*parseAccessUserStatusRequest/, "PATCH /api/admin/users must block non-Super-Admin before parsing status payload");
  assertContains(usersBulkRouteSource, /access\.role !== "Super Admin"/, "bulk import must be Super Admin-only");
  assertContains(usersBulkActionRouteSource, /access\.role !== "Super Admin"/, "bulk enable/disable must be Super Admin-only");
  assertContains(setupLinkRouteSource, /access\.role !== "Super Admin"/, "password setup/reset link generation must be Super Admin-only");
  assertContains(permissionsRouteSource, /access\.role !== "Super Admin"/, "permission override mutation must remain Super Admin-only");

  assertContains(migrationSource, /Duplicate active user_access_profiles\.auth_user_id rows must be repaired/i, "migration must fail closed on duplicate active auth profiles");
  assertContains(migrationSource, /Duplicate active user_access_profiles\.login_id rows must be repaired/i, "migration must fail closed on duplicate active login profiles");
  assertContains(migrationSource, /Duplicate active user_access_profiles\.hr_id rows must be repaired/i, "migration must fail closed on duplicate active HR_ID profiles");
  assertContains(migrationSource, /create unique index if not exists user_access_profiles_active_auth_user_uidx/i, "migration must add active auth_user_id uniqueness");
  assertContains(migrationSource, /create unique index if not exists user_access_profiles_active_login_id_uidx/i, "migration must add active login_id uniqueness");
  assertContains(migrationSource, /create unique index if not exists user_access_profiles_active_hr_id_uidx/i, "migration must add active HR_ID uniqueness");
  assertContains(migrationSource, /add constraint app_auth_users_role_check/i, "migration must enforce app_auth_users role constraint");
  assertContains(migrationSource, /add constraint user_access_profiles_phoenix_role_check/i, "migration must enforce Phoenix role constraint on access profiles");
  assertContains(migrationSource, /add constraint user_access_profiles_scope_type_check/i, "migration must enforce access profile scope constraint");
  assertContains(migrationSource, /create or replace view public\.v_access_identity_health/i, "migration must expose a local identity health view");
  assertContains(migrationSource, /active_employee_without_auth_user/i, "identity health view must detect employees without auth users");
  assertContains(migrationSource, /auth_user_without_employee/i, "identity health view must detect auth users without employees");
  assertContains(migrationSource, /auth_user_missing_role/i, "identity health view must detect missing roles");
  assertContains(migrationSource, /security_invoker = true/i, "identity health view must remain security invoker");
}
