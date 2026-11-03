import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { stripSqlComments } from "./support/comment-strip.ts";

// Proves every Marketing ROI actual-sales path uses identical CUSTOMER-MATCH attribution logic —
// exact customer-code match only, no brick/geography fallback — by reading the migration SQL text
// directly (same "migration readiness" convention as workflow-control-migration-readiness.test.ts).
// This is a static-source lock, not a live-DB test: it prevents a future migration from silently
// reintroducing the fallback path that caused phx_refresh_marketing_roi_facts to disagree with
// phx_marketing_request_roi_actuals / _v2 / phx_marketing_request_view_sales in production.
//
// A SEPARATE axis — whether a path also includes the 2026-07-19 Phase-D track_direct_sales
// direct-order branch — is NOT yet consistent across every path: phx_marketing_request_roi_
// actuals_v2 and phx_refresh_marketing_roi_facts have it, phx_marketing_request_roi_actuals (v1)
// and phx_marketing_roi_customer_dashboard do not. testCustomerDashboardIsExactOnlyAndLocksDirect
// BranchGap() below pins the latter as a known, tracked gap rather than silently passing either
// way.
//
// RESHAPED 2026-08-09 by 20260809020000_marketing_sales_lines_shared_function.sql. Two of the paths
// this file guards — phx_marketing_request_roi_actuals_v2 and phx_marketing_request_view_sales —
// no longer carry their own copy of the matching rule; they project from the extracted
// phx_marketing_request_sales_lines. Asserting the predicates inline in each of them would now be
// asserting the very duplication that was removed, so the predicate checks moved to
// testSharedSalesLinesCarriesTheOneMatchingRule() and each caller is instead checked for two
// things: that it DELEGATES to the shared function, and that it does NOT join
// source_of_sales_import_rows itself (which would mean it had regrown an independent attribution
// path). The paths that genuinely still compute their own attribution — v1,
// phx_refresh_marketing_roi_facts, phx_marketing_roi_customer_dashboard — are still checked inline,
// against the SAME regexes the shared rule is checked against, so a divergence between the shared
// rule and the independent engines still fails here.

const FALLBACK_CTE_RE = /\b(fallback_bricks|fallback_hits)\s+as\b/i;
const BRICK_JOIN_RE = /\br\.brick_id\s*=\s*(fb|tp)\.brick_id\b/i;

// The one customer-match attribution rule, as a set of regexes. Since
// 20260809020000_marketing_sales_lines_shared_function.sql these predicates live in exactly ONE
// body — public.phx_marketing_request_sales_lines — and phx_marketing_request_roi_actuals_v2 and
// phx_marketing_request_view_sales project from it instead of each carrying their own copy. The
// paths that still compute attribution independently (v1, phx_refresh_marketing_roi_facts,
// phx_marketing_roi_customer_dashboard) must keep matching these inline, which is what proves the
// shared rule did not quietly diverge from them.
const EXACT_CUSTOMER_JOIN_RE =
  /lower\(btrim\(regexp_replace\(coalesce\(r\.client_code,\s*''\),\s*'\\s\+',\s*' ',\s*'g'\)\)\)\s*=\s*tp\.customer_code/i;
const SHARED_ATTRIBUTION_RES = [
  EXACT_CUSTOMER_JOIN_RE,
  // UNITS ARE UNITS (2026-09-07): this pinned `r.qty * (1 - coalesce(r.discount, 0)) *
  // coalesce(sp.factory_price, 0)` until the owner struck the discount factor out of the whole
  // system. A row is now worth qty x factory price, and NO_DISCOUNT_FACTOR_RE below pins the
  // other direction so the factor cannot come back in a body this file already guards.
  //
  // The price SOURCE moved on 2026-09-28: a factory price can now differ by period (Saginko is
  // 111.15 through 2026-09 and 170.52 from 2026-10), so the body may read the product master
  // directly OR public.phx_factory_price(code, period), which resolves an override and falls back
  // to that same master price. Either satisfies what this actually pins — a row is worth qty x A
  // factory price, with no discount factor anywhere near it.
  /r\.qty\s*\*\s*coalesce\((?:sp\.factory_price|public\.phx_factory_price\([^)]*\)),\s*0\)/i,
  /b\.status\s*=\s*'validated'/i,
  /r\.validation_state\s*=\s*'valid'/i,
];
// The factor that was deleted on 2026-09-07. Pinning its ABSENCE matters as much as pinning the
// new formula: the value expression could be rewritten a dozen ways that still satisfy the regex
// above while multiplying the discount back in somewhere else in the body.
const NO_DISCOUNT_FACTOR_RE = /1\s*-\s*coalesce\(\s*r\.discount/i;  // units-are-units:allow

// A caller that merely PROJECTS the shared function must not join the raw sales table itself —
// that would mean it had grown a second, independent attribution path again.
const READS_RAW_SALES_RE = /join\s+public\.source_of_sales_import_rows/i;
const DELEGATES_RE = /public\.phx_marketing_request_sales_lines\s*\(/i;

// Scanned in this order — archive first, then the live directory — because the archive holds
// every migration up to the 2026-07-11 baseline cut (its latest filename timestamp is
// 2026-07-08), and every migration under supabase/migrations/ is chronologically AFTER that cut
// (its earliest is the 2026-07-11 baseline itself). Concatenating each directory's own
// lexically-sorted (= chronological) file list is therefore equivalent to one global
// chronological scan, without needing to merge-sort by timestamp across directories.
const MIGRATION_DIRS = [
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/", import.meta.url),
  new URL("../supabase/migrations/", import.meta.url),
];

type MigrationFile = { dir: URL; name: string };

function allMigrationFiles(): MigrationFile[] {
  return MIGRATION_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort() // filenames are YYYYMMDDHHMMSS_name.sql — lexical sort is chronological within a dir.
      .map((name) => ({ dir, name })),
  );
}

/**
 * Resolves the function body Postgres would actually have live today, by scanning every
 * migration (archive, then supabase/migrations/) in chronological order and keeping the LAST
 * `create [or replace] function public.<name>(` block found — mirroring how CREATE OR REPLACE
 * actually behaves. Both forms are matched because the 2026-07-11 baseline
 * (20260711135352_phoenix_production_schema_baseline.sql) is a pg_dump that defines every
 * function with bare `CREATE FUNCTION`, not `CREATE OR REPLACE FUNCTION`.
 */
function resolveLatestFunctionBody(funcName: string): { file: string; body: string } {
  const startRe = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${funcName}\\s*\\(`, "i");
  let latest: { file: string; body: string } | null = null;
  for (const { dir, name } of allMigrationFiles()) {
    const sql = readFileSync(new URL(name, dir), "utf8");
    const match = startRe.exec(sql);
    if (!match) continue;
    const rest = sql.slice(match.index);
    // The dollar-quote tag varies across migrations ($func$, $function$, $$, $_$, ...) — capture
    // the actual tag used right after `as`, then find that SAME tag's closing occurrence.
    const tagMatch = /\bas\s+(\$[a-zA-Z_]*\$)/i.exec(rest);
    assert.ok(tagMatch, `${funcName}: found CREATE [OR REPLACE] FUNCTION in ${name} but no dollar-quoted body start`);
    const tag = tagMatch[1]!;
    const afterOpen = rest.slice(tagMatch.index! + tagMatch[0].length);
    const closeIdx = afterOpen.indexOf(tag);
    assert.ok(closeIdx >= 0, `${funcName}: found opening tag ${tag} in ${name} but no matching closing tag`);
    const bodyEnd = tagMatch.index! + tagMatch[0].length + closeIdx + tag.length;
    latest = { body: rest.slice(0, bodyEnd), file: name };
  }
  assert.ok(latest, `${funcName}: at least one CREATE [OR REPLACE] FUNCTION found across migrations`);
  return latest!;
}

function assertNoFallbackLogic(body: string, label: string) {
  assert.doesNotMatch(body, FALLBACK_CTE_RE, `${label}: no fallback_bricks/fallback_hits CTE`);
  assert.doesNotMatch(body, BRICK_JOIN_RE, `${label}: no live brick_id-based sales join`);
}

export function runMarketingRoiAttributionConsistencyTests() {
  testCurrentRoiActualsIsExactOnly();
  testSharedSalesLinesCarriesTheOneMatchingRule();
  testCurrentRoiActualsV2MatchesV1ExceptMasking();
  testCurrentViewSalesIsExactOnlyAndReconciles();
  testRefreshFactsFixMigrationRemovesFallback();
  testFastRpcHasNoOwnAttributionLogic();
  testCustomerDashboardIsExactOnlyAndLocksDirectBranchGap();
  testDirectOrdersCountByDefaultButNotForASettlementRequest();
  testCustomerFactsCountEachSaleOncePerCustomer();
  testAnImportRebuildsEveryRequest();
}

// The summary facts are deleted by whole pay month. If an import puts back only the requests whose window
// overlaps its months, the other requests of those pay months vanish from the reports until the next full
// run: EGP 79,951.56 against 88,051.56 on production, 3 November 2026.
function testAnImportRebuildsEveryRequest() {
  const { body, file } = resolveLatestFunctionBody("phx_refresh_marketing_roi_facts");
  const code = stripSqlComments(body).replace(/\s+/g, " ");

  assert.equal(
    (code.match(/into v_affected_ids/g) ?? []).length,
    1,
    `${file}: the batch and the bare call must choose their requests in ONE statement, or the two drift apart`,
  );
  assert.match(
    code,
    /if p_batch_id is null or v_min_period is not null then select coalesce\(array_agg\(distinct id\), '\{\}'\) into v_source_batch_ids from source_of_sales_import_batches where status = 'validated'; select coalesce\(array_agg\(mr\.id\), '\{\}'\) into v_affected_ids from marketing_requests mr where mr\.pay_date is not null; end if;/,
    `${file}: an import must rebuild every request with a pay date, and a batch with no valid period must rebuild nothing`,
  );
}

// Two approved requests by one customer on the same pharmacy and product both claim the same sale.
// Each request keeps its claim, but the customer report adds the customer's fact rows, so those rows
// must hold each sale once: inside one row when the pay months match, and across rows when they differ.
function testCustomerFactsCountEachSaleOncePerCustomer() {
  const { body, file } = resolveLatestFunctionBody("phx_refresh_marketing_roi_facts");
  const code = stripSqlComments(body).replace(/\s+/g, " ");

  const cteAt = code.indexOf("actuals_by_customer_dist as (");
  const cteEnd = code.indexOf("actuals_by_request_geo as (", cteAt);
  assert.ok(cteAt >= 0 && cteEnd > cteAt, `${file}: actuals_by_customer_dist must exist, before actuals_by_request_geo`);
  assert.match(
    code.slice(cteAt, cteEnd),
    /select distinct on \(rr\.customer_id, ah\.match_type, ah\.row_id\).*order by rr\.customer_id, ah\.match_type, ah\.row_id, rr\.pay_month\b/,
    `${file}: one sale per customer, kept under its earliest pay month, or a customer's rows add one sale twice`,
  );

  const insertAt = code.indexOf("ins_customers as (");
  assert.ok(insertAt >= 0, `${file}: ins_customers must exist`);
  const insert = code.slice(insertAt);
  assert.doesNotMatch(
    insert,
    /sum\(rr\.(?:exact|fallback)_sales_rows\)/,
    `${file}: a request's row count repeats once per target pharmacy, so adding it overstates the customer's rows`,
  );
  assert.match(
    insert,
    /max\(coalesce\(acbd\.exact_sales_rows, 0\)\)::integer, max\(coalesce\(acbd\.fallback_sales_rows, 0\)\)::integer/,
    `${file}: the customer's row counts must come from the same once-per-customer rows as its value`,
  );

  assert.match(
    code,
    /actuals as materialized \( select request_id, coalesce\(sum\(sales_value\),0\)::numeric as actual_value/,
    `${file}: a request keeps its own full claim; only the customer roll-up dedupes`,
  );
}

// OWNER, 2026-10-18: a direct order at a campaign's own pharmacy counts in that campaign's ROI with
// nobody switching it on per campaign. The direct branch is still gated on track_direct_sales (the
// two functions above are untouched), so "automatic" is carried by the column's DEFAULT and by the
// one-time switch-on of existing requests. The service-fee settlement request is the exception that
// must stay off: it is not a promotion, and its creator writes the flag FALSE explicitly.
const DIRECT_BY_DEFAULT_MIGRATION = "20261018163217_marketing_direct_orders_count_by_default.sql";

function testDirectOrdersCountByDefaultButNotForASettlementRequest() {
  const live = new URL("../supabase/migrations/", import.meta.url);
  const sql = stripSqlComments(readFileSync(new URL(DIRECT_BY_DEFAULT_MIGRATION, live), "utf8"));

  assert.match(
    sql,
    /alter\s+table\s+public\.marketing_requests\s+alter\s+column\s+track_direct_sales\s+set\s+default\s+true\b/i,
    "a new marketing request must default to counting direct orders",
  );
  assert.match(
    sql,
    /update\s+public\.marketing_requests\s+mr\s+set\s+track_direct_sales\s*=\s*true\s+where\s+mr\.track_direct_sales\s*=\s*false\s+and\s+not\s+exists\s*\(\s*select\s+1\s+from\s+public\.direct_order_marketing_offsets\s+o\s+where\s+o\.marketing_request_id\s*=\s*mr\.id\s*\)/i,
    "existing requests are switched on, except one that settles a direct-order debt",
  );

  // No LATER migration may put the default back to false and quietly turn the feature off again.
  const later = readdirSync(live)
    .filter((f) => f.endsWith(".sql") && f > DIRECT_BY_DEFAULT_MIGRATION)
    .filter((f) =>
      /alter\s+column\s+track_direct_sales\s+set\s+default\s+false\b/i.test(stripSqlComments(readFileSync(new URL(f, live), "utf8"))),
    );
  assert.deepEqual(later, [], "no later migration may restore the opt-in default");

  // The settlement request is created with the flag FALSE explicitly, so the new default never
  // reaches it. If that literal changes, a settlement request would start claiming direct orders.
  const { body } = resolveLatestFunctionBody("phx_admin_settle_service_fee");
  assert.match(
    stripSqlComments(body),
    /v_admin_id,\s*v_admin_id,\s*false,\s*'phoenix'/i,
    "the service-fee settlement request is created with track_direct_sales = false",
  );

  // The matching rule itself did not move: the direct branch is still the one gated place.
  const lines = resolveLatestFunctionBody("phx_marketing_request_sales_lines").body;
  assert.match(stripSqlComments(lines), /where\s+req\.track_direct_sales\s*=\s*true/i, "direct_hits is still gated on the flag");
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

/**
 * The extracted rule itself. Every predicate the two ROI engines used to carry separately must be
 * present here exactly once, together with the Phase-D direct branch and its track_direct_sales
 * guard. If someone weakens the rule, this is now the single place it shows up.
 */
function testSharedSalesLinesCarriesTheOneMatchingRule() {
  const { body } = resolveLatestFunctionBody("phx_marketing_request_sales_lines");
  assertNoFallbackLogic(body, "phx_marketing_request_sales_lines");

  for (const shared of SHARED_ATTRIBUTION_RES) {
    assert.match(body, shared, `shared sales-lines function carries: ${shared}`);
  }
  assert.doesNotMatch(body, NO_DISCOUNT_FACTOR_RE, "the discount factor must not come back — units are units");
  assert.match(
    body,
    /upper\(btrim\(sp\.product_code\)\)\s*<>\s*all\(excl\.codes\)/i,
    "shared function excludes masked product codes from req_products",
  );
  assert.match(body, /p_exclude_product_codes\s+text\[\]/i, "shared function accepts p_exclude_product_codes");

  // Both channels, and only those two.
  assert.match(body, /'retail'::text\s+as\s+channel/i, "shared function emits a retail channel");
  assert.match(body, /'direct'::text\s+as\s+channel/i, "shared function emits a direct channel");
  assert.match(body, /req\.track_direct_sales\s*=\s*true/i, "Phase-D direct branch stays gated on track_direct_sales");
  assert.match(
    body,
    /select\s+\*\s+from\s+retail_hits\s+union\s+all\s+select\s+\*\s+from\s+direct_hits/i,
    "shared function resolves to retail_hits UNION ALL direct_hits only — no other source",
  );

  // The de-duplication that keeps the wider projection from double-counting a sales row which
  // matched several target tuples. Losing it silently inflates sum(value) in the actuals RPC.
  assert.match(
    body,
    /distinct\s+on\s*\(\s*tp\.request_id\s*,\s*r\.id\s*\)/i,
    "retail branch dedupes one row per (request, sales row)",
  );
  assert.match(
    body,
    /distinct\s+on\s*\(\s*mrph\.request_id\s*,\s*dor\.id\s*\)/i,
    "direct branch dedupes one row per (request, direct order)",
  );
}

function testCurrentRoiActualsV2MatchesV1ExceptMasking() {
  const v1 = resolveLatestFunctionBody("phx_marketing_request_roi_actuals");
  const v2 = resolveLatestFunctionBody("phx_marketing_request_roi_actuals_v2");
  const shared = resolveLatestFunctionBody("phx_marketing_request_sales_lines");
  assertNoFallbackLogic(v2.body, "phx_marketing_request_roi_actuals_v2");
  assert.match(v2.body, /0::integer\s+as\s+fallback_sales_rows/i, "v2 fallback_sales_rows is hardcoded 0");

  // v2 must carry the masking parameter and hand it straight to the shared rule.
  assert.match(v2.body, /p_exclude_product_codes\s+text\[\]/i, "v2 accepts p_exclude_product_codes");
  assert.match(v2.body, DELEGATES_RE, "v2 projects from the shared sales-lines function");
  assert.match(
    v2.body,
    /phx_marketing_request_sales_lines\(\s*p_request_ids\s*,\s*p_exclude_product_codes\s*\)/i,
    "v2 passes the exclusion list through to the shared rule rather than re-implementing masking",
  );
  assert.doesNotMatch(v2.body, READS_RAW_SALES_RE, "v2 must not join the raw sales table itself — it delegates");

  // v1 still computes attribution independently, so it must keep the predicates inline; the shared
  // rule v2 now uses must match those SAME predicates. That is what proves the extraction did not
  // change the algorithm — it is the old "v1 and v2 agree" check, routed through the shared body.
  assert.match(v1.body, EXACT_CUSTOMER_JOIN_RE, "v1 has the exact-match predicate");
  assert.match(shared.body, EXACT_CUSTOMER_JOIN_RE, "the shared rule has the identical exact-match predicate");
  for (const predicate of SHARED_ATTRIBUTION_RES) {
    assert.match(v1.body, predicate, `v1 shares: ${predicate}`);
    assert.match(shared.body, predicate, `shared rule shares: ${predicate}`);
  }
  assert.doesNotMatch(v1.body, NO_DISCOUNT_FACTOR_RE, "v1 must not multiply by the discount either");
  assert.doesNotMatch(shared.body, NO_DISCOUNT_FACTOR_RE, "the shared rule must not multiply by the discount either");
}

function testCurrentViewSalesIsExactOnlyAndReconciles() {
  const { body } = resolveLatestFunctionBody("phx_marketing_request_view_sales");
  assertNoFallbackLogic(body, "phx_marketing_request_view_sales");

  // View Sales is now a projection of the shared rule, so the exact client_code match and the
  // validated/valid gates are asserted on that shared body (see
  // testSharedSalesLinesCarriesTheOneMatchingRule) rather than duplicated here.
  assert.match(body, DELEGATES_RE, "View Sales projects from the shared sales-lines function");
  assert.doesNotMatch(body, READS_RAW_SALES_RE, "View Sales must not join the raw sales table itself — it delegates");

  // KNOWN, DELIBERATE GAP: View Sales has never shown Phase-D direct-order sales, so it filters the
  // shared function to retail. This pins that choice — admitting direct rows here would change what
  // the View Sales screen and its XLSX export display, and must be a conscious, separate change.
  assert.match(
    body,
    /channel\s*=\s*'retail'/i,
    "View Sales stays retail-only (update this lock deliberately if the direct branch is ever admitted)",
  );
  // The function's own comment documents the intent to stay reconciled with roi_actuals.
  assert.match(body, /reconciled/i, "View Sales documents its reconciliation intent with roi_actuals");
}

function testRefreshFactsFixMigrationRemovesFallback() {
  const files = allMigrationFiles().filter((f) => /roi_attribution_consistency/.test(f.name));
  assert.equal(files.length, 1, "exactly one roi_attribution_consistency migration exists");
  const migrationFile = files[0]!;
  assert.match(migrationFile.name, /^\d{14}_marketing_roi_attribution_consistency\.sql$/, "filename convention");

  const sql = readFileSync(new URL(migrationFile.name, migrationFile.dir), "utf8");
  assert.match(sql, /create\s+or\s+replace\s+function\s+public\.phx_refresh_marketing_roi_facts\s*\(/i, "redefines phx_refresh_marketing_roi_facts");

  // The attribution-consistency migration need not stay the LATEST definition forever — a later
  // migration may legitimately extend phx_refresh_marketing_roi_facts (e.g. adding another fact
  // table's worth of INSERTs) without reintroducing the fallback path. What must hold, on
  // whichever migration is currently latest, is the substantive guarantee below: no fallback
  // CTEs/joins, and all_hits still resolves to exact_hits only.
  const { body } = resolveLatestFunctionBody("phx_refresh_marketing_roi_facts");
  assertNoFallbackLogic(body, "phx_refresh_marketing_roi_facts");

  // all_hits must resolve to exact_hits, optionally unioned with ONLY the Phase-D direct_hits
  // branch (approved Direct Order Request sales, see 20260719152000_marketing_roi_refresh_facts_
  // direct_branch.sql) — never with any OTHER source. This is a shape-lock, not just a name
  // check: the regex only names exact_hits/direct_hits in this exact structure, so a reintroduced
  // brick/geography fallback branch (whatever it's named) would have to satisfy this same regex
  // and fails closed. The un-narrowed "no UNION ALL anywhere" check this replaces was too strict
  // once Phase-D legitimately added a union; the real invariant — no fallback_bricks/fallback_hits
  // CTE, no brick_id-based join — is what assertNoFallbackLogic (FALLBACK_CTE_RE / BRICK_JOIN_RE)
  // above already guards.
  assert.match(
    body,
    /all_hits\s+as\s+materialized\s*\(\s*select\s+\*\s+from\s+exact_hits\s*(?:union\s+all\s+select\s+\*\s+from\s+direct_hits\s*)?\)/i,
    "all_hits resolves to exact_hits, optionally unioned with direct_hits only — no other source",
  );

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

function testCustomerDashboardIsExactOnlyAndLocksDirectBranchGap() {
  const { body } = resolveLatestFunctionBody("phx_marketing_roi_customer_dashboard");
  assertNoFallbackLogic(body, "phx_marketing_roi_customer_dashboard");
  assert.match(
    body,
    /lower\(btrim\(regexp_replace\(coalesce\(r\.client_code,\s*''\),\s*'\\s\+',\s*' ',\s*'g'\)\)\)\s*=\s*tp\.customer_code/i,
    "customer dashboard uses the same exact client_code match",
  );
  assert.match(body, /b\.status\s*=\s*'validated'/i, "customer dashboard gates on validated batch");
  assert.match(body, /r\.validation_state\s*=\s*'valid'/i, "customer dashboard gates on valid rows");

  // KNOWN GAP (found 2026-07-27, not yet fixed): unlike phx_marketing_request_roi_actuals_v2 and
  // phx_refresh_marketing_roi_facts, this function has NO Phase-D direct_hits branch — so for any
  // track_direct_sales campaign it disagrees with ROI Tracking about the sales total. This matters
  // because phx_marketing_roi_customer_dashboard is the DEFAULT engine behind the Marketing ROI &
  // Customer Intelligence dashboard (getSalesMarketingDashboardSnapshot in
  // sales-marketing-intelligence/service.ts) whenever NEXT_PUBLIC_SMI_USE_FACT_TABLES !== "true"
  // — i.e. in the default/current configuration; only the opt-in fast path
  // (getSalesMarketingDashboardFast -> phx_marketing_roi_fast, reading facts populated by
  // phx_refresh_marketing_roi_facts) sees direct-order sales.
  //
  // This assertion LOCKS today's actual shape (exact_hits only, no union) — it is a deliberate
  // pin, not an endorsement. If a future migration adds a direct_hits branch to close the gap,
  // this specific assertion must be updated in the SAME change: that forced touch is the point,
  // so the gap can't be closed silently without someone re-checking the dashboard-selection logic.
  assert.match(
    body,
    /all_hits\s+as\s+materialized\s*\(\s*select\s+\*\s+from\s+exact_hits\s*\)/i,
    "phx_marketing_roi_customer_dashboard currently has NO direct_hits branch (known gap vs v2/refresh_facts — update this lock if that changes)",
  );
}
