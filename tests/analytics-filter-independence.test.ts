import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Guards "filters do not change unrelated data incorrectly" (Phase 7 of the analytics
// foundation spec): every analytics_* RPC filter parameter must only constrain its own
// dimension's column. A copy-paste predicate bug (e.g. p_regions accidentally filtering
// product_code instead of region_code) would silently corrupt unrelated dashboard data —
// this pins the exact (parameter -> column) pairing for every filter param so a future
// edit that breaks the pairing fails this test instead of shipping silently.
export function runAnalyticsFilterIndependenceTests() {
  const helpers = readSource("../supabase/migrations/20260625156000_analytics_rpc_helpers.sql");
  const filtersV2 = readSource("../supabase/migrations/20260625160000_analytics_rpc_filters_v2.sql");
  const combined = `${helpers}\n${filtersV2}`;

  // (sql file content, [parameter, column it must — and only it must — constrain])
  const expectedPairings: [string, string][] = [
    ["p_period", "period = p_period"],
    ["p_period_from", "period >= p_period_from"],
    ["p_period_to", "period <= p_period_to"],
    ["p_channel", "channel = p_channel"],
    ["p_lines", "line = any(p_lines)"],
    ["p_distributors", "distributor_code = any(p_distributors)"],
    ["p_regions", "region_code = any(p_regions)"],
    ["p_areas", "area_code = any(p_areas)"],
    ["p_products", "product_code = any(p_products)"],
    ["p_families", "family = any(p_families)"],
    ["p_client_codes", "client_code = any(p_client_codes)"],
    ["p_employee_hr_id", "upper(btrim(employee_hr_id)) = upper(btrim(p_employee_hr_id))"],
    ["p_territory", "lower(btrim(territory)) like '%' || lower(btrim(p_territory)) || '%'"],
    ["p_batch_status", "batch_status = any(p_batch_status)"],
    ["p_batch_id", "batch_id = p_batch_id"],
    ["p_week_start", "week_start = p_week_start"],
    ["p_year", "year = p_year"],
  ];

  for (const [param, predicate] of expectedPairings) {
    // Every occurrence of this parameter inside an "is null or ..." filter guard must
    // pair with its own predicate — i.e. wherever the parameter is used to filter, it's
    // always against the same column.
    const guardPattern = new RegExp(`\\(${param} is null\\s+or\\s+${predicate.replace(/[().|[\]]/g, (c) => `\\${c}`)}\\)`);
    assert.match(combined, guardPattern,
      `${param} must only filter via "${predicate}" — found a different predicate, which means a filter is now reaching across dimensions`);
  }

  // Targeted negative checks for the geo dimensions most likely to be copy-paste-confused.
  assert.doesNotMatch(combined, /p_regions is null\s+or\s+(distributor_code|area_code|product_code)/,
    "p_regions must never filter distributor_code/area_code/product_code");
  assert.doesNotMatch(combined, /p_distributors is null\s+or\s+(region_code|area_code|product_code)/,
    "p_distributors must never filter region_code/area_code/product_code");
  assert.doesNotMatch(combined, /p_products is null\s+or\s+(region_code|distributor_code|line\b)/,
    "p_products must never filter region_code/distributor_code/line");
  assert.doesNotMatch(combined, /p_lines is null\s+or\s+(product_code|region_code|distributor_code)/,
    "p_lines must never filter product_code/region_code/distributor_code");
}
