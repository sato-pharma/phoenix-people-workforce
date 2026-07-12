import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Audit finding M3: 17 sales/reference tables carried a blanket `FOR SELECT TO authenticated
// USING (true)` RLS policy, letting any Supabase-Auth-JWT holder read every row directly via
// PostgREST — bypassing the app's canViewRestrictedProducts gate (confidential LA003/LA004/SS001
// + factory_price in sales_product_codes) and the line/region sales scoping over sales_ops_*.
// Verified safe to revoke: none of these tables is read through an RLS-respecting client (only
// SECURITY DEFINER RPCs / the service-role admin client). This test pins that the migration
// removes every one of those over-permissive policies while leaving RLS enabled.
export function runRlsAuthenticatedReadRevokeTests() {
  const migration = readFileSync(
    "supabase/migrations/20260712010000_revoke_blanket_authenticated_read_sales_reference.sql",
    "utf8",
  );

  const revokedPolicies = [
    ["departments_read", "departments"],
    ["marketing_pharmacy_code_refs_authenticated_read", "marketing_pharmacy_code_references"],
    ["outstation_policy_rules_select_access", "outstation_policy_rules"],
    ["sales_area_region_codes_authenticated_read", "sales_area_region_codes"],
    ["sales_distributor_codes_authenticated_read", "sales_distributor_codes"],
    ["sales_ops_dashboard_snapshot_authenticated_read", "sales_ops_dashboard_snapshot"],
    ["sales_ops_distributor_profile_authenticated_read", "sales_ops_distributor_profile"],
    ["sales_ops_rollup_area_product_authenticated_read", "sales_ops_rollup_area_product"],
    ["sales_ops_rollup_by_area_authenticated_read", "sales_ops_rollup_by_area"],
    ["sales_ops_rollup_by_brick_authenticated_read", "sales_ops_rollup_by_brick"],
    ["sales_ops_rollup_by_distributor_authenticated_read", "sales_ops_rollup_by_distributor"],
    ["sales_ops_rollup_by_line_authenticated_read", "sales_ops_rollup_by_line"],
    ["sales_ops_rollup_by_product_authenticated_read", "sales_ops_rollup_by_product"],
    ["sales_ops_rollup_by_region_authenticated_read", "sales_ops_rollup_by_region"],
    ["sales_ops_rollup_leaf_authenticated_read", "sales_ops_rollup_leaf"],
    ["sales_ops_rollup_period_authenticated_read", "sales_ops_rollup_period"],
    ["sales_product_codes_authenticated_read", "sales_product_codes"],
  ] as const;

  for (const [policy, table] of revokedPolicies) {
    const re = new RegExp(`drop policy if exists ${policy} on public\\.${table};`);
    assert.match(migration, re, `migration must revoke ${policy} on public.${table}`);
  }

  // The most security-critical one: sales_product_codes holds the confidential product codes/prices.
  assert.match(
    migration,
    /drop policy if exists sales_product_codes_authenticated_read on public\.sales_product_codes;/,
    "the confidential sales_product_codes read policy is revoked",
  );

  // Guard: this migration must only DROP POLICY — it must not drop/alter tables, columns, or data,
  // and must not disable RLS (which would open the tables to anon, the opposite of the intent).
  assert.doesNotMatch(migration, /drop table|truncate|alter table[\s\S]*disable row level security|delete from/i, "migration must not drop tables/data or disable RLS");
}
