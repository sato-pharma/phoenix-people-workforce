import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripSqlComments } from "./support/comment-strip.ts";

// SQL-layer defects behind wrong customer totals and stale attribution. These are DB functions, so
// the convention here is a source-text assertion over the migration that defines them (the same
// shape as tests/report-rpc-guardrails.test.ts and the secdef revoke guard).
//
// Verified against production before the fix:
//   - Direct priced at list rather than its stored value, by period:
//       2026-01 +64,872  2026-02 +66,254  2026-03 +276,690  2026-04 -108,154  2026-06 +191,437
//     Note it errs BOTH ways, so it cannot be dismissed as a rounding bias.
//   - 1,698 import rows disagree with the active customer map; 154 sit in a different AREA, i.e. a
//     different rep (585,776 EGP).

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function migrationSource(nameFragment: string): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(nameFragment));
  assert.ok(file, `migration containing "${nameFragment}" must exist`);
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

function code(source: string): string {
  return stripSqlComments(source).replace(/(^|[^:])--[^\n]*/g, "$1");
}

export function runSosRollupSqlTruthTests() {
  const sql = code(migrationSource("sos_rollup_and_closing_sql_truth"));

  // ── Direct is priced as Direct, not re-priced at list ───────────────────────
  {
    const fn = sql.slice(
      sql.indexOf("function public.phx_closing_customers"),
      sql.indexOf("revoke execute on function public.phx_closing_customers"),
    );
    assert.ok(fn.length > 0, "phx_closing_customers must be defined in this migration");
    assert.match(
      fn,
      /when coalesce\(f\.is_direct, false\) then coalesce\(f\.direct_value, 0\)/,
      "Direct rows must use their stored value, the same branch analytics.sos_fact uses",
    );
    assert.match(
      fn,
      /else f\.effective_units \* coalesce\(p\.factory_price, 0\)/,
      "distributor rows keep the factory-price calculation",
    );
    // CREATE OR REPLACE silently drops these; 20260728100500 exists because that already happened.
    assert.match(fn, /set statement_timeout to '45s'/i, "statement_timeout must be re-declared");
    assert.match(fn, /set search_path to 'public'/i, "search_path must be re-declared");
  }

  // ── Backfill reports which batches it touched ──────────────────────────────
  {
    assert.match(
      sql,
      /drop function if exists public\.sos_backfill_import_rows_from_customer_map\(text, text\);/,
      "a return-type change needs a DROP, not CREATE OR REPLACE",
    );
    assert.match(
      sql,
      /returns table\(updated_rows integer, affected_batch_ids uuid\[\]\)/,
      "the caller cannot refresh the rollup without the batch ids",
    );
    assert.match(
      sql,
      /and r\.brick_id is null/,
      "unchanged scope: this fills a MISSING brick, it never re-points an existing one",
    );
  }

  // ── The rollup must not count failed rows ──────────────────────────────────
  {
    const refresh = sql.slice(sql.indexOf("function public.phx_refresh_sos_fact_rollup"));
    const occurrences = (refresh.match(/coalesce\(r\.validation_state, 'valid'\) <> 'failed'/g) ?? []).length;
    assert.equal(occurrences, 2, "both the fact rollup and the presence rollup must exclude failed rows");
  }

  // ── The period-drift landmine is monitorable ───────────────────────────────
  {
    assert.match(
      sql,
      /function public\.phx_sos_period_drift_count\(\)/,
      "the invoice_period vs batch period drop is left in place deliberately, so it must be countable",
    );
    assert.match(sql, /r\.invoice_period, '~'\) <> coalesce\(b\.period, '~'\)/, "drift is measured, not guessed at");
  }

  // ── Every new/redefined secdef function revokes PUBLIC execute ─────────────
  for (const fn of [
    "phx_closing_customers",
    "sos_backfill_import_rows_from_customer_map",
    "phx_refresh_sos_fact_rollup",
    "phx_sos_period_drift_count",
  ]) {
    assert.ok(
      new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\)[\\s\\S]{0,80}from public, anon, authenticated`).test(sql),
      `${fn} must revoke EXECUTE from public/anon/authenticated`,
    );
  }

  // ── The caller actually refreshes ──────────────────────────────────────────
  {
    const mapping = code(readFileSync(join(process.cwd(), "src/lib/sales/normalizer/mapping.ts"), "utf8"));
    assert.match(
      mapping,
      /affectedBatchIds\.set\(value, brickId\)/,
      "backfillCustomerRows must collect the batches the RPC reports",
    );
    // The rebuild itself is the shared `refreshBatchRollups` (customer-map.ts), which calls the trio
    // and every rollup after it and checks each result — never a hand copy here (audit P4-05).
    assert.match(mapping, /refreshBatchRollups/, "backfill must rebuild through the shared refreshBatchRollups");
    const customerMap = code(readFileSync(join(process.cwd(), "src/lib/sales/normalizer/customer-map.ts"), "utf8"));
    for (const rpc of [
      "phx_refresh_sos_fact_rollup",
      "phx_refresh_sos_customer_directory_rollup",
      "phx_refresh_marketing_roi_facts",
    ]) {
      assert.ok(
        customerMap.includes(rpc),
        `refreshBatchRollups must refresh ${rpc}`,
      );
    }
    assert.match(
      mapping,
      /typeof data === "number"/,
      "must still accept the pre-migration integer return so a deploy ahead of the migration degrades safely",
    );
  }
}
