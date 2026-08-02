import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Allocating area-less Direct sales across the DM territories inside one SoS region.
//
// Owner ruling 2026-08-02 on the Anti Infective Direct that carries region 'UE' but no area —
// 1,200 units / 88,882.40 EGP that no evidence could place: "UE 1,200 should be distrbuted on
// ue 1 and ue 2 ... based on areas she minia 1 - 2 & banisuef he sohag assuit qena", recorded in
// the attribution layer rather than by rewriting invoice rows.
//
//   UE-1  Nosiba Salah       Minia 1, Minia 2, Fayoum-Beni Suef     3 areas -> weight 3
//   UE-2  Ahmed Nashaat Ali  Assuit 1/2, Sohag 1/2, Qena 1/2        6 areas -> weight 6
//
// Verified on staging 2026-06: 51,640.00 of UE Direct split to 17,213.33 / 34,426.67 — exactly
// 1/3 and 2/3, summing back to the cent, with every other region and every line total unchanged.
//
// The two properties this test exists to defend:
//
//  1. CONSERVATION. share = weight / sum(weight) over the group, so the shares always total 1.
//     Hardcoding fractions, or grouping the window differently, silently creates or destroys
//     money — the failure mode that would be hardest to notice downstream.
//  2. NO-OP WHERE UNCONFIGURED. The LEFT JOIN + coalesce(share, 1) must leave every (line,
//     region) without a rule byte-identical. Lose that and CNS/Pedia move too.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

function readMigration(fragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(fragment));
  assert.ok(file, `the ${fragment} migration must exist`);
  return code(readFileSync(join(MIGRATIONS, file), "utf8"));
}

export function runDirectRegionAllocationTests() {
  const table = readMigration("au_direct_region_allocation");

  // ── The allocation is DATA, not a constant buried in SQL ────────────────────
  // The basis is a business decision that will change; weights in a table mean changing it is
  // an UPDATE, not a migration + function redeploy.
  assert.match(table, /create table if not exists au\.direct_region_allocation/,
    "the allocation must live in a table so the basis can change without a migration");
  assert.match(table, /primary key \(line_code, sos_region_code, target_region_code\)/,
    "one weight per (line, source region, target region)");
  assert.match(table, /check \(weight > 0\)/,
    "a zero or negative weight would produce a divide-by-zero or negative share");
  assert.match(table, /check \(target_region_code <> sos_region_code\)/,
    "allocating a region to itself would loop the ambiguous code straight back in");

  // ── Seeded with the owner's territory split ─────────────────────────────────
  assert.match(table, /'anti_infective','UE','UE-1',3/, "UE-1 carries 3 areas");
  assert.match(table, /'anti_infective','UE','UE-2',6/, "UE-2 carries 6 areas");

  // ── Service-role only; this table drives money attribution ──────────────────
  assert.match(table, /revoke all on table au\.direct_region_allocation from public, anon, authenticated/,
    "an attribution input must not be world-readable");

  const fn = readMigration("au_attribution_applies_direct_allocation");

  // ── CONSERVATION: shares must be normalised over the group, never hardcoded ─
  assert.match(
    fn,
    /a\.weight \/ sum\(a\.weight\) over \(partition by a\.line_code, a\.sos_region_code\)/,
    "share must be weight ÷ the group's total weight, so the shares always sum to exactly 1",
  );
  assert.ok(
    !/0\.3333|0\.6666|1\.0\s*\/\s*3|2\.0\s*\/\s*3/.test(fn),
    "shares must never be hardcoded fractions — that breaks the moment a weight changes",
  );

  // ── The split must apply to BOTH units and value, by the same share ─────────
  assert.match(fn, /sum\(pr\.total_qty\s*\* coalesce\(alloc\.share, 1\)\)/,
    "units must be split by the share");
  assert.match(fn, /sum\(pr\.direct_value \* coalesce\(alloc\.share, 1\)\)/,
    "value must be split by the SAME share, or units and value disagree");

  // ── NO-OP where unconfigured ────────────────────────────────────────────────
  // A LEFT JOIN plus coalesce(share, 1) is what keeps every other line and region identical.
  assert.match(fn, /left join alloc\s*on alloc\.line_code = pr\.line_code/,
    "the allocation join must be a LEFT JOIN — an inner join would DROP every unallocated Direct row");
  assert.match(
    fn,
    /coalesce\(alloc\.target_region_code, coalesce\(nullif\(pr\.sos_region_code,''\), 'NATIONAL'\)\)/,
    "an unallocated row must keep the region it arrived with",
  );

  // ── Grouping must follow the allocated region, not the original ─────────────
  // Grouping by the source region would re-merge UE-1 and UE-2 back into one row after splitting.
  assert.match(
    fn,
    /group by pr\.line_code,\s*coalesce\(alloc\.target_region_code, coalesce\(nullif\(pr\.sos_region_code,''\),'NATIONAL'\)\),\s*pr\.product_code/,
    "the group must key on the ALLOCATED region, or the fan-out collapses straight back",
  );

  // ── Only Branch B2 changes ──────────────────────────────────────────────────
  // Direct keeps its sheet-value basis, and the indirect branch keeps the factory-price recompute.
  assert.match(fn, /sum\(pr\.effective_units \* pr\.factory_price\)/,
    "the indirect branch must still value at effective units × factory price");
  assert.ok(
    !/alloc\.share[\s\S]{0,200}effective_units/.test(fn),
    "the allocation must never touch the indirect branch",
  );

  // ── CREATE OR REPLACE drops SET clauses ────────────────────────────────────
  assert.match(fn, /security definer/i, "SECURITY DEFINER must be re-declared");
  assert.match(fn, /set search_path to 'au', 'public'/i, "search_path must be re-declared verbatim");
  assert.match(fn, /\bstable\b/i, "STABLE must be re-declared");
  assert.match(
    fn,
    /revoke execute on function au\.f_monthly_attribution\(text\) from public, anon, authenticated/,
    "a redefined security definer function must revoke PUBLIC execute",
  );
}
