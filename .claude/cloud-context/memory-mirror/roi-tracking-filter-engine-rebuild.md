---
name: roi-tracking-filter-engine-rebuild
description: "The /admin/marketing-requests/roi-tracking Filter Engine (filter-first executive report + per-request View Sales tab) — BUILT AND LIVE. Holds the reusable RULES it produced: the confidential-product guard must key off product NAME not code, reporting modules must load the directory with includeInactive:true, region is BRICK-authoritative and never falls back to the requester, a customer under a CHILD distributor code is missed by a PARENT join, and any heavy report RPC needs SET statement_timeout + an index matching its join expressions."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6ceaecc2-d940-4a0e-9524-7fa7adc6fef0
  modified: 2026-09-26T11:21:23.614Z
---

`/admin/marketing-requests/roi-tracking` is a **filter-first executive report** ("Filter Engine") plus a
per-request **View Sales** tab — BUILT AND LIVE. On open it renders ONLY the advanced filter panel and loads
nothing until "Apply Filters" (perf); filters are all multi-select, combinable (AND across types), respect
viewer scope, and cover every request type. Shared client `roi-filter-engine.tsx` (3 shells), service
`roi-report-service.ts` (`buildRoiIndex` → rolled-up actuals RPC → KPI band), scope `roi-report-scope.ts`
(`resolveMarketingRoiScope`). Premium multi-sheet XLSX export with a provenance cover + export audit; Phoenix
identity per [[phoenix-pptx-design-reference]], square corners per [[admin-shell-design-rules]].

## The reusable RULES this produced (durable)

- 🔴 **The confidential-product guard MUST key off product NAME, not code.** Marketing products use
  `MKT_PRD####` codes, but the confidential set LA003/LA004/SS001 are SoS codes and the bridge is by NAME — so
  a code-keyed guard is a silent no-op. Use `isRestrictedMarketingProduct` / `restrictedProductNameSet` /
  `normalized_name`. Confidential is CEO/Super-Admin-only in the page AND the export (0 marketing requests
  promote a confidential product today, so this was zero live exposure, not airtight — the NAME guard makes it
  airtight).
- 🔴 **Reporting/historical modules must load the directory with `includeInactive:true`.** An active-only
  `getEmployeeDirectoryRows()` drops departed people, so a request from a departed rep loses its
  region/name/line/manager-chain → "unassigned". Only LIVE-roster modules use active-only. (This does NOT
  widen viewer access scope.)
- 🔴 **Region is BRICK-AUTHORITATIVE and must NEVER fall back to the requester** (a locked rule; a migration
  header forbids it — line-from-requester is allowed, region is not). An "unassigned" region is recovered ONLY
  via real mapped bricks in `source_of_sales_customer_map`, never the requester. On the SMI "Region ROI
  report" (`phx_marketing_roi_customer_dashboard`), "Unassigned" = target pharmacies not yet mapped.
- 🔴 **The distributor-rollup-family join trap:** a customer mapped under a CHILD distributor code (IS-S/EP-S)
  is MISSED when the report joins on the PARENT (IS/EP). Use a rollup-family-aware customer-map lateral
  (parent-preferred, `limit 1`). ROI logic rolls distributors up to parent
  (`phx_marketing_request_roi_actuals` + `marketing_roi_distributor_rollup`).
- 🔴 **Any heavy report RPC needs `SET statement_timeout` (45s is the standard here) AND an index matching its
  join expressions byte-for-byte.** The unfiltered ROI report 500'd because service_role has no
  statement_timeout override (default ~8s) and the attribution RPCs were the only report RPCs missing the
  standard 45s; adding it plus a composite partial-expression index on `source_of_sales_import_rows`
  (`distributor_code`, normalized `client_code`, normalized `product_code`, `invoice_period`)
  `WHERE validation_state='valid'` took the query 16.7s → 0.16s (~105×). Also require ≥1 filter client-side.
- **The never-dead-filter rule:** a filter dimension with ≥2 options renders; 1 option auto-applies and hides
  (shown as a read-only "Auto-applied:" chip); 0 options hides.
- 🔴 **An hr_id is never shown as a name** — seat names resolve to real-name-or-`null` (`?? null`, never
  `?? key`), and a label-less option is hidden from the picker.

## Scope, access and RLS

- Scope: DM = own, NSM = line, exec/CEO/Super Admin = all, PM/GPM = product-centric (reuses
  `canSeeMarketingHierarchyRecord`/`companyMarketingRoles`). The read-only ROI Tracking + View Sales admin
  pages admit CEO + Finance + Financial Advisor via `allowCompanyOversight` (they were locked out though the
  report treats CEO company-wide); admin nav ROI Tracking = [Super Admin, CEO].
- 🔴 **RLS state (corrected 2026-07-27):** all 30 marketing tables are RLS-ENABLED (the rollup carries a
  `_no_direct_access USING(false)` policy, service_role-only grants). **The real risk: 12 TRANSACTIONAL tables
  (incl. `marketing_requests`) are RLS-on with ZERO policies** — fail-closed today, but they still carry
  `GRANT ALL … TO anon`, so one accidental permissive policy exposes full read+write. See
  [[marketing-roi-three-engines-divergence]].

**Data note:** the CRM approval-stage backfill mapped 546 approved steps across 165 imports (positional CRM
row N → REQ-{N}, verified 0/217 mismatch, idempotent + reversible), so the "Approved by" filter offers
CEO / Marketing Manager / NSM / SFE. **Still open (not blocking):** PM/GPM by-line product scope works today;
an explicit owners table is future work.
