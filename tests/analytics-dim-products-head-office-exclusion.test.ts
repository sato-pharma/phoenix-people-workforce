import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Reported finding (system-wide Head Office audit, 2026-07-25): analytics.dim_products — the
// default, non-privileged product dimension view backing every Analytics dashboard's Line/Product/
// Family filter dropdowns — excluded the 3 restricted product codes but never excluded the
// confidential Head Office line itself. Any role with COMPANY sales scope but not CEO/Super Admin
// (e.g. SFE Manager, per getSalesScope) could see "Head Office" plus its real product names listed
// as a selectable filter option, even though the resulting chart rows were already correctly
// stripped by stripHeadOfficeRows. This migration closes the view-level gap so any consumer of
// dim_products (not just the app's own scopeAnalyticsDimensions path) is protected — the same
// defense-in-depth reasoning access-scope.ts already documents for the restricted product codes.
export function runAnalyticsDimProductsHeadOfficeExclusionTests() {
  const migration = readFileSync(
    "supabase/migrations/20260725180000_analytics_dim_products_exclude_head_office.sql",
    "utf8",
  );

  assert.match(
    migration,
    /CREATE OR REPLACE VIEW analytics\.dim_products AS/,
    "migration replaces analytics.dim_products",
  );

  // Must build on the CURRENT (normalized) base from 20260719153000, not the stale raw
  // pre-normalization text from the original baseline migration — regressing that fix would
  // silently re-open the case/whitespace product_code leak while fixing the Head Office one.
  assert.match(
    migration,
    /upper\(btrim\(COALESCE\(product_code, ''::text\)\)\) <> ALL \(ARRAY\['LA003'::text, 'LA004'::text, 'SS001'::text\]\)/,
    "preserves the existing normalized restricted-product-code exclusion",
  );

  // The new Head Office line exclusion: case/whitespace-insensitive, matching isHeadOfficeLine's
  // key set (head office / headoffice / office / hq) — not a brittle exact-string match.
  assert.match(
    migration,
    /lower\(btrim\(COALESCE\(line, ''::text\)\)\) <> ALL \(ARRAY\['head office'::text, 'headoffice'::text, 'office'::text, 'hq'::text\]\)/,
    "excludes every Head Office line-name variant, normalized",
  );

  assert.match(migration, /AND \(active = true\)/, "keeps the existing active-only filter");

  // dim_products_all (the CEO/Super-Admin "all products" view) must NOT be touched by this
  // migration — it is supposed to keep including the confidential set, same as it already does
  // for the restricted product codes.
  assert.doesNotMatch(
    migration,
    /VIEW analytics\.dim_products_all/,
    "dim_products_all is untouched — it intentionally stays privileged-only, not further restricted",
  );

  // Guard: pure view replacement — no data mutation, no drop, no RLS/grant change (grants on a
  // column-compatible CREATE OR REPLACE VIEW carry over automatically in Postgres).
  const sqlBody = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(
    sqlBody,
    /drop table|truncate|delete from|alter table|disable row level security|grant |revoke /i,
    "migration only replaces the view definition",
  );
}
