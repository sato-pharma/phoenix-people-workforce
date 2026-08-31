import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Three functions re-stamp source_of_sales_import_rows geography from the customer map + brick
// master. All three built a `target` CTE that computes the CORRECT brick, area and region, wrote
// all of them in the SET clause, and then gated the whole UPDATE on ONE of them:
//
//     and r.brick_id is distinct from t.brick_id
//
// So a RE-PARENTED brick — same brick_id, new area — was skipped forever. The brick master updates
// (bricks -> blocks -> areas, both ON UPDATE CASCADE), the target CTE computes the new area, and
// the row is never touched. phx_sos_rows_attributed reads area_code straight off import_rows, so
// the stale stamp lands in source_of_sales_fact_rollup and every rollup built from it, while the
// sync reports restamped_rows = 0 and the reconciliation — which groups by (official_line, period)
// only — reports "all lines reconcile".
//
// Measured on production 2026-08-31: 14 rows / EGP 5,274.90 in 2026-07 (B193-M1 stamped D14 where
// the master says D15; B220-2 stamped CA1 where it says CA2), all Anti Infective.
//
// Proven on staging 2026-08-31 by corrupting one row's area_code with its brick_id left correct:
// the old brick-only function returned updated_rows = 0 and left the row wrong; the fixed function
// returned 1 and restored it.
//
// This test pins the predicate on the definition the DATABASE will actually have — the last
// migration that creates each function — so a future migration cannot quietly reintroduce the
// brick-only form.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** Strip block and line comments so an assertion can never match prose in a migration header. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

/** The three functions that re-stamp source_of_sales_import_rows geography. */
const RESTAMP_FUNCTIONS = [
  "public.phx_sync_sos_run",
  "public.phx_sync_sos_restamp_import_rows",
  "public.sos_reconcile_import_rows_from_customer_map",
] as const;

/**
 * The body of `name` as the database will actually have it. Migrations apply in filename order, so
 * the LAST file creating the function wins. Reading only the newest migration would pass while some
 * other file redefined it; asserting across EVERY file would fail on the historical copies that
 * legitimately still carry the old predicate — they are applied history and must not be edited.
 */
function effectiveDefinition(name: string): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found: { file: string; body: string } | null = null;

  for (const file of files) {
    // readFileSync, never `git show <ref>:<path>` — that returns EMPTY under MSYS on this
    // checkout, which would make every assertion below pass by reading nothing.
    const sql = code(readFileSync(join(MIGRATIONS, file), "utf8"));
    const create = new RegExp(
      `create\\s+(?:or\\s+replace\\s+)?function\\s+${name.replace(/\./g, "\\.")}\\s*\\(`,
      "i",
    );
    const match = create.exec(sql);
    if (!match) continue;

    const from = sql.slice(match.index);
    // Cut at the dollar-quote tag this definition actually opened with ($function$, $$, ...),
    // so a file using a different tag is not read to end-of-file.
    const tag = /\bas\s+(\$[a-z_]*\$)/i.exec(from)?.[1] ?? "$function$";
    const bodyStart = from.indexOf(tag) + tag.length;
    const bodyEnd = from.indexOf(tag, bodyStart);
    found = { file, body: bodyEnd === -1 ? from : from.slice(0, bodyEnd) };
  }

  assert.ok(found, `no migration creates ${name}`);
  return found!;
}

export function runTerritoryRestampAreaChangeTests() {
  for (const name of RESTAMP_FUNCTIONS) {
    const { file, body } = effectiveDefinition(name);

    // ── The headline: an area re-parent must re-stamp ────────────────────────────
    assert.match(
      body,
      /r\.area_code\s+is distinct from t\.area_code/,
      `${name} (latest: ${file}) must re-stamp when the AREA changed — gating on brick alone left `
        + "14 rows / EGP 5,274.90 mis-stamped in 2026-07 while the sync reported 0 re-stamped",
    );
    assert.match(
      body,
      /r\.region_code\s+is distinct from t\.region_code/,
      `${name} (latest: ${file}) must re-stamp when the REGION changed`,
    );
    assert.match(
      body,
      /r\.brick_id\s+is distinct from t\.brick_id/,
      `${name} (latest: ${file}) must still re-stamp when the BRICK changed`,
    );

    // ── The three must be OR'd, not AND'd ────────────────────────────────────────
    // AND-ing them would be strictly worse than the bug being fixed: a row would have to have all
    // three wrong before it was corrected.
    assert.match(
      body,
      /\(\s*r\.brick_id\s+is distinct from t\.brick_id\s+or\s+r\.area_code\s+is distinct from t\.area_code\s+or\s+r\.region_code\s+is distinct from t\.region_code\s*\)/,
      `${name} (latest: ${file}) must OR the three code predicates into one group`,
    );

    // ── The NAME columns are deliberately NOT in the predicate ───────────────────
    // area_name/region_name on import_rows disagree with the brick master on a further 8,824 rows
    // across 2026-01..07 (mostly a pre-split "Fayoum-Beni Suef" snapshot, on all four lines). None
    // of the four rollups — fact, customer_directory, channel, distributor_product — carries a name
    // column at all; they key on the CODES and names are resolved by code at read time. So adding
    // the names here would rewrite 8,824 rows of closed history for no downstream effect.
    assert.ok(
      !/(?:area|region)_name\s+is distinct from/.test(body),
      `${name} (latest: ${file}) must NOT gate on the name columns — no rollup carries a name, so `
        + "that would rewrite 8,824 rows of closed history with no effect on any report",
    );

    // ── ...but a row that IS re-stamped must take the new names with it ──────────
    // Otherwise a corrected CA2 row would keep CA1's old label, which is worse than either state.
    assert.match(
      body,
      /area_name = coalesce\(t\.area_name, r\.area_name\)/,
      `${name} (latest: ${file}) must still write area_name, so a re-stamped row is not left `
        + "carrying its previous area's label",
    );
    assert.match(
      body,
      /region_name = coalesce\(t\.region_name, r\.region_name\)/,
      `${name} (latest: ${file}) must still write region_name`,
    );
  }
}
