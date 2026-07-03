import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";

// Proves every Marketing ROI actual-sales path uses identical attribution logic — exact
// customer-code match only, no brick/geography fallback — by reading the migration SQL text
// directly (same "migration readiness" convention as workflow-control-migration-readiness.test.ts).
// This is a static-source lock, not a live-DB test: it prevents a future migration from silently
// reintroducing the fallback path that caused phx_refresh_marketing_roi_facts to disagree with
// phx_marketing_request_roi_actuals / _v2 / phx_marketing_request_view_sales in production.

const FALLBACK_CTE_RE = /\b(fallback_bricks|fallback_hits)\s+as\b/i;
const BRICK_JOIN_RE = /\br\.brick_id\s*=\s*(fb|tp)\.brick_id\b/i;

function migrationsDirUrl() {
  return new URL("../supabase/migrations/", import.meta.url);
}

function allMigrationFiles(): string[] {
  return readdirSync(migrationsDirUrl())
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filenames are YYYYMMDDHHMMSS_name.sql — lexical sort is chronological.
}

/**
 * Resolves the function body Postgres would actually have live today, by scanning every
 * migration in chronological order and keeping the LAST `create or replace function
 * public.<name>(` block found — mirroring how CREATE OR REPLACE actually behaves.
 */
function resolveLatestFunctionBody(funcName: string): { file: string; body: string } {
  const startRe = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${funcName}\\s*\\(`, "i");
  let latest: { file: string; body: string } | null = null;
  for (const file of allMigrationFiles()) {
    const sql = readFileSync(new URL(file, migrationsDirUrl()), "utf8");
    const match = startRe.exec(sql);
    if (!match) continue;
    const rest = sql.slice(match.index);
    // The dollar-quote tag varies across migrations ($func$, $function$, $$, ...) — capture the
    // actual tag used right after `as`, then find that SAME tag's closing occurrence.
    const tagMatch = /\bas\s+(\$[a-zA-Z_]*\$)/i.exec(rest);
    assert.ok(tagMatch, `${funcName}: found CREATE OR REPLACE in ${file} but no dollar-quoted body start`);
    const tag = tagMatch[1]!;
    const afterOpen = rest.slice(tagMatch.index! + tagMatch[0].length);
    const closeIdx = afterOpen.indexOf(tag);
    assert.ok(closeIdx >= 0, `${funcName}: found opening tag ${tag} in ${file} but no matching closing tag`);
    const bodyEnd = tagMatch.index! + tagMatch[0].length + closeIdx + tag.length;
    latest = { body: rest.slice(0, bodyEnd), file };
  }
  assert.ok(latest, `${funcName}: at least one CREATE OR REPLACE FUNCTION found across migrations`);
  return latest!;
}

function assertNoFallbackLogic(body: string, label: string) {
  assert.doesNotMatch(body, FALLBACK_CTE_RE, `${label}: no fallback_bricks/fallback_hits CTE`);
  assert.doesNotMatch(body, BRICK_JOIN_RE, `${label}: no live brick_id-based sales join`);
}

export function runMarketingRoiAttributionConsistencyTests() {
  testCurrentRoiActualsIsExactOnly();
  testCurrentRoiActualsV2MatchesV1ExceptMasking();
  testCurrentViewSalesIsExactOnlyAndReconciles();
  testRefreshFactsFixMigrationRemovesFallback();
  testFastRpcHasNoOwnAttributionLogic();
}

function testCurrentRoiActualsIsExactOnly() {
  const { body } = resolveLatestFunctionBody("phx_marketing_request_roi_actuals");
  assertNoFallbackLogic(body, "phx_marketing_request_roi_actuals");
  assert.match(body, /0::integer\s+as\s+fallback_sales_rows/i, "fallback_sales_rows is hardcoded 0");
  assert.match(
    body,
    /case\s+when\s+coalesce\(actuals\.sales_rows,\s*0\)\s*=\s*0\s+then\s+'no_sales'\s+else\s+'exact_customer'\s+end/i,
    "attribution_quality resolves to only 'no_sales' or 'exact_customer'",
  );
  // Exact customer-code join: distributor rollup + normalized pharmacy code + product code + period + validated.
  assert.match(body, /lower\(btrim\(regexp_replace\(coalesce\(r\.client_code,\s*''\),\s*'\\s\+',\s*' ',\s*'g'\)\)\)\s*=\s*tp\.customer_code/i, "exact client_code match present");
  assert.match(body, /b\.status\s*=\s*'validated'/i, "gates on validated batch");
  assert.match(body, /r\.validation_state\s*=\s*'valid'/i, "gates on valid rows");
}

function testCurrentRoiActualsV2MatchesV1ExceptMasking() {
  const v1 = resolveLatestFunctionBody("phx_marketing_request_roi_actuals");
  const v2 = resolveLatestFunctionBody("phx_marketing_request_roi_actuals_v2");
  assertNoFallbackLogic(v2.body, "phx_marketing_request_roi_actuals_v2");
  assert.match(v2.body, /0::integer\s+as\s+fallback_sales_rows/i, "v2 fallback_sales_rows is hardcoded 0");

  // v2 must carry the masking parameter and apply it only to product resolution.
  assert.match(v2.body, /p_exclude_product_codes\s+text\[\]/i, "v2 accepts p_exclude_product_codes");
  assert.match(v2.body, /upper\(btrim\(sp\.product_code\)\)\s*<>\s*all\(excl\.codes\)/i, "v2 excludes masked product codes from req_products");

  // Same exact-match join predicate as v1 — proves v2 is a masking wrapper, not a different algorithm.
  const exactJoinPredicate = /lower\(btrim\(regexp_replace\(coalesce\(r\.client_code,\s*''\),\s*'\\s\+',\s*' ',\s*'g'\)\)\)\s*=\s*tp\.customer_code/i;
  assert.match(v1.body, exactJoinPredicate, "v1 has the exact-match predicate");
  assert.match(v2.body, exactJoinPredicate, "v2 has the identical exact-match predicate");

  // Same value formula and same validation gates in both.
  for (const shared of [
    /r\.qty\s*\*\s*\(1\s*-\s*coalesce\(r\.discount,\s*0\)\)\s*\*\s*coalesce\(sp\.factory_price,\s*0\)/i,
    /b\.status\s*=\s*'validated'/i,
    /r\.validation_state\s*=\s*'valid'/i,
  ]) {
    assert.match(v1.body, shared, `v1 shares: ${shared}`);
    assert.match(v2.body, shared, `v2 shares: ${shared}`);
  }
}

function testCurrentViewSalesIsExactOnlyAndReconciles() {
  const { body } = resolveLatestFunctionBody("phx_marketing_request_view_sales");
  assertNoFallbackLogic(body, "phx_marketing_request_view_sales");
  assert.match(
    body,
    /lower\(btrim\(regexp_replace\(coalesce\(r\.client_code,\s*''\),\s*'\\s\+',\s*' ',\s*'g'\)\)\)\s*=\s*tp\.customer_code/i,
    "View Sales uses the same exact client_code match",
  );
  assert.match(body, /b\.status\s*=\s*'validated'/i, "View Sales gates on validated batch");
  assert.match(body, /r\.validation_state\s*=\s*'valid'/i, "View Sales gates on valid rows");
  // The function's own comment documents the intent to stay reconciled with roi_actuals.
  assert.match(body, /reconciled/i, "View Sales documents its reconciliation intent with roi_actuals");
}

function testRefreshFactsFixMigrationRemovesFallback() {
  const files = allMigrationFiles().filter((f) => /roi_attribution_consistency/.test(f));
  assert.equal(files.length, 1, "exactly one roi_attribution_consistency migration exists");
  const migrationFile = files[0]!;
  assert.match(migrationFile, /^\d{14}_marketing_roi_attribution_consistency\.sql$/, "filename convention");

  const sql = readFileSync(new URL(migrationFile, migrationsDirUrl()), "utf8");
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.phx_refresh_marketing_roi_facts\s*\(/i, "redefines phx_refresh_marketing_roi_facts");

  const { body, file } = resolveLatestFunctionBody("phx_refresh_marketing_roi_facts");
  assert.equal(file, migrationFile, "this migration is the latest definition of phx_refresh_marketing_roi_facts");
  assertNoFallbackLogic(body, "phx_refresh_marketing_roi_facts");

  // all_hits must resolve to exact_hits only — no union with any fallback set.
  assert.match(body, /all_hits\s+as\s+materialized\s*\(\s*select\s+\*\s+from\s+exact_hits\s*\)/i, "all_hits is exact_hits only, no union");
  assert.doesNotMatch(body, /union\s+all/i, "no UNION ALL remains (that was the fallback-merge point)");

  // attribution_quality collapses to the same 2-branch shape as v1/v2/view_sales.
  assert.match(
    body,
    /case\s+when\s+coalesce\(a\.sales_rows,\s*0\)\s*=\s*0\s+then\s+'no_sales'\s+else\s+'exact_customer'\s+end\s+as\s+attribution_quality/i,
    "request-level attribution_quality resolves to only 'no_sales' or 'exact_customer'",
  );
  assert.match(
    body,
    /when\s+bool_or\(rr\.attribution_quality\s*=\s*'no_sales'\)\s+then\s+'no_sales'\s+else\s+'exact_customer'\s+end/i,
    "customer-fact attribution_quality rollup also collapses to 2 branches",
  );

  // Grants preserved: service_role only, no anon/authenticated/public execute.
  assert.match(sql, /revoke\s+all\s+on\s+function\s+public\.phx_refresh_marketing_roi_facts\(uuid\)\s+from\s+public,\s*anon,\s*authenticated/i, "revokes public/anon/authenticated");
  assert.match(sql, /grant\s+execute\s+on\s+function\s+public\.phx_refresh_marketing_roi_facts\(uuid\)\s+to\s+service_role/i, "grants service_role only");

  // No SoS table DDL and no data-mutating statements against SoS tables.
  assert.doesNotMatch(sql, /alter\s+table\s+public\.source_of_sales_/i, "does not alter any source_of_sales_* table");
  assert.doesNotMatch(sql, /truncate\b/i, "no TRUNCATE");
  assert.doesNotMatch(sql, /delete\s+from\s+public\.source_of_sales_/i, "no DELETE against source_of_sales_* tables");
}

function testFastRpcHasNoOwnAttributionLogic() {
  const { body } = resolveLatestFunctionBody("phx_marketing_roi_fast");
  // The fast RPC must be a pure reader of the pre-computed fact tables — it must never join
  // source_of_sales_import_rows itself (that would mean it computes its own attribution,
  // independently of phx_refresh_marketing_roi_facts, defeating the consistency fix).
  assert.doesNotMatch(body, /from\s+source_of_sales_import_rows/i, "fast RPC never reads raw sales rows directly");
  assertNoFallbackLogic(body, "phx_marketing_roi_fast");
  for (const factTable of [
    "marketing_roi_request_facts",
    "marketing_roi_line_facts",
    "marketing_roi_product_facts",
    "marketing_roi_region_facts",
    "marketing_roi_distributor_facts",
    "marketing_roi_customer_facts",
  ]) {
    assert.match(body, new RegExp(`from\\s+${factTable}\\b`, "i"), `fast RPC reads ${factTable}`);
  }
}
