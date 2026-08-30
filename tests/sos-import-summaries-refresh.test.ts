import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// `source_of_sales_import_summaries` is what the Source of Sales DASHBOARD reads. Until
// 2026-08-30 it had two writers and ZERO update paths: written once from the parsed rows at
// import, never again. Every sibling aggregate over those same rows (fact rollup, customer
// directory, marketing ROI, channel totals, distributor x product, monthly attribution) had a
// phx_refresh_* function that the correction paths re-ran. The summaries were the one left out.
//
// So correcting a row rebuilt everything the Monthly Closing reads and nothing the dashboard
// reads, and the dashboard went stale permanently, with no marker. Measured on production
// 2026-08-30 for 2026-07, validated batches only:
//
//   summaries (the By Line / By Area / By Product / By Brick tables)  60,988,133.10  (44,275 rows)
//   batch headers (the CEO / Super Admin headline total)              61,547,413.60
//   import rows (the truth)                                           61,641,432.23  (44,238 rows)
//
// Three different numbers for one month — the page could not even agree with itself, because the
// headline and the tables under it are two independently frozen snapshots. 653,299.13 EGP of it
// was the summaries alone.
//
// Verified end to end on staging (a production clone) before shipping: after refreshing every
// validated 2026-07 batch, line/area/product/brick summaries AND the batch headers all landed on
// 61,641,432.225968 with 44,238 rows — exactly the raw rows. Re-running produced a byte-identical
// result (idempotent) and left all 16,018 summary rows of other periods untouched.

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase/migrations");

const REFRESH_FN = "phx_refresh_sos_import_summaries";
// The last rollup every refresh site already ran. Any site refreshing THAT is a full
// rollup-refresh site, and must refresh the summaries too.
const ROLLUP_MARKER = "phx_refresh_monthly_attribution";

function migrationSource(nameFragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(nameFragment));
  assert.ok(file, `migration containing "${nameFragment}" must exist`);
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])--[^\n]*/g, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export function runSosImportSummariesRefreshTests() {
  const sql = stripSqlComments(migrationSource("sos_refresh_import_summaries"));

  // ── The refresh function exists and rebuilds from the ROWS ─────────────────
  {
    const fn = sql.slice(sql.indexOf(`function public.${REFRESH_FN}`));
    assert.ok(fn.length > 0, `${REFRESH_FN} must be defined in this migration`);

    // Delete-then-insert: without the delete it is not a refresh, it is a duplicate insert that
    // would trip the (batch_id, group_type, group_key) unique constraint.
    assert.match(
      fn,
      /delete from public\.source_of_sales_import_summaries\s+where batch_id = p_batch_id;/,
      "the refresh must clear the batch's summaries before rebuilding them",
    );
    assert.match(
      fn,
      /insert into public\.source_of_sales_import_summaries/,
      "the refresh must rebuild the summaries",
    );

    // All five group types the dashboard renders. A missing one is a silently blank table.
    for (const groupType of ["line", "region", "area", "product", "brick"]) {
      assert.ok(
        fn.includes(`'${groupType}'`),
        `the rebuild must cover the '${groupType}' group type — the dashboard renders it`,
      );
    }

    // Rebuilt from the import rows, never from another aggregate (which could itself be stale).
    assert.ok(
      countOf(fn, "from public.source_of_sales_import_rows r") >= 6,
      "every group type plus the header total must aggregate from source_of_sales_import_rows",
    );

    // Same failed-row rule as phx_refresh_sos_fact_rollup — pinned in sos-rollup-sql-truth.test.ts.
    // If these two disagree, the dashboard and the closing basis can diverge again, which is the
    // whole defect this migration exists to close.
    assert.equal(
      countOf(fn, "coalesce(r.validation_state, 'valid') <> 'failed'"),
      6,
      "all five group types AND the batch-header re-derivation must exclude failed rows, " +
        "matching phx_refresh_sos_fact_rollup",
    );

    // CREATE OR REPLACE silently drops these on a SECURITY DEFINER function.
    assert.match(fn, /security definer/i, "must stay SECURITY DEFINER");
    assert.match(fn, /set search_path to 'public'/i, "search_path must be declared");
    assert.match(fn, /set statement_timeout to '120s'/i, "statement_timeout must be declared");
  }

  // ── The batch header: money re-derived, row counts deliberately NOT ────────
  {
    const update = sql.slice(sql.indexOf("update public.source_of_sales_import_batches b"));
    assert.ok(update.length > 0, "the batch header must be re-derived in the same pass");
    for (const column of ["total_qty", "total_bonus_qty", "total_value"]) {
      assert.ok(
        new RegExp(`set[\\s\\S]*${column}\\s*=`).test(update.slice(0, 400)),
        `${column} must be re-derived — it is what the CEO / Super Admin headline reads`,
      );
    }
    // The row-count columns describe the PARSE, not the stored rows (rows_ignored / rows_blank
    // exist precisely to record what the sheet held but the import dropped), and historically
    // total_rows diverges from the persisted count by amounts that do not reconcile against
    // rows_ignored. Re-deriving them would restate provenance rather than repair staleness.
    for (const column of ["total_rows", "importable_rows", "failed_rows", "warning_rows", "rows_ignored", "rows_blank"]) {
      assert.ok(
        !new RegExp(`\\b${column}\\s*=`).test(update.slice(0, 400)),
        `${column} must NOT be re-derived — it is a parse-time figure, not a row aggregate. ` +
          "See the migration header before changing this.",
      );
    }
  }

  // ── The atomic import path runs it ─────────────────────────────────────────
  {
    const finalize = sql.slice(sql.indexOf("function public.phx_finalize_sos_batch"));
    assert.ok(finalize.length > 0, "phx_finalize_sos_batch must be recreated with the new step");
    assert.match(
      finalize,
      new RegExp(`perform public\\.${REFRESH_FN}\\(p_batch_id\\);`),
      "phx_finalize_sos_batch must refresh the import summaries alongside the six rollups",
    );
    // It refreshes six rollups; the summaries make seven. A dropped one is a silently stale screen.
    assert.equal(
      countOf(finalize, "perform public.phx_refresh"),
      7,
      "phx_finalize_sos_batch must still perform all seven refreshes",
    );
    assert.match(finalize, /set search_path to 'public'/i, "search_path must be re-declared");
    assert.match(finalize, /set statement_timeout to '120s'/i, "statement_timeout must be re-declared");
  }

  // ── ONE rule, no exceptions: every refresh site refreshes the summaries ────
  // Derived from the source rather than a fixed list, so a NEW correction path added later is
  // caught too. An exception list is exactly what let these aggregates drift apart.
  {
    const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app"))];
    const sites = files
      .map((file) => ({ file, body: readFileSync(file, "utf8") }))
      .filter((entry) => entry.body.includes(ROLLUP_MARKER));

    assert.ok(
      sites.length >= 4,
      `expected at least the 4 known rollup-refresh sites, found ${sites.length} — ` +
        "if a site was removed, confirm that was intended",
    );

    for (const { file, body } of sites) {
      const rollupCalls = countOf(body, `rpc("${ROLLUP_MARKER}"`);
      const summaryCalls = countOf(body, `rpc("${REFRESH_FN}"`);
      const relative = file.slice(ROOT.length + 1).replace(/\\/g, "/");
      assert.ok(
        summaryCalls >= rollupCalls,
        `${relative} refreshes the rollups ${rollupCalls}x but the import summaries only ` +
          `${summaryCalls}x. Every site that rebuilds the rollups must also rebuild ` +
          `source_of_sales_import_summaries, or the Source of Sales dashboard goes stale with ` +
          "no marker — that is the 653,299.13 EGP July 2026 defect.",
      );
    }
  }
}
