// A manual HR entry claims no day, in the database guard as well as in the app.
//
// WHY THIS EXISTS, MEASURED ON PRODUCTION 2026-10-07. A manual entry has no real
// day: HR types an amount and a reason, and `connectors/manual.ts` stamps the
// candidate with the placeholder `${monthKey}-01`. The app's own collision check
// (`findDayCollisions`, `conflict.ts`) has always skipped `manual_hr` for that
// reason. The database trigger `deductions_publication_lines_guard_day_overlap`
// did not — so the SECOND manual entry pushed for an employee in a month was
// refused as a double deduction of the 1st. Ahmed Nabil held 7 approved manual
// entries for September, all dated 2026-09-01, and only one could ever be pushed.
//
// Both halves must hold: the trigger exempts a manual line BOTH ways (it neither
// claims a day nor is blocked by one), and every other line is still guarded —
// the guard exists to stop the 2026-07 class of one absence deducted once per
// pipeline.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const MIGRATION = "supabase/migrations/20261007100301_deductions_day_overlap_guard_skips_manual_entries.sql";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

export function runDeductionsManualDayGuardTests(): void {
  const sql = stripSqlComments(readFileSync(MIGRATION, "utf8"));

  // ── 1. The new line is exempt from claiming ───────────────────────────────
  assert.match(
    sql,
    /if exists \(\s*select 1 from public\.deductions_candidates c\s*where c\.id = new\.candidate_id and c\.source_system = 'manual_hr'\s*\) then\s*return new;/,
    "A line whose candidate is a manual HR entry must return before the collision search. Its date " +
      "is a month placeholder, so without this the second manual entry of a month is refused as a " +
      "double deduction of the 1st — the 2026-10-07 defect that left 6 of Ahmed Nabil's 7 approved " +
      "manual entries unpushable.",
  );

  // ── 2. An existing manual line blocks nothing ────────────────────────────
  assert.match(sql, /left join public\.deductions_candidates c on c\.id = l\.candidate_id/);
  assert.match(
    sql,
    /and coalesce\(c\.source_system, ''\) <> 'manual_hr'/,
    "An already-pushed manual line must not block a real day either — its 1st-of-month placeholder " +
      "would otherwise refuse a genuine absence on the 1st.",
  );

  // ── 3. Everything else is still guarded, exactly as before ────────────────
  for (const kept of [
    /if new\.line_status <> 'active' then\s*return new;/,
    /and l\.line_status = 'active'/,
    /and p\.status = 'published'/,
    /and l\.employee_hr_id_compact = new\.employee_hr_id_compact/,
    /and d\.day in \(select jsonb_array_elements_text\(new\.dates\)\)/,
    /using errcode = 'unique_violation'/,
    /set search_path = public, pg_temp/,
  ]) {
    assert.match(
      sql,
      kept,
      `The guard must keep ${kept} — it is what stops one absence being deducted once per pipeline.`,
    );
  }

  // ── 4. The app-side twin still skips manual entries ───────────────────────
  // If conflict.ts ever starts treating manual dates as real days, this trigger
  // and the app disagree again — change both together.
  const conflict = readFileSync("src/lib/deductions/conflict.ts", "utf8");
  assert.match(conflict, /MANUAL_ENTRY_SOURCE_SYSTEM = "manual_hr"/);
  const manual = readFileSync("src/lib/deductions/connectors/manual.ts", "utf8");
  assert.match(
    manual,
    /const anchorDate = `\$\{monthKey\}-01`;/,
    "Manual entries must still carry the 1st-of-month placeholder this guard exempts. If they ever " +
      "carry real days, revisit the exemption — real days should be guarded.",
  );
}
