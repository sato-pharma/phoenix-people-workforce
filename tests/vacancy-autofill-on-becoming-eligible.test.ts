import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * A hire that is created incomplete and completed a moment later must still close its vacancy.
 *
 * phx_employee_insert_autofill_replacement_vacancy is an AFTER INSERT trigger whose guards return
 * silently when the row is not yet an eligible hire. Nothing re-offered such a row to the matcher
 * once it was completed, so its vacancy stayed open indefinitely -- and every open line_id = 4
 * vacancy is drawn by organogram-head-office.ts as its own "Vacant" box, so the new hire appeared
 * on the organogram twice: once as herself, once as the seat she already occupied.
 *
 * Production, 2026-08-29: vacancies 352 and 354 were an exact tier-1 match for the two hires that
 * filled them and never closed. audit_logs held no hire_vacancy_unmatched row for either, which is
 * only possible if the engine bailed at a guard and never reached its matching step.
 *
 * These assertions pin the SHAPE of the fix rather than a byte window, so they survive the file
 * being reformatted or extended (see AGENTS.md 2.1 -- source-pinning tests that slice a fixed byte
 * range false-fail the moment the file shifts).
 */
export function runVacancyAutofillOnBecomingEligibleTests() {
  const migration = readFileSync(
    "supabase/migrations/20260829160000_autofill_vacancy_when_a_hire_becomes_eligible.sql",
    "utf8",
  );

  // ── The second look exists, and is scoped to the columns eligibility depends on ────────────────
  assert.match(
    migration,
    /create trigger phx_employee_update_autofill_replacement_vacancy\s+after update of ([^\n]+)\s+on public\.employees/i,
    "an AFTER UPDATE trigger must re-offer a completed hire to the matcher",
  );
  const triggerColumns =
    migration.match(/after update of ([^\n]+)\n\s*on public\.employees/i)?.[1] ?? "";
  for (const column of [
    "employment_status",
    "payroll_eligible",
    "organogram_visible",
    "manager_hr_id",
    "area_id",
    "line_id",
    "position_id",
  ]) {
    assert.ok(
      triggerColumns.includes(column),
      `${column} decides eligibility, so the update trigger must watch it`,
    );
  }

  // ── The safety property: an ordinary edit must NOT re-enter the matcher ────────────────────────
  // Without this guard a retitle or a transfer of an already-active employee would be offered to
  // the matcher and could close some unrelated open vacancy. Only a row crossing INTO eligibility
  // is in scope.
  assert.match(
    migration,
    /if public\.phx_employee_is_vacancy_autofill_eligible\(old\) then\s+return new;/i,
    "a row that was ALREADY eligible before the edit must return without matching",
  );
  assert.match(
    migration,
    /if not public\.phx_employee_is_vacancy_autofill_eligible\(new\) then\s+return new;/i,
    "a row that is still ineligible after the edit must return without matching",
  );

  // ── One hire may never consume two vacancies ───────────────────────────────────────────────────
  assert.match(
    migration,
    /where v\.filled_by_hr_id = new\.hr_id[\s\S]{0,120}?'filled'[\s\S]{0,80}?return new;/i,
    "a hire who already owns a filled vacancy must be skipped outright",
  );

  // ── Tier 1 stays exact: an ambiguous footprint is logged, never guessed ────────────────────────
  assert.ok(
    (migration.match(/if v_match_count = 1 then/g) ?? []).length === 3,
    "all three tiers must still require EXACTLY ONE candidate before filling",
  );
  assert.match(
    migration,
    /'hire_vacancy_unmatched'/,
    "the unmatched-hire audit row must survive the move into the shared function",
  );

  // ── The insert path is unchanged, just delegating ──────────────────────────────────────────────
  assert.match(
    migration,
    /function public\.phx_autofill_replacement_vacancy_from_employee_insert\(\)[\s\S]*?perform public\.phx_autofill_replacement_vacancy_for_employee\(new\);/i,
    "the insert trigger must delegate to the shared body rather than keep a divergent copy",
  );

  // ── Every new SECURITY DEFINER function is revoked from anon/authenticated ─────────────────────
  // A public function inherits EXECUTE to PUBLIC, and anon/authenticated inherit it through PUBLIC.
  // A SECURITY DEFINER function that writes position_vacancies must never be reachable that way.
  // Derived from the migration rather than hard-coded, so a function added later is covered too.
  const declaredFunctions = Array.from(
    migration.matchAll(/create or replace function (public\.[a-z0-9_]+)\s*\(([^)]*)\)/gi),
  ).map((match) => ({ name: match[1], args: match[2].trim() }));
  assert.ok(declaredFunctions.length >= 4, "the migration must declare the four functions it documents");
  for (const fn of declaredFunctions) {
    const signature = fn.args.includes("public.employees") ? `${fn.name}(public.employees)` : `${fn.name}()`;
    const escaped = signature.replace(/[.()]/g, (character) => `\\${character}`);
    assert.match(
      migration,
      new RegExp(`revoke execute on function ${escaped} from public, anon, authenticated;`, "i"),
      `${signature} is SECURITY DEFINER or reachable from one -- it must be revoked from public, anon, authenticated`,
    );
    assert.match(
      migration,
      new RegExp(`grant execute on function ${escaped} to service_role;`, "i"),
      `${signature} must be re-granted to service_role (revoking PUBLIC strips it too)`,
    );
  }
}
