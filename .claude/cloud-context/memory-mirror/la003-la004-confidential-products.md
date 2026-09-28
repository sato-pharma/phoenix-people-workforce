---
name: la003-la004-confidential-products
description: "LOCKED RULE — LA003 + LA004 (\"Lacto Basic 1 & 2\") and SS001 (\"Satoslim\") sales, in EVERY form (totals, KPIs, charts, tables, filter lists, exports, per-product breakdowns, weekly and monthly), are visible ONLY to CEO + Super Admin. Single source of truth is src/lib/sales/access-scope.ts. Two traps: the app ALWAYS passes the explicit exclude list (the TS constant), which OVERRIDES the geo-RPC default — so bumping the DB default alone does nothing; and the TS-layer guard does NOT protect BI/Metabase (analytics_readonly) direct-SQL access, which is a SEPARATE surface needing its own audit."
metadata:
  node_type: memory
  type: project
  originSessionId: 0301d2f4-3c83-41bf-a608-5416a288ebee
  modified: 2026-09-26T00:19:59.027Z
---

## The locked rule (owner, critical — 2026-06-19)

Products **LA003**, **LA004** ("Lacto Basic 1 & 2") and **SS001** ("Satoslim") — their sales in **every
form** (weekly, monthly, totals, KPIs, charts, tables, filter lists, exports, per-product breakdowns,
anything derived) are visible **ONLY to CEO and Super Admin**. Every other role must never see them.
These products are **~80% of Source-of-Sales value**, which is why the lock matters.

## Single source of truth — `src/lib/sales/access-scope.ts`

- `RESTRICTED_PRODUCT_CODES = ["LA003","LA004","SS001"]` and
  `RESTRICTED_PRODUCT_NAME_FALLBACKS = ["lacto basic 1","lacto basic 2","satoslim"]`.
- **To add another confidential product:** add its CODE to `RESTRICTED_PRODUCT_CODES` and its normalized
  NAME to `RESTRICTED_PRODUCT_NAME_FALLBACKS`. That auto-propagates to the SoS dashboard, weekly, the SI
  RPCs (via `p_exclude_codes`) and the SMI name-strip. Optionally bump the geo-RPC default in a migration
  — **defense-in-depth only.**
- `canViewRestrictedProducts(role)` is true only for CEO / Super Admin; `isRestrictedProductCode` tests a
  code. CEO/admin **always** see these products — there is no opt-in toggle wired anywhere.

🔴 **THE TS CONSTANT IS WHAT COUNTS, NOT THE DB DEFAULT.** The app always passes the **explicit** exclude
list (= the TS constant) into the RPCs, and that **overrides** any geo-RPC default. So bumping the DB /
geo-RPC default alone does NOTHING — SS001 once leaked through every app path while the DB default already
listed it, because the TS constant still read `["LA003","LA004"]`. Change the TS constant.

## Two pipelines need two kinds of guard

- **Source-of-Sales / SI** (`source_of_sales_*`) is keyed by CODE — code guards reach it.
- **Legacy Sales** (`sales_records`) has NO `product_code` column, keyed by product NAME — code guards
  can't reach it, so it needs NAME guards: `restrictedProductNameSet()` (live master names ∪ the
  fallbacks, **fail-closed**, 5-min cache), `stripRestrictedRowsByName`, `stripRestrictedProductNames`,
  `normalizeProductNameKey`. `tests/sales-restricted-products.test.ts` pins the two-pipeline guard.

**Geo aggregates re-derive, they don't just filter rows.** For a non-CEO viewer, grand totals are
re-derived from the non-restricted product-summary rows, and region/area/brick totals come from a
server-only RPC `phx_sos_geo_aggregates_without_restricted(p_batch_ids, p_exclude_codes)` that
re-aggregates the raw import rows excluding the codes (`security definer`, **revoked from PUBLIC** — not
just anon/auth, since Postgres default-grants EXECUTE to PUBLIC — service_role + postgres only). The
marketing-ROI RPC takes `p_exclude_codes` via `resolveMarketingExcludeCodes(role)`; filtering its
`req_products` **re-normalizes value_share**, so a hidden product's marketing-cost share reallocates to
its visible siblings (a decided behavior, zero-impact today — no marketing request promotes a restricted
product).

## 🔴 The BI / Metabase surface is SEPARATE — audit it on its own

The `access-scope.ts` lockdown covers the in-app TypeScript layer thoroughly, but **BI/analytics-schema
RPCs added for Metabase are a different surface with no shared enforcement point, and the TS guard does
not protect direct-SQL/Metabase access at all.** A real login role `metabase` (`rolinherit=true`) is a
member of `analytics_readonly` and inherits its grants automatically, so anyone with the Metabase
connection creds could pull confidential data through any granted RPC that doesn't filter. Two failure
shapes seen: (1) RPCs granted to `analytics_readonly` whose bodies **never filtered** the codes (the
grant comment claimed "handles confidential filtering internally" — it didn't); (2) an RPC that HAS
`p_exclude_codes` but **defaults it to `'{}'`**, so a Metabase question that omits the arg gets
everything. **Any new `phx_*` or `analytics.*` object granted to `analytics_readonly` needs its own
confidential-code audit** — either hard-code the exclusion into the body, or expose a no-override wrapper.

**Verification lesson:** re-verify a pasted security finding against current migration history AND live
grants before acting — one claimed leak (`analytics.sos_fact_all`/`dim_products_all` granted to
`analytics_readonly`) had already been fixed by a later migration and was stale.

Related: [[source-of-sales-rebuild-rules]], [[sos-brick-authoritative-geography]],
[[match-module-design-before-building-ui]].
