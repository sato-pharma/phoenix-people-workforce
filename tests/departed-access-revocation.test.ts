/**
 * A departure revokes access on the LAST WORKING DAY, not the day the exit is filed.
 *
 * The decision itself — isEmploymentAccessRevoked — is unit-tested in auth-session.test.ts against
 * the A-16 and PD-0006 cases. This file pins the three places that decision has to actually be
 * WIRED, because each one silently reverts to the old behaviour if it is dropped:
 *
 *   1. The resignation RPC (migration 20260903181500), which is what a normal exit runs.
 *   2. src/lib/resignations/service.ts, the JS fallback and approvals-hub paths.
 *   3. The daily catch-up that performs the revocation once the day arrives.
 *
 * Dropping (1) or (2) locks people out early again — the bug that cost A-16 nine failed logins, a
 * manual re-activation by HR, two password resets and a password setup in four minutes on
 * 2026-08-30. Dropping (3) leaves every leaver's login flag permanently stale instead.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export async function runDepartedAccessRevocationTests() {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260903181500_departure_revokes_login_on_the_last_working_day.sql",
      import.meta.url,
    ),
    "utf8",
  );

  // ===========================================================================
  // 1. The resignation RPC defers the revocation.
  // ===========================================================================

  // The two access flips must sit INSIDE a date guard. Pinned as the whole block, because an
  // `if` that happens to appear somewhere else in the function would satisfy a looser check while
  // the flips stayed unconditional.
  assert.match(
    migration,
    /if p_effective_date is null or p_effective_date <= \(now\(\) at time zone 'Africa\/Cairo'\)::date then\s*\n\s*update public\.app_auth_users set is_active = false[\s\S]{0,200}?\n\s*update public\.user_access_profiles set is_active = false[\s\S]{0,200}?\n\s*end if;/,
    "the resignation RPC must revoke the login only once the last working day has arrived",
  );

  // A null effective date must still revoke at once — no date means no grace, the same rule the
  // application gate applies. Written as `is null or <= today`, never as `<= today` alone, which
  // would silently GRANT access on a missing date.
  assert.match(
    migration,
    /if p_effective_date is null or p_effective_date <=/,
    "a missing effective date must revoke immediately, not grant an unbounded grace",
  );

  // The Cairo day, not the server's. A UTC date here would revoke up to three hours early.
  assert.match(
    migration,
    /\(now\(\) at time zone 'Africa\/Cairo'\)::date/,
    "the RPC must compare against the Cairo calendar day",
  );

  // ===========================================================================
  // 2. The catch-up function exists, is callable, and cannot reach anyone still employed.
  // ===========================================================================
  assert.match(
    migration,
    /create or replace function public\.phx_revoke_departed_employee_access\(\)/,
    "the catch-up must be defined as a callable function, not an inline one-off UPDATE",
  );
  assert.match(
    migration,
    /grant execute on function public\.phx_revoke_departed_employee_access\(\) to service_role;/,
    "the catch-up must be granted to service_role or the cron cannot call it",
  );

  // A grant to service_role is NOT a lock-down, and reading it as one is the trap. A function
  // created in `public` inherits PostgreSQL's default EXECUTE grant to PUBLIC, and anon and
  // authenticated are MEMBERS of PUBLIC — so without this revoke the anonymous key could call a
  // function that switches off employee logins. Revoking anon and authenticated alone is a no-op.
  // CI's own check-migrations caught exactly this on this file; pinned here as well.
  assert.match(
    migration,
    /revoke execute on function public\.phx_revoke_departed_employee_access\(\) from public, anon, authenticated;/,
    "the catch-up must have EXECUTE revoked from PUBLIC, not merely granted to service_role",
  );
  // The revoke has to come FIRST: stripping PUBLIC from a default ACL also strips service_role,
  // so the grant is what puts it back. In the other order the cron loses its own access.
  assert.equal(
    migration.indexOf("revoke execute on function public.phx_revoke_departed_employee_access()") <
      migration.indexOf("grant execute on function public.phx_revoke_departed_employee_access()"),
    true,
    "the revoke must precede the grant, or revoking PUBLIC strips service_role again",
  );

  // BOTH conditions are required. A departed status alone would revoke someone serving notice —
  // precisely the bug this whole change removes — and a past date alone would revoke an active
  // employee who happens to carry an old last_working_date.
  const revokeBody = migration.slice(
    migration.indexOf("create or replace function public.phx_revoke_departed_employee_access()"),
  );
  assert.match(
    revokeBody,
    /in \('resigned', 'terminated', 'not_renewed'\)/,
    "the catch-up must only reach the three departed statuses",
  );
  assert.match(
    revokeBody,
    /e\.last_working_date is not null\s*\n\s*and e\.last_working_date <= \(now\(\) at time zone 'Africa\/Cairo'\)::date/,
    "the catch-up must require a last working day that has actually passed",
  );
  assert.equal(
    (revokeBody.match(/and e\.last_working_date <= \(now\(\) at time zone 'Africa\/Cairo'\)::date/g) ?? []).length,
    2,
    "both the login and the access-profile update must carry the date condition, not just the first",
  );

  // HR ids are mixed case in this database, so an unlowered join silently under-matches. Four
  // sides: employees + app_auth_users, employees + user_access_profiles.
  assert.equal(
    (revokeBody.match(/lower\(btrim\(/g) ?? []).length >= 6,
    true,
    "both sides of both joins must be lowered and trimmed — HR ids are mixed case",
  );

  // ===========================================================================
  // 3. The service defers it too, on both paths.
  // ===========================================================================
  const service = readFileSync(new URL("../src/lib/resignations/service.ts", import.meta.url), "utf8");

  assert.match(
    service,
    /import \{[^}]*\bisEmploymentAccessRevoked\b[^}]*\} from "@\/lib\/auth\/session-lifecycle";/,
    "the resignation service must reuse the shared rule rather than re-deriving the date comparison",
  );
  assert.match(
    service,
    /async function deactivateEmployeeAccessIfSupported\(\s*supabase: SupabaseClient,\s*employeeHrId: string,\s*departure: \{ effectiveDate: string \| null; employeeStatus: string \| null \},/,
    "the revocation helper must take the departure it is deciding about",
  );

  // The access flips must be behind the rule. Pinned by position: the helper's `is_active: false`
  // writes have to come after the guard, inside it.
  const helperBody = service.slice(
    service.indexOf("async function deactivateEmployeeAccessIfSupported("),
    service.indexOf("async function deactivateEmployeeAccessIfSupported(") + 2600,
  );
  const guardAt = helperBody.indexOf("const revoked = isEmploymentAccessRevoked({");
  const firstFlipAt = helperBody.indexOf("is_active: false");
  assert.equal(guardAt > -1, true, "the helper must consult isEmploymentAccessRevoked");
  assert.equal(
    firstFlipAt > guardAt,
    true,
    "the access flips must happen after the dated guard, not before it",
  );
  assert.match(
    helperBody,
    /if \(revoked\) \{/,
    "the access flips must be conditional on the departure having taken effect",
  );

  // The mailbox task is deliberately NOT dated — it is a work item for the offboarding desk, and
  // opening it early is what lets the desk prepare. It must sit outside the guard.
  const openTaskAt = helperBody.indexOf("await openMailboxRevocationTaskBestEffort(employeeHrId);");
  const guardCloseAt = helperBody.lastIndexOf("  }\n\n  await openMailboxRevocationTaskBestEffort");
  assert.equal(openTaskAt > -1, true, "the helper must still open the mailbox revocation task");
  assert.equal(
    guardCloseAt > -1,
    true,
    "the mailbox revocation task must be opened whichever side of the last working day we are on",
  );

  // Both callers must hand over the departure. A caller that forgets would not compile, but the
  // shape is pinned so a later refactor cannot quietly default it to null and restore the old
  // always-revoke behaviour.
  assert.match(
    service,
    /await deactivateEmployeeAccessIfSupported\(supabase, input\.employee\.hrId, \{\s*effectiveDate: input\.effectiveDate,\s*employeeStatus: input\.employeeStatus,\s*\}\);/,
    "the JS fallback path must pass the effective date and status",
  );
  assert.match(
    service,
    /await deactivateEmployeeAccessIfSupported\(supabase, record\.employeeHrId, \{\s*effectiveDate: record\.effectiveDate,\s*employeeStatus: normalizeEmployeeExitStatus\(storedExitStatus\),\s*\}\);/,
    "the approvals-hub completion path must pass the effective date and status",
  );

  // The RPC path disables Telegram outside the RPC, and that is the same revocation, so it takes
  // the same date. Cutting a leaver's notifications days early is the same bug in another channel.
  assert.match(
    service,
    /if \(\s*isEmploymentAccessRevoked\(\{[\s\S]{0,220}?\}\)\s*\) \{\s*await disableTelegramForIdentity\(\{/,
    "the RPC path's Telegram deactivation must be dated the same way",
  );

  // ===========================================================================
  // 4. The catch-up is actually scheduled.
  // ===========================================================================
  const sweep = readFileSync(new URL("../src/lib/auth/departed-access-sweep.ts", import.meta.url), "utf8");
  assert.match(
    sweep,
    /\.rpc\("phx_revoke_departed_employee_access"\)/,
    "the sweep must call the migration's function — the name is the contract between them",
  );
  // It must never throw: it shares a cron endpoint with the mailbox sweep and must not take that
  // down, nor turn a dead-man's switch red that answers a different question.
  assert.match(sweep, /catch \(error\) \{/, "the sweep must swallow its own failure");

  // The revocation is not finished by SQL alone. Because the resignation flow no longer disables a
  // leaver's Telegram at filing time, the sweep has to do it when the day arrives — otherwise an
  // ex-employee keeps receiving company notifications indefinitely, which is a worse bug than the
  // early lockout this change removes. That is why the function returns ids, not just counts.
  assert.match(
    migration,
    /'revoked_hr_ids', to_jsonb\(v_revoked\)/,
    "the catch-up must return WHO it revoked, or the caller cannot finish the job",
  );
  assert.match(
    migration,
    /returning a\.hr_id/,
    "the login update must return the rows it changed, so only the just-revoked are chased",
  );
  assert.match(
    sweep,
    /await disableTelegramForIdentity\(\{/,
    "the sweep must disable Telegram for the leavers it just revoked",
  );
  assert.match(
    sweep,
    /for \(const hrId of revoked\) \{/,
    "Telegram must be disabled for exactly the ids just revoked, not for every departed employee",
  );
  assert.match(
    sweep,
    /telegramDisabled: 0, errors: 1/,
    "a total failure must report zero Telegram disables rather than claiming work it did not do",
  );
  assert.match(
    sweep,
    /return \{ loginsRevoked: 0, accessProfilesRevoked: 0, telegramDisabled: 0, errors: 1 \};/,
    "a failed sweep must report an error count rather than throwing",
  );

  const cronRoute = readFileSync(
    new URL("../app/api/cron/mailbox-offboarding-sweep/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    cronRoute,
    /import \{ runDepartedAccessSweep \} from "@\/lib\/auth\/departed-access-sweep";/,
    "the daily leaver cron must import the sweep",
  );
  assert.match(
    cronRoute,
    /const access = await runDepartedAccessSweep\(\);/,
    "the daily leaver cron must actually run the sweep — an unreferenced module is a sweep that never fires",
  );
  assert.match(
    cronRoute,
    /departedAccess: access/,
    "the run must report what it revoked, so a silent no-op is visible in the cron response",
  );
}
