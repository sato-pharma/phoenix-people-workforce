import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";

/**
 * The hourly Marketing ROI rebuild lists its distinct valid invoice periods by SKIPPING, not by
 * aggregating every valid row.
 *
 * Found in the 16 October 2026 slowness audit: `phx_refresh_marketing_roi_facts()` averaged 9.4 s over
 * 58 calls (5.3-13.9 s). Its bare-call branch ran `array_agg(distinct invoice_period order by
 * invoice_period)` over EVERY valid row of `source_of_sales_import_rows` — an index-only scan of
 * ~406,000 entries, 13,867 pages, ~108 MB — and the hourly tick found that index out of cache (one
 * measured call read 14,106 blocks from disk). Everything the function is about — the matching,
 * valuation and direct-order branches — took ~25 ms, and the fact tables hold 3-64 rows each. The
 * array is only WRITTEN to `marketing_roi_refresh_runs.affected_periods`; nothing in the rebuild
 * reads it.
 *
 * The migration `20261016223000` replaces that one statement with a recursive loose scan on the
 * partial index (`sos_smi_valid_period_line_region_idx`, leading column `invoice_period`): one probe
 * per period, 11 of them, 53 pages. Proven on production and on staging to return the identical array
 * and identical facts. This file pins the SHAPE, because the failure is silent: put the full
 * aggregate back and every number stays right while the hourly job goes back to ~5 s of disk reads.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);

/** The newest migration that defines the function, found by CONTENT — a later redefinition resolves. */
function newestDefinition(): { file: string; sql: string; code: string } {
  let found: { file: string; sql: string } | null = null;
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(name, MIGRATIONS), "utf8");
    if (/create\s+or\s+replace\s+function\s+public\.phx_refresh_marketing_roi_facts\s*\(/i.test(sql)) {
      found = { file: name, sql };
    }
  }
  assert.ok(found, "no migration defines phx_refresh_marketing_roi_facts");
  const code = stripSqlComments(found!.sql).replace(/\s+/g, " ");
  return { ...found!, code };
}

export function runMarketingRoiRefreshPeriodSkipTests() {
  const { file, sql, code } = newestDefinition();

  assert.match(
    code,
    /with recursive step\(period\) as \(.*r\.invoice_period > step\.period order by r\.invoice_period limit 1/,
    `${file}: the bare call must list the distinct valid periods by SKIPPING from one to the next on the partial index (a recursive loose scan) — an array_agg(distinct ...) over every valid row reads ~406,000 index entries and ~13,900 pages, which came from disk on the hourly run and took about 5 s`,
  );

  assert.doesNotMatch(
    code,
    /array_agg\(distinct invoice_period[^;]*from source_of_sales_import_rows where validation_state = 'valid'/,
    `${file}: the aggregate over ALL valid rows is the 5-second read this migration removed — only the batch branch (where batch_id = p_batch_id) may still aggregate distinct periods`,
  );

  // The skip sits in the bare-call branch, after the batch branch, and before the batches read.
  const batchBranchAt = code.indexOf("batch_id = p_batch_id");
  const skipAt = code.indexOf("with recursive step(period)");
  const batchesReadAt = code.indexOf("select coalesce(array_agg(distinct id), '{}') into v_source_batch_ids");
  assert.ok(
    batchBranchAt >= 0 && skipAt > batchBranchAt && batchesReadAt > skipAt,
    `${file}: the skip-ahead read belongs to the p_batch_id-is-null branch, between the batch branch and the validated-batches read`,
  );

  // Same answer as array_agg(distinct ... order by): ascending, one element per period, and a single
  // trailing NULL when a valid row has no period (array_agg sorts NULLs last).
  const skipSection = code.slice(skipAt, code.indexOf("into v_affected_periods", skipAt) + "into v_affected_periods".length + 60);
  assert.ok(
    (skipSection.match(/r\.validation_state = 'valid'/g) ?? []).length >= 3,
    `${file}: the first probe, the next probe and the NULL-period probe must each read VALID rows only, or the array lists periods the old aggregate did not`,
  );
  assert.match(
    skipSection,
    /r\.invoice_period is not null order by r\.invoice_period limit 1/,
    `${file}: the first probe must skip NULL periods so the recursion starts on a real period`,
  );
  assert.match(
    skipSection,
    /exists \(select 1 from source_of_sales_import_rows r where r\.validation_state = 'valid' and r\.invoice_period is null\) then array\[null::text\]/,
    `${file}: a valid row with no period must still be reported, as one trailing NULL, exactly as array_agg(distinct ...) reports it`,
  );
  assert.match(
    skipSection,
    /order by period\)/,
    `${file}: the periods must come out ascending, as the aggregate returned them`,
  );

  // ── Everything else about the function is what the 9 October migration left ──────────────────
  assert.equal(
    (code.match(/create or replace function/g) ?? []).length,
    1,
    `${file}: one function per file — several guards resolve "the newest migration that defines X" and read the whole file`,
  );
  assert.match(code, /security definer/i, `${file}: it must stay SECURITY DEFINER`);
  assert.match(code, /set search_path to 'public'/i, `${file}: it must keep its pinned search_path`);
  assert.match(code, /set statement_timeout to '60s'/i, `${file}: it must keep its 60 s statement timeout`);
  assert.match(
    code,
    /pg_try_advisory_xact_lock\(v_lock_key\)/,
    `${file}: an hourly tick can land during an import's rebuild — the advisory lock is what makes that safe`,
  );
  assert.match(
    code,
    /revoke execute on function public\.phx_refresh_marketing_roi_facts\(uuid\) from public, anon, authenticated; grant execute on function public\.phx_refresh_marketing_roi_facts\(uuid\) to service_role;/,
    `${file}: the file must end by revoking from public, anon and authenticated and granting service_role alone — a replay on a fresh database would otherwise leave it callable from the browser`,
  );
  assert.match(
    sql,
    /ROLLBACK:\s*re-apply \d{14}_marketing_roi_\w+\.sql/,
    `${file}: the header must name the one-command rollback`,
  );
}
