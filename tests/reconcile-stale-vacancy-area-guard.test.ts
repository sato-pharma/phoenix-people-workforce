import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";

// Regression guard for the cross-area double-seat bug (confirmed in prod 2026-08-01).
//
// phx_reconcile_stale_replacement_vacancies() runs on every employee insert and scans all
// open replacement vacancies. It used to match a "replacement" on manager + line + job_title
// ONLY, so a hire explicitly assigned area X could be recorded as the replacement for a
// resigned predecessor in a DIFFERENT area Y — closing area Y's vacancy and binding the hire
// to the wrong seat while employees.area_id stayed X. One hire then filled two vacancies
// (incident: AI-0005 recorded in both vacancy 1 / Cairo West and vacancy 300 / Nasr City).
//
// The fix migration adds two guards to the candidate selection:
//   (1) area guard      — the candidate's area must match the vacancy's own area;
//   (2) single-seat     — never pick someone already recorded filling another vacancy.
//
// This is a source-text guard (the same style as position-vacancy-status-integrity.test.ts):
// the real behavioural proof is a staging reproduction, but this fails fast in CI if either
// guard is ever removed or the function is rewritten without them. The sibling
// phx_autofill_replacement_vacancy_from_employee_insert() and app-side closeVacancyOnHire()
// were already area-safe and are NOT the fix site; we assert the app path stays area-scoped.

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runReconcileStaleVacancyAreaGuardTests() {
  const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
  const migrationFile = readdirSync(migrationsDir).find((file) =>
    /^20260801150000_/.test(file),
  );
  assert.ok(
    migrationFile,
    "expected the 20260801150000 reconciliation area/single-seat fix migration to exist",
  );

  const sql = readFileSync(new URL(migrationFile!, migrationsDir), "utf8");

  // ── The migration replaces the reconciliation function in place ──────────────────
  assert.match(
    sql,
    /create\s+or\s+replace\s+function\s+public\.phx_reconcile_stale_replacement_vacancies/i,
    "migration must CREATE OR REPLACE phx_reconcile_stale_replacement_vacancies",
  );

  // ── (1) Area guard — HEADLINE assertion ──────────────────────────────────────────
  // The vacancy's area must be pulled into the loop and the candidate constrained to it.
  assert.match(
    sql,
    /v\.area_id\s+as\s+vacancy_area_id/i,
    "reconciliation loop must select the vacancy's area (v.area_id as vacancy_area_id)",
  );
  assert.match(
    sql,
    /a\.area_id\s+is\s+not\s+distinct\s+from\s+r\.vacancy_area_id/i,
    "candidate replacement must be constrained to the vacancy's own area — this is the guard " +
      "that stops a hire in area X from closing a replacement vacancy in area Y",
  );

  // ── (2) Single-seat guard ────────────────────────────────────────────────────────
  assert.match(
    sql,
    /not\s+exists\s*\([\s\S]*?pv2\.filled_by_hr_id\s*=\s*a\.hr_id[\s\S]*?pv2\.id\s*<>\s*r\.vacancy_id[\s\S]*?\)/i,
    "candidate must not already fill another vacancy (single-seat guard) so a hire closes " +
      "at most one seat",
  );

  // ── The rest of the function's contract is preserved ─────────────────────────────
  assert.match(
    sql,
    /Auto-closed by stale-replacement-vacancy reconciliation: seat for/,
    "the reconciliation note must be preserved so closures stay auditable",
  );
  assert.match(
    sql,
    /jsonb_build_object\(\s*'checked'/i,
    "the function must still return its {checked, closed} summary",
  );

  // ── App path stays area-scoped (closeVacancyOnHire was never the cause) ───────────
  const vacancyCloser = source("src/lib/employees/vacancy-closer.ts");
  assert.match(
    vacancyCloser,
    /area_id:\s*`eq\.\$\{input\.area_id\}`/,
    "closeVacancyOnHire's derived match must keep filtering position_vacancies by area_id",
  );
}
