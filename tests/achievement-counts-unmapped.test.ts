import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Every sale counts, including the ones the attribution engine could not place.
//
// au.f_monthly_achievement gathered actuals with
//     where a.channel in ('indirect', 'direct')
// which discarded the third channel, 'unmapped' — real invoiced sales with no area. Monthly
// Closing counts them, achievement did not, so the two screens quoted different totals for the
// same month. Measured on production for 2026-07:
//
//     cns          8,066,152.47 closing   7,925,997.58 achievement   140,154.89 dropped
//     pedia        1,996,470.65           1,990,780.40                 5,690.25
//     anti_inf       612,194.05             606,909.25                 5,284.80
//     (no line)          462.00                     —                    462.00
//                                                            total   151,591.94 EGP
//
// Owner ruling 2026-08-12: include them, matching the closing. Achievement % is unaffected —
// an unplaced row has no target beside it, so it lands in the uncovered bucket and never
// enters the numerator. Re-running the rewritten body against production reconciled every
// line to the closing at 0.00 variance with all three achievement percentages unmoved.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runAchievementCountsUnmappedTests() {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes("au_achievement_counts_unmapped_sales"));
  assert.ok(file, "the unmapped-in-achievement migration must exist");
  const sql = code(readFileSync(join(MIGRATIONS, file), "utf8"));
  const fn = sql.slice(sql.indexOf("create or replace function au.f_monthly_achievement"));

  // ── The channel filter must be gone, in every spelling ──────────────────────
  assert.ok(
    !/where\s+a\.channel/.test(fn),
    "no channel predicate may survive: filtering the attribution engine's output is how 151,591.94 EGP left the report",
  );
  assert.match(
    fn,
    /from au\.f_monthly_attribution\(p_period\) a\s*\)/,
    "actuals must read the attribution engine whole, with nothing filtered out on the way in",
  );

  // ── The rejoin must be NULL-safe on line_code, or the newly admitted rows zero out ──
  // 10 of them carry no line at all (462.00 EGP). `ac.line_code = k.line_code` is never true
  // for two NULLs, so those keys would come back through `keys` and join to nothing — a
  // confident zero in place of a real sale. Same trap the area_code joins were fixed for.
  assert.match(
    fn,
    /left join actuals ac[\s\S]{0,200}ac\.line_code is not distinct from k\.line_code/,
    "the actuals rejoin must be NULL-safe on line_code, or a line-less sale reports as zero",
  );
  assert.match(
    fn,
    /left join tgt tg[\s\S]{0,200}tg\.line_code is not distinct from k\.line_code/,
    "the target rejoin must be NULL-safe on line_code too",
  );

  // ── has_actual must not be read off a nullable key column ───────────────────
  assert.ok(
    !/\(ac\.line_code is not null\)/.test(fn),
    "has_actual read off ac.line_code reports a real line-less sale as 'no actual'",
  );
  assert.match(fn, /coalesce\(ac\.matched, false\)/, "has_actual must come from a marker that exists whenever the row does");

  // ── The seat join stays strict on purpose ───────────────────────────────────
  // An unplaced row matches no seat and is credited to no rep. That is correct: crediting
  // unattributable sales to a named person is worse than leaving them at line level.
  assert.match(
    fn,
    /left join lam_asof lam\s*on lam\.line_code = k\.line_code\s*and lam\.area_code = k\.area_code/,
    "the seat join must stay a plain = on area, so an unplaced row reaches no rep",
  );

  // ── CREATE OR REPLACE drops SET clauses; all three must be re-declared ──────
  assert.match(fn, /security definer/i, "SECURITY DEFINER must be re-declared — the live function has it");
  assert.match(fn, /set search_path to 'au', 'public'/i, "search_path must be re-declared verbatim");
  assert.match(fn, /\bstable\b/i, "STABLE must be re-declared");

  // ── The return signature must not drift ─────────────────────────────────────
  // A TABLE(...) return cannot be altered by CREATE OR REPLACE; a mismatch fails at apply time.
  for (const col of [
    "actual_units numeric",
    "actual_value numeric",
    "target_units numeric",
    "target_value numeric",
    "achievement_value numeric",
    "rep_hr_id text",
    "dm_hr_id text",
    "has_actual boolean",
  ]) {
    assert.ok(fn.includes(col), `the return signature must still declare ${col}`);
  }

  // ── A redefined SECURITY DEFINER function must be re-locked ─────────────────
  // REVOKE ... FROM PUBLIC on a default ACL strips service_role with it, so the grant is
  // mandatory — without it every server-side read of the function fails.
  assert.match(
    sql,
    /revoke execute on function au\.f_monthly_achievement\(text\) from public, anon, authenticated/,
    "a redefined security definer function must revoke PUBLIC execute",
  );
  assert.match(
    sql,
    /grant execute on function au\.f_monthly_achievement\(text\) to service_role/,
    "service_role must be re-granted, or the REVOKE above takes the application's own access with it",
  );
}
