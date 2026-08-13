import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// au.f_monthly_achievement rejoined `keys` back to `actuals` and `tgt` with four-column
// IS NOT DISTINCT FROM predicates. Those are NULL-safe (so a sale carrying no line / no
// area / no product is not zeroed out) but un-hashable, so each rejoin ran as a nested
// loop. On production 2026-07 that was 847,356 + 702,756 rows removed by join filter —
// ~510 ms/month of pure comparison on top of the attribution floor, 7.0% of all database
// time through the range reporter phx_sales_vs_target_range.
//
// This migration folds the four key columns into one delimiter-joined text join_key
// (chr(30) marks a NULL, chr(31) separates fields — control characters absent from any
// code) and rejoins on plain =, which the planner can hash/merge. It is exactly
// NULL-safe-equal. Measured 848 ms -> 351 ms/month; output identical to the piastre
// (2026-07 965 rows, 2026-08 669 rows, zero symmetric difference on production).
//
// This test pins that the fast, hashable form is what shipped — and, just as important,
// that the NULL-safety the join_key replaces is still there (every one of the four key
// columns is coalesced to the marker), so a line-less sale still cannot report as zero.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Strip block and line comments so an assertion can never match prose in the header. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runAchievementHashableJoinKeyTests() {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes("achievement_hashable_join_key"));
  assert.ok(file, "the achievement hashable-join-key migration must exist");
  const sql = code(readFileSync(join(MIGRATIONS, file!), "utf8"));
  const fn = sql.slice(sql.indexOf("create or replace function au.f_monthly_achievement"));

  // ── The rejoins must be hashable equality on the folded key ─────────────────
  assert.match(
    fn,
    /left join actuals ac\s*on ac\.join_key = k\.join_key/,
    "the actuals rejoin must be a plain = on join_key, or the nested loop returns",
  );
  assert.match(
    fn,
    /left join tgt tg\s*on tg\.join_key = k\.join_key/,
    "the target rejoin must be a plain = on join_key",
  );

  // ── The un-hashable form must be gone from the actuals/tgt rejoins ──────────
  assert.ok(
    !/left join actuals ac\s*on[\s\S]{0,200}is not distinct from/.test(fn),
    "the actuals rejoin must not fall back to IS NOT DISTINCT FROM (un-hashable => nested loop)",
  );
  assert.ok(
    !/left join tgt tg\s*on[\s\S]{0,200}is not distinct from/.test(fn),
    "the target rejoin must not fall back to IS NOT DISTINCT FROM",
  );

  // ── join_key must fold ALL FOUR key columns, each NULL-mapped to the marker ──
  // This is what preserves the NULL-safety the IS NOT DISTINCT FROM joins gave: a
  // line-less (or area-less, or product-less) sale must still match its own key and
  // not zero out. Both sides — actuals and tgt — must build the key the same way.
  for (const colExpr of [
    /coalesce\(at\.line_code, chr\(30\)\)/,
    /coalesce\(at\.area_code, chr\(30\)\)/,
    /coalesce\(case when at\.area_code is null then at\.region_code end, chr\(30\)\)/,
    /coalesce\(at\.product_code, chr\(30\)\)/,
  ]) {
    assert.match(fn, colExpr, "actuals join_key must NULL-map every key column to the marker");
  }
  for (const colExpr of [
    /coalesce\(t\.line_code, chr\(30\)\)/,
    /coalesce\(t\.area_code, chr\(30\)\)/,
    /coalesce\(null::text, chr\(30\)\)/,
    /coalesce\(t\.product_code, chr\(30\)\)/,
  ]) {
    assert.match(fn, colExpr, "tgt join_key must NULL-map every key column the same way");
  }
  assert.match(fn, /concat_ws\(chr\(31\)/, "fields must be joined by the chr(31) delimiter");

  // ── keys must carry join_key so the rejoins have something to match ─────────
  assert.match(fn, /select actuals\.join_key,[\s\S]{0,140}from actuals\s*union/, "keys must select actuals.join_key");
  assert.match(fn, /select tgt\.join_key,[\s\S]{0,140}from tgt/, "keys must select tgt.join_key");

  // ── PARALLEL SAFE must be re-declared, or CREATE OR REPLACE regresses it ─────
  // The live function is STABLE PARALLEL SAFE (20260814003000 marked it). CREATE OR
  // REPLACE resets an unstated characteristic to its default, so omitting this would
  // silently return the function to PARALLEL UNSAFE and undo that change.
  assert.match(fn, /parallel safe/i, "PARALLEL SAFE must be re-declared or the parallel-safe chain regresses");

  // ── Everything the earlier achievement migrations pinned must still hold ────
  assert.ok(!/where\s+a\.channel/.test(fn), "no channel predicate may return: it is how sales left the report");
  assert.match(fn, /coalesce\(ac\.matched, false\)/, "has_actual must come from a marker that exists whenever the row does");
  assert.match(
    fn,
    /left join lam_asof lam\s*on lam\.line_code = k\.line_code\s*and lam\.area_code = k\.area_code/,
    "the seat join must stay a plain = on area, so an unplaced row reaches no rep",
  );
  assert.match(fn, /coalesce\(lam\.dm_seat_id, rdm\.dm_seat_id\)/, "an area-less Direct row must still fall back to its region's DM seat");
  assert.match(fn, /lam\.rep_seat_id, lam\.rep_occupant_hr_id/, "rep columns must read straight from the area seat map");

  // ── CREATE OR REPLACE drops SET clauses; all three must be re-declared ──────
  assert.match(fn, /security definer/i, "SECURITY DEFINER must be re-declared");
  assert.match(fn, /set search_path to 'au', 'public'/i, "search_path must be re-declared verbatim");
  assert.match(fn, /\bstable\b/i, "STABLE must be re-declared");

  // ── The return signature must not drift ─────────────────────────────────────
  for (const col of [
    "actual_units numeric", "actual_value numeric", "target_units numeric",
    "target_value numeric", "achievement_value numeric", "rep_hr_id text",
    "dm_hr_id text", "has_actual boolean",
  ]) {
    assert.ok(fn.includes(col), `the return signature must still declare ${col}`);
  }

  // ── A redefined SECURITY DEFINER function must be re-locked ─────────────────
  assert.match(
    sql,
    /revoke execute on function au\.f_monthly_achievement\(text\) from public, anon, authenticated/,
    "a redefined security definer function must revoke PUBLIC execute",
  );
  assert.match(
    sql,
    /grant execute on function au\.f_monthly_achievement\(text\) to service_role/,
    "service_role must be re-granted",
  );
}
