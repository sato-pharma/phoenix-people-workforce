import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Direct sales count toward achievement, because the 2026 targets were SET including them
// (owner ruling 2026-08-01). Excluding Direct from actuals is therefore not conservative — it
// measures a line against a target that already assumed sales the line is not being credited with.
//
// au.f_monthly_achievement gathered actuals with
//     where a.channel = 'indirect' or (a.channel = 'direct' and a.area_code is not null)
// The second arm reads as "keep Direct when we know its area". In practice it kept NOTHING: Direct
// carries no brick and no area, so every Direct row leaves au.f_monthly_attribution with
// area_code IS NULL. Measured on production for 2026-06 — 29 Direct rows, all 29 area-less:
//
//     pedia            2,434,469 counted    1,797,514 excluded    42.5% of the line missing
//     anti_infective     696,563 counted      324,593 excluded    31.8%
//     cns              4,109,042 counted            — none
//
// 2,122,106 EGP of June never reached achievement at all.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runSosDirectInAchievementTests() {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes("au_direct_counts_toward_achievement"));
  assert.ok(file, "the Direct-in-achievement migration must exist");
  const sql = code(readFileSync(join(MIGRATIONS, file), "utf8"));

  // ── The area predicate that silently dropped every Direct row must be gone ──
  assert.ok(
    !/channel = 'direct' and a\.area_code is not null/.test(sql),
    "the `direct AND area_code is not null` arm kept zero rows — Direct never has an area",
  );
  assert.match(
    sql,
    /where a\.channel in \('indirect', 'direct'\)/,
    "Direct must be kept regardless of area",
  );

  // ── Direct must NOT be spread across areas ──────────────────────────────────
  // Attribution is geographic; Direct has no area, so it belongs to the line, not to a rep.
  // Inventing an area split would be fabricating attribution.
  assert.match(
    sql,
    /group by a\.line_code, a\.area_code, a\.product_code/,
    "grouping is unchanged: Direct forms its own NULL-area rows rather than being distributed",
  );

  // ── The final join must be NULL-safe, or Direct is silently dropped again ────
  // Direct's key has a NULL area_code, and SQL's `=` is never true for two NULLs. A plain
  // `ac.area_code = k.area_code` therefore drops every Direct row straight back out of the result —
  // which is exactly what the first apply to staging did (achievement total stayed unchanged until
  // the join was made NULL-safe). Both the actuals and the target join must use IS NOT DISTINCT FROM.
  assert.match(
    sql,
    /left join actuals ac[\s\S]{0,120}ac\.area_code is not distinct from k\.area_code/,
    "the actuals rejoin must be NULL-safe on area_code, or Direct's NULL-area rows never come back",
  );
  assert.match(
    sql,
    /left join tgt tg[\s\S]{0,120}tg\.area_code is not distinct from k\.area_code/,
    "the target rejoin must be NULL-safe on area_code too",
  );
  // The lam (seat/occupant) join stays a plain `=`: a NULL-area Direct row correctly matches no seat,
  // so it is credited to no rep — that is the intended behaviour, not a bug to fix.
  assert.match(
    sql,
    /left join lam_asof lam on lam\.line_code = k\.line_code and lam\.area_code = k\.area_code/,
    "the seat join must stay a plain = on area, so a NULL-area Direct row is credited to no rep",
  );

  // ── CREATE OR REPLACE drops SET clauses; all three must be re-declared ──────
  const fn = sql.slice(sql.indexOf("create or replace function au.f_monthly_achievement"));
  assert.match(fn, /security definer/i, "SECURITY DEFINER must be re-declared — the live function has it");
  assert.match(fn, /set search_path to 'au', 'public'/i, "search_path must be re-declared verbatim");
  assert.match(fn, /\bstable\b/i, "STABLE must be re-declared");

  // ── The return signature must not drift ─────────────────────────────────────
  // A TABLE(...) return cannot be altered by CREATE OR REPLACE; a mismatch fails at apply time,
  // so pin the columns that carry the money and the ownership.
  for (const col of [
    "actual_units numeric",
    "actual_value numeric",
    "target_units numeric",
    "target_value numeric",
    "achievement_value numeric",
    "rep_hr_id text",
    "dm_hr_id text",
  ]) {
    assert.ok(fn.includes(col), `the return signature must still declare ${col}`);
  }

  // ── Direct stays credited to nobody ─────────────────────────────────────────
  // The lam_asof join is on area_code, which is NULL for Direct, so rep/DM stay NULL and
  // rep-level readers (loadClosingByEmployee drops rows with no rep_hr_id) are unaffected.
  assert.match(
    fn,
    /left join lam_asof lam on lam\.line_code = k\.line_code and lam\.area_code = k\.area_code/,
    "the seat join must stay keyed on area, so an area-less Direct row is credited to no rep",
  );

  assert.match(
    sql,
    /revoke execute on function au\.f_monthly_achievement\(text\) from public, anon, authenticated/,
    "a redefined security definer function must revoke PUBLIC execute",
  );
}
