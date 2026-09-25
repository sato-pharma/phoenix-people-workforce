---
name: weekly-sales-module-map
description: "Map of the Weekly Sales data module — surface, pipeline, value formula, access tiers, DB tables, gotchas."
metadata: 
  node_type: memory
  type: reference
  originSessionId: b27e6035-d2c5-47a4-8c75-fed9f586c329
---

**Weekly Sales** = distributor weekly sales/stock/returns ingestion → dashboard. DISTINCT from **Weekly Planning/Plans** (`src/lib/weekly-planning/`, `app/api/weekly-plans/`) which is rep visit plans + approvals — same name, unrelated feature. Don't confuse them.

**Surface** (`app/(admin)/sales/weekly/`):
- `/sales/weekly` = Upload & Validate wizard (Verify→Validate→Upload) [`weekly_sales:import`; read-only viewer redirected to dashboard]
- `/sales/weekly/dashboard` = KPIs/charts/trend [`weekly_sales:read`]
- `/sales/weekly/mapping` = 3 tabs Branch→Region · Products · Missing Products via `?tab=` [`weekly_sales:update`]
- `/sales/weekly/assignments` = product scope for PM/GPM/Marketing [`weekly_sales:update`]
- `/sales/weekly/distributor-editor` = column-contract override editor [Super Admin + scope=system + import]
- Legacy `/branch-mapping`,`/product-mapping`,`/missing-products` redirect into `/mapping?tab=`. Tab bar only inside mapping workspace; no top-level tab bar (nav = admin sidebar).

**Pipeline** (`src/lib/sales/weekly/service.ts` + `parser.ts`): `importWeeklySalesFile()` → `parseWeeklyWorkbookBuffer()` (distributor adapter → neutral observations → resolve product+region → aggregate by `(productCode, branchKey)` → fact rows) → `persistWeeklyUpload()` (weekly_sales_batches header + weekly_sales_rows chunked 500, rollback on failure). Wizard: `/verify` (AI headers only, rate-limited), `/validate` (dryRun), `/upload`. Files >4MB stream to Storage via signed URL.

**Core invariants** (`parser.ts`):
- net = authoritativeNet (RM col15 صافى / SF col24) else gross−returns.
- value = net × factory_price; **Direct channel = sheet's own Value column** (parser.ts:1499) — honors price-0 masters like Satoslim. NO discount multiplier (the `weekly_sales_rows.discount` column is dead/legacy).
- Stock = units only (no stock value, by design).
- Mapping-driven: `weekly_sales_product_aliases` (code+name, Arabic-folded normalize) + `weekly_sales_branch_region_map` (PS stock disambiguates dup headers by column index). No alias = soft warning, row stored, **auto-heals** via `healUnresolvedWeeklyRows()`. Unmapped branch (not excluded) / alias→missing master / no price / no line = hard failure. Fail-closed: any failure blocks the whole batch.
- 8 distributors (`distributors.ts`): IS, IS-S (signed sales neg=return), PS/Overseas (TWO files sales+stock matrices), POS (weekly-only matrix), EG (3 sheets), RM (Arabic, authoritative net), SF (authoritative net), Direct (headers by NAME, region-only).
- `column-contract.ts` is a human-readable MIRROR for the Verify/AI-drift step — adapters are the real source of truth, contract does NOT drive parsing.

**Access** (`access.ts`): tiers full / product / territory / none. Restricted **LA003/LA004** stripped for everyone except full+canViewRestricted (CEO/Super Admin + exception HR_IDs admin-hr/b-10/aa). PM/GPM/Marketing Mgr = product scope (`weekly_sales_product_scope`; empty assignment = see nothing). DM/RM/NSM/Rep = territory (reuse monthly line/region; RM-Pedia sees all Pedia regions). Scope applied BEFORE filters so include/exclude can't re-expose confidential.

**DB:** all `weekly_sales_*` are RLS-enabled with NO policies = service-role only (`getSupabaseAdmin`). Live tables: weekly_sales_batches (unique `(distributor,week_start) WHERE status='validated'`), weekly_sales_rows (FK→batches ON DELETE CASCADE), product_aliases, branch_region_map, product_scope, distributor_column_profile (only one with authenticated read policy on active=true). Analytics (Metabase, `analytics_readonly`): `analytics.weekly_fact` view + rollups + `analytics_weekly_fact()` SECURITY DEFINER RPC. Dropped/retired: weekly_sales_pos_region_mappings, weekly_distributor_mapping, weekly_missing_mappings (data migrated in 20260618120000).

**Gotchas:** (1) `app/api/sales/weekly/export-batches` queries Supabase directly — only route bypassing the service layer, and the only export route with no rate limit and no scope/product filtering (it dumps raw batch+product rows for whatever `batchIds` are posted). It was gated on `weekly_sales:read` until 2026-07-01, which let every read-only role (Medical Rep, DM/RM/NSM, PM/GPM) download the unfiltered company-wide workbook incl. LA003/LA004/SS001 — fixed in PR #672 (merged, live in prod) to require `weekly_sales:import` (Super Admin + SFE Manager only, matching sibling `batches/route.ts`). Still no rate limit and still bypasses the service layer — if this route grows more capability, re-check both. (2) Confidential list differs by layer: app strips LA003/LA004; analytics `weekly_fact` view excludes LA003/LA004/**SS001** — confirm canonical set. (3) Ignore `.codex-worktrees/mm-account-hard-rebuild` — stale full copy of the module, not the live tree.

Related: [[ps-weekly-mapping-fix]] [[la003-la004-confidential-products]] [[sales-upload-two-pages-weekly-wizard]] [[sos-brick-authoritative-geography]]
