import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard, matching this repo's idiom for DB-touching resignation code.
//
// employees_crm_id_unique_idx and employees_crm_username_unique_idx are UNIQUE across ALL
// employees regardless of employment_status, and employee-import-existing-state.ts builds its
// crm_id -> hr_id map with NO active-only filter (unlike the org-seat map 15 lines below it in
// the same loop). A leaver who kept their CRM identity therefore blocked their own successor's
// master import with "CRM ID 1399 is already assigned to HR_ID B-97" — hit live 2026-08-05 with
// 30 leavers holding one. Both routes into a terminal state must release it.

export function runResignationClearsCrmIdentityTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");

  // (a) The TypeScript fallback path nulls both columns in the payload it writes.
  assert.match(
    service,
    /function updateEmployeeLifecycleFallback[\s\S]{0,2600}?crm_id: null,\s*\n\s*crm_username: null,/,
    "updateEmployeeLifecycleFallback must null crm_id and crm_username so a leaver releases their CRM identity",
  );

  // (b) Both columns are also declared optional, so an environment missing either column still
  // completes the lifecycle update via the existing drop-and-retry loop rather than hard-failing.
  assert.match(
    service,
    /const optionalColumns = \[[\s\S]{0,400}?"crm_id",\s*\n\s*"crm_username",\s*\n\s*\]/,
    "crm_id and crm_username must be listed in optionalColumns for the missing-column retry path",
  );

  // (c) The RPC — the path the Employees page actually takes — clears them inside its own
  // transaction. Without this the SQL route would silently keep the old behaviour.
  const migration = readFileSync(
    "supabase/migrations/20260805050000_resignation_clears_crm_identity.sql",
    "utf8",
  );

  assert.match(
    migration,
    /create or replace function public\.phx_resign_employee_and_open_vacancy/,
    "the migration must replace the resignation RPC",
  );
  assert.match(
    migration,
    /update public\.employees set[\s\S]{0,600}?crm_id = null,\s*\n\s*crm_username = null,/,
    "the RPC's employee lifecycle update must clear crm_id and crm_username",
  );

  // (d) The rest of the RPC must survive the rewrite — a create-or-replace that dropped a step
  // would silently regress seat vacating or the resignation insert.
  for (const [fragment, description] of [
    ["insert into public.position_vacancies", "step 1 opens the replacement vacancy"],
    ["insert into public.employee_resignations", "step 2 records the resignation"],
    ["update public.app_auth_users set is_active = false", "step 4 deactivates app access"],
    ["au.resign_occupant", "step 5 vacates every au seat"],
  ] as const) {
    assert.ok(
      migration.includes(fragment),
      `the replaced RPC must keep ${description}`,
    );
  }
}
