import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Direct sales reach their REGION'S District Manager.
//
// Owner ruling 2026-08-02, from a worked example: Anti Infective / July / Royafloxacin / Cairo
// reads retail 201 and direct 200, and "direct should be calculated to dm total".
//
// The predecessor migration (au_direct_counts_toward_achievement) got Direct into achievement but
// stopped at the line: it grouped Direct as (line, NULL area, product) and left the seat join
// keyed on area, so dm_hr_id stayed NULL. Two things make that insufficient:
//
//   1. One area-less row per (line, product) FUSES the regions. Measured on production for
//      2026-07 / anti_infective / RO001, Direct is CA 200u + D1 300u + UE 300u — collapsing those
//      into a single 800u row makes it impossible to ever reach three different DMs.
//   2. Direct carries a REGION even though it carries no area, and (line, region) -> DM is an
//      exact lookup in au.line_area_map (22 of 22 live pairs resolve to exactly one dm_seat_id).
//
// Verified against production BEFORE the function was changed, by running the new CTE chain as a
// read-only query: Momen Abdelhady Shehata (Cairo) = 313 units / 17,444.75 EGP = 113 retail + 200
// direct. Down town (CA5) contributes 0 to him and 88 to the Others bucket, per the owner's
// ruling that an Others area is "calculated with others but it laying under cairo".
//
// A REP must still never receive Direct: no area means no rep seat, and splitting one would be
// fabricating attribution. That distinction — DM yes, rep no — is the whole point of this test.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Strip block and line comments so an assertion can never match prose in the header. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

function readMigration(fragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  assert.ok(file, `the ${fragment} migration must exist`);
  return code(readFileSync(join(MIGRATIONS, file), "utf8"));
}

export function runSosDirectToDmTests() {
  const sql = readMigration("au_direct_reaches_region_dm");
  const fn = sql.slice(sql.indexOf("create or replace function au.f_monthly_achievement"));

  // ── Direct is still kept regardless of area ─────────────────────────────────
  assert.match(
    sql,
    /where a\.channel in \('indirect', 'direct'\)/,
    "Direct must stay in the actuals; dropping it again would re-open the original gap",
  );

  // ── The region must be carried for area-less rows, or the regions fuse ──────
  // Without this, CA 200 + D1 300 + UE 300 become one 800-unit row that can never be split back
  // out to three DMs. The case expression is what keeps each region's Direct on its own row.
  assert.match(
    sql,
    /case when at\.area_code is null then at\.region_code end as direct_region_code/,
    "an area-less row must carry its region so it can reach that region's DM",
  );
  assert.match(
    sql,
    /group by at\.line_code, at\.area_code,\s*case when at\.area_code is null then at\.region_code end,\s*at\.product_code/,
    "the actuals grouping must include the carried region, or every region's Direct collapses into one row",
  );

  // ── region -> DM is a lookup, never an allocation ───────────────────────────
  assert.match(
    sql,
    /region_dm as \([\s\S]{0,600}group by lam\.line_code, lam\.operational_region_code/,
    "there must be a (line, region) -> DM map derived from the seat model",
  );
  assert.match(
    sql,
    /coalesce\(lam\.dm_seat_id, rdm\.dm_seat_id\)/,
    "an area-less Direct row must fall back to its region's DM seat",
  );
  assert.match(
    sql,
    /coalesce\(lam\.dm_occupant_hr_id, rdm\.dm_occupant_hr_id\)/,
    "an area-less Direct row must fall back to its region's DM occupant",
  );

  // ── A REP must never receive Direct ─────────────────────────────────────────
  // This is the assertion that separates this change from "spread Direct over the areas". The rep
  // columns must come from lam ALONE — never coalesced onto a region-derived fallback.
  assert.match(
    fn,
    /lam\.rep_seat_id, lam\.rep_occupant_hr_id/,
    "rep columns must read straight from the area seat map",
  );
  assert.ok(
    !/coalesce\([^)]*rep_seat_id/.test(fn) && !/coalesce\([^)]*rep_occupant_hr_id/.test(fn),
    "a rep must NEVER be back-filled from a region — Direct has no area, so crediting a rep fabricates attribution",
  );
  // The seat join stays a plain `=` on area precisely so a NULL-area row matches no rep seat.
  assert.match(
    sql,
    /left join lam_asof lam\s*on lam\.line_code = k\.line_code\s*and lam\.area_code = k\.area_code/,
    "the seat join must stay keyed on area, so an area-less Direct row is credited to no rep",
  );

  // ── Both rejoins must be NULL-safe on BOTH nullable key parts ───────────────
  // area_code is NULL for Direct and direct_region_code is NULL for everything else, and
  // `NULL = NULL` is never true — a plain `=` on either silently drops the rows right back out.
  for (const [alias, table] of [["ac", "actuals"], ["tg", "tgt"]] as const) {
    assert.match(
      sql,
      new RegExp(`left join ${table} ${alias}[\\s\\S]{0,200}${alias}\\.area_code is not distinct from k\\.area_code`),
      `the ${table} rejoin must be NULL-safe on area_code`,
    );
    assert.match(
      sql,
      new RegExp(`left join ${table} ${alias}[\\s\\S]{0,200}${alias}\\.direct_region_code is not distinct from k\\.direct_region_code`),
      `the ${table} rejoin must be NULL-safe on direct_region_code too, or Direct is dropped again`,
    );
  }

  // ── The reported region must survive for Direct ─────────────────────────────
  assert.match(
    sql,
    /coalesce\(lam\.operational_region_code, k\.direct_region_code\)/,
    "an area-less Direct row must still report the region it arrived with",
  );

  // ── CREATE OR REPLACE drops SET clauses; all three must be re-declared ──────
  assert.match(fn, /security definer/i, "SECURITY DEFINER must be re-declared — the live function has it");
  assert.match(fn, /set search_path to 'au', 'public'/i, "search_path must be re-declared verbatim");
  assert.match(fn, /\bstable\b/i, "STABLE must be re-declared");
  assert.match(
    sql,
    /revoke execute on function au\.f_monthly_achievement\(text\) from public, anon, authenticated/,
    "a redefined security definer function must revoke PUBLIC execute",
  );

  // ── The return signature must not drift ─────────────────────────────────────
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

  // ── The Upper Egypt split must exist in the SoS region master ───────────────
  // Anti Infective splits Upper Egypt into UE-1/UE-2, but source_of_sales_regions carried only a
  // single "UE", so a Direct sheet could not tag the owner's ruling ("tag UE-1 and UE-2 in the
  // direct sheet") and 208,652.40 EGP resolved to no DM.
  const regions = readMigration("sos_regions_upper_egypt_split");
  assert.match(regions, /'UE-1', 'Upper Egypt 1'/, "UE-1 must be added to the SoS region master");
  assert.match(regions, /'UE-2', 'Upper Egypt 2'/, "UE-2 must be added to the SoS region master");
  assert.match(
    regions,
    /on conflict \(region_code\) do nothing/,
    "the insert must be idempotent — re-running a migration must never fail or overwrite a live region",
  );
  assert.ok(
    !/ims_ratio/.test(regions.replace(/^[\s\S]*?begin;/, "")),
    "ims_ratio is owner-entered per region and must never be invented by a migration",
  );
  // Additive only: adding a lookup row must not silently move areas or re-tag sales.
  assert.ok(
    !/\bupdate\b/i.test(regions) && !/\bdelete\b/i.test(regions),
    "this migration is additive reference data only — it must not update or delete any row",
  );
}
