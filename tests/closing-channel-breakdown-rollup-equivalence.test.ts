import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// phx_closing_channel_breakdown used to fold every customer's name PER ROW, PER STEM inside its
// classifier — phx_fold_customer_name(u.client_name) evaluated in two EXISTS(unnest(stems)) branches
// over ~17k retail rows, ~800 ms of a 1,594 ms call on CNS 2026-07. Migration 20260814140000 reads
// the already-resolved name AND its precomputed fold from source_of_sales_channel_customer_rollup
// (the table #2115 built and keeps fresh) instead, folding only the handful of direct rows inline.
// Nothing else changes: money is still read LIVE from source_of_sales_fact_rollup /
// source_of_sales_import_rows, the classifier stems/overrides stay live, the seat attribution, the
// four grids, the city-split inputs (brick_area / area_rep) and the emitted array are byte-for-byte.
//
// The to-the-piastre equivalence was PROVEN empirically: the rewritten body vs the live body,
// whole-array jsonb-equality diffed over every (line, period) × both report variants on BOTH
// Phoenix-HR-Staging (cifwmndunmlxjhyjugxa, 40 comparisons) and production (ozucdzovmcqvepbozvqf, 58
// comparisons) = zero differing, element counts and population to the piastre, including July's
// direct-order overlay, the Head Office restricted-collapse slices, and a negative-total month. A
// live-DB diff cannot run in CI, so this test is the in-repo backstop: it pins the SQL properties
// that MAKE that equivalence hold — and, above all, the one an "optimization" would be most tempted
// to break next.
//
// THE GUARD THAT MATTERS MOST — the `population` row. It is an INDEPENDENT re-read of the source
// tables, and monthly-closing-export.ts checks every grid TOTAL against it ("Source tables (EGP)").
// That check only has teeth because population does NOT reuse the retail/direct/tagged CTE path —
// summing `tagged` instead gives the identical number while silently neutering the very guard that
// caught a missing 4.36M on CNS. Assertion C below fails the build if population is ever sourced from
// the CTE chain instead of re-reading fact_rollup + import_rows.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const MIGRATION_NAME = "20260814140000_closing_channel_breakdown_reuse_rollup.sql";
const MIGRATION = path.join(process.cwd(), "supabase/migrations", MIGRATION_NAME);

// Strip line comments before matching: this migration's header and CTE comments quote table names,
// column names and the fold rationale, so a raw text search would match the prose.
function strip(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");
}

// The body of the one `create or replace function public.<name>` … `$function$;` block.
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} is (re)created in the migration`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${name} has a terminated body`);
  return sql.slice(start, end + "$function$;".length);
}

// One `<name> as ( … )` CTE, sliced up to the start of the next named CTE. `next` is the CTE that
// textually follows it in the body, so the slice is exactly this CTE's definition.
function cte(body: string, name: string, next: string): string {
  const start = body.indexOf(`${name} as (`);
  assert.ok(start >= 0, `the ${name} CTE exists`);
  const end = body.indexOf(`${next} as (`, start);
  assert.ok(end > start, `the ${name} CTE is followed by ${next}`);
  return body.slice(start, end);
}

export function runClosingChannelBreakdownRollupEquivalenceTests() {
  const raw = readFileSync(MIGRATION, "utf8");
  const sql = strip(raw).toLowerCase();

  // The migration must actually be registered under its timestamped name, or none of the below runs
  // in production (and this guard silently protects nothing).
  const files = readdirSync(path.join(process.cwd(), "supabase/migrations"));
  assert.ok(files.includes(MIGRATION_NAME), `${MIGRATION_NAME} is present in supabase/migrations`);

  const body = functionBody(sql, "phx_closing_channel_breakdown");

  const namesCte = cte(body, "names", "retail");
  const retailCte = cte(body, "retail", "direct");
  const directCte = cte(body, "direct", "tagged");
  const taggedCte = cte(body, "tagged", "seated");
  const populationCte = cte(body, "population", "emitted");

  // ── A. The name AND its fold come from the precomputed rollup, not a live directory scan ─────────
  // The whole speedup is that phx_fold_customer_name no longer runs per row: the resolved name and
  // its fold are read from source_of_sales_channel_customer_rollup (#2115), which resolved them by
  // the identical newest-wins rule. If the directory scan comes back, the fold cost comes back too.
  assert.ok(
    namesCte.includes("source_of_sales_channel_customer_rollup"),
    "the names CTE must read the precomputed channel rollup",
  );
  assert.ok(
    /r\.folded_name/.test(namesCte),
    "the names CTE must read the PRECOMPUTED folded_name from the rollup (not fold at read time)",
  );
  assert.ok(
    !namesCte.includes("source_of_sales_customer_directory_rollup"),
    "the names CTE must NOT scan the customer directory rollup live — that scan and its per-row fold "
    + "are exactly what moved into the channel rollup",
  );

  // ── B. The classifier matches on the PRECOMPUTED fold, never re-folding per row ──────────────────
  // The two stem branches must compare u.folded_name, and the tagged CTE must not call
  // phx_fold_customer_name at all (the inline direct fold lives in the `direct` CTE, tested in G).
  assert.ok(
    (taggedCte.match(/u\.folded_name like/g) ?? []).length >= 2,
    "both the hospital and store stem branches must match on the precomputed u.folded_name",
  );
  assert.ok(
    !taggedCte.includes("phx_fold_customer_name"),
    "the classifier must NOT call phx_fold_customer_name per row — that is the ~800 ms this change "
    + "removes; the fold is precomputed (retail) or done once in the direct CTE",
  );

  // ── C. THE CRITICAL GUARD — population stays an INDEPENDENT re-read of the source tables ─────────
  // monthly-closing-export.ts checks every grid TOTAL against this population figure. The check only
  // works because population re-reads source_of_sales_fact_rollup + source_of_sales_import_rows
  // rather than summing the same retail/direct/tagged rows the grids are built from. Sourcing it from
  // `tagged` would produce the identical number and silently disable the guard that caught the 4.36M
  // CNS drop. This assertion is the reason this whole file exists.
  assert.ok(
    populationCte.includes("source_of_sales_fact_rollup")
      && populationCte.includes("source_of_sales_import_rows"),
    "population MUST independently re-read source_of_sales_fact_rollup AND source_of_sales_import_rows",
  );
  assert.ok(
    /effective_units\s*\*\s*coalesce\(p\.factory_price,\s*0\)/.test(populationCte),
    "population's retail half must re-derive value with the live effective_units × "
    + "coalesce(factory_price,0) formula, independently of the retail CTE",
  );
  for (const derived of ["tagged", "seated", "grids", "keyed"]) {
    assert.ok(
      !new RegExp(`from\\s+${derived}\\b`).test(populationCte),
      `population must NOT be summed from the ${derived} CTE — that reuses the very rows the grids `
      + "use and neuters the source-tables self-check in monthly-closing-export.ts (the missing-4.36M "
      + "guard). It must re-read the source tables.",
    );
  }

  // ── D. Money stays LIVE — retail from the fact rollup, direct from import rows ───────────────────
  // Unlike phx_closing_channel_totals (which bakes money into the rollup), the breakdown reads money
  // live so p_exclude_codes stays fully flexible and the geography columns come straight from source.
  assert.ok(
    retailCte.includes("source_of_sales_fact_rollup")
      && /effective_units\s*\*\s*coalesce\(p\.factory_price,\s*0\)/.test(retailCte),
    "retail value must be read LIVE from source_of_sales_fact_rollup as effective_units × "
    + "coalesce(factory_price,0)",
  );
  assert.ok(
    directCte.includes("source_of_sales_import_rows") && /r\.value\s+as value/.test(directCte),
    "direct value must be read LIVE from source_of_sales_import_rows.value (the published direct_value)",
  );

  // ── E. Direct rows carry no client_code, so their fold is computed inline ────────────────────────
  // They are not in the rollup (which keys on client_code), so the ONE remaining phx_fold call is
  // here, over the handful of direct rows.
  assert.ok(
    /phx_fold_customer_name\(btrim\(coalesce\(r\.client_name/.test(directCte),
    "direct rows (absent from the rollup) must fold their client_name inline",
  );

  // ── F. The exclude filter is applied everywhere money is summed ──────────────────────────────────
  // Retail, direct and BOTH halves of population must drop the excluded codes, or the restricted /
  // non-restricted variants and the self-check would disagree. `<> all(unnest(p_exclude_codes))`
  // appears once per money scan: retail, direct, population-retail, population-direct = 4.
  const excludeGuards = (body.match(/<> all \(\s*select upper\(btrim\(x\)\) from unnest\(coalesce\(p_exclude_codes/g) ?? []).length;
  assert.equal(
    excludeGuards,
    4,
    "the exclude-codes filter must guard all four money scans (retail, direct, and both halves of the "
    + "independent population re-read) — a missing one moves the restricted-collapse numbers",
  );

  // ── G. The classifier's CASE keeps the unattributed branches BEFORE `else 'pharmacy'` ───────────
  // Byte-for-byte the live ordering: the "this is not a channel" answers precede the classifier whose
  // own fallback is pharmacy. Hospital must also outrank the store stems (hospital wins the overlap).
  const unnamedAt = taggedCte.indexOf("'direct_unnamed'");
  const noCodeAt = taggedCte.indexOf("'unidentified_no_code'");
  const noNameAt = taggedCte.indexOf("'unidentified_no_name'");
  const hospitalAt = taggedCte.indexOf("'hospital'");
  const fallbackAt = taggedCte.indexOf("else 'pharmacy'");
  assert.ok(
    unnamedAt > 0 && noCodeAt > 0 && noNameAt > 0 && hospitalAt > 0 && fallbackAt > 0,
    "the classifier carries all three unattributed branches, the hospital branch and the pharmacy fallback",
  );
  for (const [label, at] of [
    ["direct_unnamed", unnamedAt],
    ["unidentified_no_code", noCodeAt],
    ["unidentified_no_name", noNameAt],
    ["hospital", hospitalAt],
  ] as const) {
    assert.ok(
      at < fallbackAt,
      `the ${label} branch must come BEFORE \`else 'pharmacy'\``,
    );
  }
  assert.ok(hospitalAt < taggedCte.lastIndexOf("then 'store'"), "hospital must be tested before the store stems");

  // ── H. The emitted array and its order are preserved, so every downstream reader keeps working ──
  // The four grid dimensions plus area_rep, brick_area and population, ordered by (dimension,
  // total desc, key). store-split-channel-breakdown.ts reads brick_area + area_rep; the export
  // self-check reads population.
  for (const emitted of ["'area_rep'", "'brick_area'", "'population'"]) {
    assert.ok(body.includes(emitted), `the emitted array must still carry the ${emitted} row`);
  }
  assert.ok(
    /jsonb_agg\(row_to_json\(e\) order by e\.dimension, e\.total desc, e\.key\)/.test(body),
    "the array order must stay (dimension, total desc, key) — the whole-array equivalence proof and "
    + "every downstream reader rely on it",
  );

  // ── I. Function attributes preserved — SECURITY DEFINER, parallel-safe, pinned search_path/timeout ─
  assert.ok(/stable parallel safe security definer/.test(body), "STABLE PARALLEL SAFE SECURITY DEFINER preserved");
  assert.ok(/set search_path to 'public', 'au'/.test(body), "search_path pinned to public, au");
  assert.ok(/set statement_timeout to '60s'/.test(body), "statement_timeout pinned to 60s");
  assert.ok(
    /revoke execute on function public\.phx_closing_channel_breakdown\([^)]*\) from public, anon, authenticated/.test(sql),
    "execute is revoked from public/anon/authenticated (SECURITY DEFINER posture)",
  );
  assert.ok(
    /grant execute on function public\.phx_closing_channel_breakdown\([^)]*\) to service_role/.test(sql),
    "execute is granted to service_role",
  );
}
