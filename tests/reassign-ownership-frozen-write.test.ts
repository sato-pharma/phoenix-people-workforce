import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * `phx_reassign_replacement_ownership` must never write the frozen `sales_records` table.
 *
 * The Rule #1 freeze revoked service_role's INSERT/UPDATE/DELETE on `sales_records`, but this
 * function is SECURITY DEFINER and owned by `postgres` — its body runs with the owner's rights, so
 * the revoke never applies to it. It is the live path: the TypeScript cascade in
 * `reassignLiveManagerOwnership` calls this RPC first and returns on success, so the PATCH fallback
 * PR #2135 cleaned up is only reached when the function is MISSING.
 *
 * Source-text assertions against the migration, because the invariant IS the shipped function body —
 * there is no TypeScript surface that can express "this SQL does not contain that UPDATE".
 */
export function runReassignOwnershipFrozenWriteTests() {
  const migration = readFileSync(
    "supabase/migrations/20260814190000_reassign_ownership_stop_writing_frozen_sales_records.sql",
    "utf8",
  );

  // Only the function body counts. The file's header documents the removed UPDATE verbatim, and the
  // trailing guard block matches on the same words — asserting over the whole file would test the
  // commentary about the fix rather than the fix.
  const bodyStart = migration.indexOf("as $function$");
  const bodyEnd = migration.indexOf("$function$;");
  assert.ok(
    bodyStart !== -1 && bodyEnd > bodyStart,
    "could not locate the function body — the migration must define phx_reassign_replacement_ownership between `as $function$` and `$function$;`",
  );
  const body = migration
    .slice(bodyStart, bodyEnd)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  // HEADLINE INVARIANT. p_effective_date is sourced from employee_resignations.effective_date for
  // the person being replaced, and that date is routinely in the past — production holds 20
  // resignations dated inside H1 2026. A date corrected backwards, followed by a replacement hire,
  // would rewrite manager_hr_id across settled H1 rows: 880 of them, 6,436,342.01 EGP of target
  // value, across four resigned managers. Sales attribution now resolves the manager per period
  // from the seat model in SoS Monthly Closing, so there is nothing here left to keep in sync.
  assert.equal(
    /(update|insert\s+into|delete\s+from)\s+(public\.)?sales_records\b/i.test(body),
    false,
    "phx_reassign_replacement_ownership must not write sales_records — SECURITY DEFINER runs as the owner, so the Rule #1 revoke does not stop it, and the rows are the only record of what H1 2026 was paid on",
  );

  // Gutting the function would satisfy the assertion above while breaking the feature. These are the
  // reassignments that must survive the removal — none of their tables are frozen.
  for (const table of ["employees", "position_vacancies"]) {
    assert.match(
      body,
      new RegExp(`update\\s+public\\.${table}\\b`, "i"),
      `phx_reassign_replacement_ownership must still reassign ${table} — only the frozen-table write is being removed`,
    );
  }
  assert.match(
    body,
    /update public\.app_auth_users u/,
    "the app_auth_users reassignment must survive — without it a replaced manager keeps the old login's reporting line",
  );

  // Reported as null, matching how sales_targets already reports, so a caller reading the result can
  // tell "not attempted" from "attempted, matched nothing".
  assert.match(
    body,
    /jsonb_build_object\('sales_records_reassigned', null\)/,
    "the result payload must still carry sales_records_reassigned as null, so callers can distinguish a deliberate no-op from a silent drop",
  );

  // SECURITY DEFINER is not the bug and must not be "fixed" away — the function legitimately needs
  // owner rights for the tables it does update.
  assert.match(
    migration,
    /security definer/i,
    "SECURITY DEFINER must be retained; the frozen-table write was the defect, not the privilege model",
  );

  // On production CREATE OR REPLACE preserves the existing ACL, so these are no-ops there. They
  // matter on replay: against a database where the function does not exist the statement is a
  // CREATE, and a new function carries the default EXECUTE-to-PUBLIC. anon and authenticated are
  // members of PUBLIC, so this function — which reassigns org ownership — would be callable with
  // the anonymous key. Revoking PUBLIC on a default ACL also strips service_role, hence the regrant.
  assert.match(
    migration,
    /revoke execute on function public\.phx_reassign_replacement_ownership\(text, text, date\)\s*\n?\s*from public, anon, authenticated;/i,
    "the migration must revoke EXECUTE from PUBLIC — revoking only anon/authenticated is a no-op, since both inherit EXECUTE through PUBLIC membership",
  );
  assert.match(
    migration,
    /grant execute on function public\.phx_reassign_replacement_ownership\(text, text, date\)\s*\n?\s*to service_role;/i,
    "service_role's EXECUTE must be re-granted after the revoke — the application calls this through PostgREST and would 404 without it",
  );

  // A replace that silently does not land, or lands still carrying the write, must fail the apply.
  assert.match(
    migration,
    /raise exception\s*\n?\s*'phx_reassign_replacement_ownership still writes sales_records/i,
    "the migration must end with a guard that raises if the shipped function still writes sales_records — an apply that quietly did nothing must not look like success",
  );
}
