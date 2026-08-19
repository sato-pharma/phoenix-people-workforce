import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// phx_territory_area_pharmacies filters source_of_sales_customer_directory_rollup by
//     upper(btrim(coalesce(area_code, ''))) = <area>   AND   period = any(<periods>)
// with area_code the only selective predicate (one area ~= 2% of the table). No index could serve it
// -- the geo index leads with region_code (never constrained here), and the predicate wraps area_code
// in upper(btrim(coalesce(...))) which no plain-column index matches -- so every call PARALLEL SEQ
// SCANNED the whole 74 MB rollup (~80k rows scanned -> ~3,900 kept; 440 ms warm / 3.26 s cold on prod).
// Migration 20260816070000 adds an EXPRESSION index (upper(btrim(coalesce(area_code,''))), period)
// that matches the predicate exactly, flipping the plan to a Bitmap Index Scan (staging: 589 -> 64 ms).
//
// An index cannot change query output, so there is no data-equivalence to prove. The risk this guard
// covers is a later edit that DROPS the index, RENAMES it, or -- the subtle one -- changes EITHER the
// index expression OR the function's area predicate so the two no longer match and the index silently
// stops being used, restoring the 3.26 s scan. Both sides are pinned below.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const INDEX_MIGRATION = "20260816070000_territory_area_pharmacies_area_index.sql";
const FN_MIGRATION = "20260720110000_territory_drilldown_rpcs.sql";
const INDEX_NAME = "sos_customer_directory_rollup_area_period_idx";
// The index expression MUST equal the function's area predicate, or the planner ignores the index.
const AREA_EXPR = "upper(btrim(coalesce(area_code, '')))";

// Strip line comments before matching: this migration's header quotes the very expression and index
// name it creates, so a raw text search would match the prose.
function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

export function runTerritoryAreaIndexTests() {
  const migDir = path.join(process.cwd(), "supabase/migrations");
  const files = readdirSync(migDir);

  // The migration must actually be registered under its timestamped name, or none of it runs.
  assert.ok(files.includes(INDEX_MIGRATION), `${INDEX_MIGRATION} is present in supabase/migrations`);
  const sql = strip(readFileSync(path.join(migDir, INDEX_MIGRATION), "utf8")).toLowerCase();

  // ── A. Creates the named index on the directory rollup ───────────────────────────────────────────
  assert.ok(
    new RegExp(
      `create index if not exists ${INDEX_NAME}\\s+on public\\.source_of_sales_customer_directory_rollup`,
    ).test(sql),
    `the migration must create ${INDEX_NAME} on source_of_sales_customer_directory_rollup`,
  );

  // ── B. The index leads with the EXACT area expression the function filters on ─────────────────────
  // A plain area_code index would NOT be used -- the predicate is wrapped in upper(btrim(coalesce(...)))
  // -- so pinning the exact expression is the crux of the fix.
  assert.ok(
    sql.includes(`(${AREA_EXPR}, period)`),
    `the index must be on (${AREA_EXPR}, period) -- matching the function's predicate exactly; a plain `
      + "area_code index cannot serve the wrapped predicate and the planner would ignore it",
  );

  // ── C. ANALYZE runs -- an expression index only gets planner stats from ANALYZE ───────────────────
  assert.ok(
    /analyze public\.source_of_sales_customer_directory_rollup/.test(sql),
    "the migration must ANALYZE the table so the expression index gets selectivity statistics, or the "
      + "planner may misestimate it and skip it",
  );

  // ── D. The function still filters area with the SAME expression the index is built on ─────────────
  // If either side drifts, the index silently stops being used and the full seq scan returns.
  assert.ok(
    files.includes(FN_MIGRATION),
    `${FN_MIGRATION} (defines phx_territory_area_pharmacies) is present`,
  );
  const fnSql = strip(readFileSync(path.join(migDir, FN_MIGRATION), "utf8")).toLowerCase();
  assert.ok(
    fnSql.includes("upper(btrim(coalesce(r.area_code, '')))"),
    "phx_territory_area_pharmacies must still filter on upper(btrim(coalesce(area_code,''))) -- the index "
      + "expression is built to match it; changing one side without the other reverts to a full seq scan",
  );
}
