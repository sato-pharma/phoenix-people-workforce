import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reported finding: analytics.sos_fact, analytics.weekly_fact, and analytics.dim_products (the
// views backing the /employee-portals/sales-analytics dashboards) excluded the confidential
// products (LA003/LA004 "Lacto Basic 1 & 2", SS001 "Satoslim") with a RAW, case-sensitive,
// non-trimmed literal comparison (`product_code <> ALL (ARRAY['LA003','LA004','SS001'])`),
// unlike every other confidential-product guard in this codebase (phx_exec_*/phx_si_* RPCs,
// phx_refresh_sos_fact_rollup's present_nonexcluded flag, every TS check in access-scope.ts),
// which all normalize with upper(btrim(...)) first — because product_code has no DB-level
// CHECK/trigger guaranteeing canonical casing. A differently-cased or whitespace-padded
// product_code would silently defeat the exclusion in these three views while still being
// correctly excluded everywhere else, leaking the confidential value into every SoS/Weekly
// dashboard total without ever surfacing the product's name. This test pins the fix.
export function runAnalyticsConfidentialProductCodeNormalizeTests() {
  const migration = readFileSync(
    "supabase/migrations/20260719153000_phx_analytics_confidential_normalize_product_code.sql",
    "utf8",
  );
  // Strip SQL line comments so the header's explanatory quote of the OLD, buggy pattern doesn't
  // trip the "no unnormalized exclusion remains" guard below — only the live SQL body is checked.
  const sqlBody = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  const normalizedExclusion = /upper\(btrim\(COALESCE\((f|r)\.product_code, ''::text\)\)\) <> ALL \(ARRAY\['LA003'::text, 'LA004'::text, 'SS001'::text\]\)/;

  assert.match(
    migration,
    /CREATE OR REPLACE VIEW analytics\.sos_fact AS/,
    "migration replaces analytics.sos_fact",
  );
  assert.match(
    migration,
    /CREATE OR REPLACE VIEW analytics\.weekly_fact AS/,
    "migration replaces analytics.weekly_fact",
  );
  assert.match(
    migration,
    /CREATE OR REPLACE VIEW analytics\.dim_products AS/,
    "migration replaces analytics.dim_products",
  );

  // sos_fact and weekly_fact: the product_code column is aliased f./r. depending on the view.
  assert.match(
    migration,
    normalizedExclusion,
    "at least one fact view normalizes the product_code exclusion with upper(btrim(...))",
  );
  const matches = migration.match(new RegExp(normalizedExclusion.source, "g")) ?? [];
  assert.equal(matches.length, 2, "both analytics.sos_fact and analytics.weekly_fact normalize the exclusion (f. and r.)");

  assert.match(
    migration,
    /upper\(btrim\(COALESCE\(product_code, ''::text\)\)\) <> ALL \(ARRAY\['LA003'::text, 'LA004'::text, 'SS001'::text\]\)/,
    "analytics.dim_products normalizes the exclusion on the bare product_code column",
  );

  // Guard: every "<> ALL (ARRAY['LA003'...])" exclusion in the live SQL body is immediately
  // preceded by upper(btrim(...)) — no raw/unnormalized comparison remains anywhere.
  const allExclusions = sqlBody.match(/[^\n]*<> ALL \(ARRAY\['LA003'::text, 'LA004'::text, 'SS001'::text\]\)/g) ?? [];
  assert.equal(allExclusions.length, 3, "exactly 3 exclusion clauses (sos_fact, weekly_fact, dim_products)");
  for (const clause of allExclusions) {
    assert.match(clause, /upper\(btrim\(COALESCE\([\w.]+, ''::text\)\)\) <> ALL/, `exclusion clause is normalized: ${clause.trim()}`);
  }

  // Guard: pure view replacement — no data mutation, no drop, no RLS change.
  assert.doesNotMatch(
    sqlBody,
    /drop table|truncate|delete from|alter table|disable row level security|grant |revoke /i,
    "migration only replaces view definitions",
  );
}
