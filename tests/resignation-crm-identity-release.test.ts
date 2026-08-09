import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-text regression guard, matching this repo's idiom for DB-touching resignation code.
//
// Resignation must release EXACTLY ONE half of the leaver's CRM identity.
//
// RELEASE crm_id. employees_crm_id_unique_idx is UNIQUE across ALL employees regardless of
// employment_status, and employee-import-existing-state.ts builds its crm_id -> hr_id map with NO
// active-only filter (unlike the org-seat map 15 lines below it in the same loop). A leaver who
// kept it blocked their own successor's master import with "CRM ID 1399 is already assigned to
// HR_ID B-97" — hit live 2026-08-05 with 30 leavers holding one. Both routes into a terminal state
// must release it.
//
// KEEP crm_username. Clearing it too silently destroyed visit attribution. The CRM sync stamps
// ireports360_visits.agent_hr_id ONCE, at sync time, via override -> crm_id -> crm_username, and
// the mirror runs a day or more behind the visit date — so nulling both automatic tiers on
// resignation day turned every not-yet-synced visit into a permanent NULL, including visits the
// person performed while still employed. Measured on production 2026-08-09: all 56 departed
// employees had crm_username NULL, stranding 587 visits dated on or before their own last working
// day (B-111 lost 36, B-176 lost 21 — both still carrying their own CRM label on the row). It also
// made isAttributableOn()'s escape hatch unreachable: that guard allows a post-exit row only when
// the record carries the employee's own CRM label, and the label it compares against IS
// crm_username.

const MIGRATION = "supabase/migrations/20260809140000_resignation_keeps_crm_username.sql";

export function runResignationCrmIdentityReleaseTests() {
  const service = readFileSync("src/lib/resignations/service.ts", "utf8");
  const fallback = service.slice(service.indexOf("function updateEmployeeLifecycleFallback"));
  const fallbackBody = fallback.slice(0, fallback.indexOf("for (let attempt"));

  // (a) The TypeScript fallback path still releases the slot.
  assert.match(
    fallbackBody,
    /crm_id: null,/,
    "updateEmployeeLifecycleFallback must null crm_id so a leaver releases the CRM slot for their successor",
  );

  // (b) …and must NOT null the username. This is the assertion the whole change exists for.
  assert.ok(
    !/crm_username:\s*null/.test(fallbackBody),
    "updateEmployeeLifecycleFallback must NOT null crm_username — that is what stranded 587 visits",
  );

  // (c) optionalColumns lists what the payload actually sends. A stale crm_username entry there
  // would imply the payload still writes it. Scoped to THIS function's own declaration — the
  // service has a second, unrelated optionalColumns for the resignation-record insert.
  const optional = fallbackBody.slice(fallbackBody.indexOf("const optionalColumns = ["));
  const optionalList = optional.slice(0, optional.indexOf("]"));
  assert.match(optionalList, /"crm_id",/, "crm_id stays in optionalColumns for the missing-column retry path");
  assert.ok(
    !/"crm_username"/.test(optionalList),
    "crm_username must not be listed as an optional payload column once the payload stops sending it",
  );

  // (d) The RPC — the path the Employees page actually takes — must match. Without this the SQL
  // route silently keeps the old behaviour and the TypeScript change is cosmetic.
  const migration = readFileSync(MIGRATION, "utf8");
  assert.match(
    migration,
    /create or replace function public\.phx_resign_employee_and_open_vacancy/,
    "the migration must replace the resignation RPC",
  );
  const employeeUpdate = migration.slice(migration.indexOf("update public.employees set"));
  const employeeUpdateBody = employeeUpdate.slice(0, employeeUpdate.indexOf("where hr_id"));
  assert.match(
    employeeUpdateBody,
    /crm_id = null,/,
    "the RPC's employee lifecycle update must still clear crm_id",
  );
  assert.ok(
    !/crm_username\s*=\s*null/.test(employeeUpdateBody),
    "the RPC must NOT clear crm_username — the SQL path is the one the Employees page takes",
  );

  // (e) The rest of the RPC must survive the rewrite — a create-or-replace that dropped a step
  // would silently regress seat vacating or the resignation insert.
  for (const [fragment, description] of [
    ["insert into public.position_vacancies", "step 1 opens the replacement vacancy"],
    ["insert into public.employee_resignations", "step 2 records the resignation"],
    ["update public.app_auth_users set is_active = false", "step 4 deactivates app access"],
    ["au.resign_occupant", "step 5 vacates every au seat"],
  ] as const) {
    assert.ok(migration.includes(fragment), `the replaced RPC must keep ${description}`);
  }

  // (f) SECURITY DEFINER + an empty search_path are load-bearing on a function that rewrites
  // employment status; a create-or-replace that dropped either would widen its blast radius.
  assert.match(migration, /security definer/i, "the RPC stays SECURITY DEFINER");
  assert.match(migration, /set search_path to ''/i, "the RPC keeps its empty search_path");
  assert.match(
    migration,
    /revoke execute on function public\.phx_resign_employee_and_open_vacancy\([^)]*\) from public, anon, authenticated;[\s\S]*grant execute on function public\.phx_resign_employee_and_open_vacancy\([^)]*\) to service_role;/,
    "EXECUTE is revoked from PUBLIC (anon/authenticated inherit through it) and re-granted to service_role AFTER the revoke",
  );
}
