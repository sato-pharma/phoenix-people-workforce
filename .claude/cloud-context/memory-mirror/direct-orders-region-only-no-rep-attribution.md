---
name: direct-orders-region-only-no-rep-attribution
description: "CLOSED GAP — a system direct order (DirectReq, from 2026-08) is counted to its pharmacy's brick and area in the month Finance books it, so its rep/DM is credited (Phase C; 0 achievement drift measured 2026-09-05). Only the retired Excel DIRECT vintage's blank-area rows (Feb–Jun 2026) are region-only, and the owner keeps them that way. Never re-open this or build a proportional region split."
metadata: 
  node_type: memory
  type: project
  originSessionId: e809b225-37bc-4db0-b13f-de36f150f936
  modified: 2026-10-02T16:35:09.917Z
---

**Current state — the gap is CLOSED.** A system direct order (`distributor_code = 'DirectReq'`, the
module, from 2026-08) is counted to **its pharmacy's brick and area in the month the Finance manager
books it** — `phx_rebuild_direct_order_sos_batch(period)` takes `region_code` / `area_code` / `brick_id`
straight from `direct_order_pharmacies`, and `au.f_monthly_achievement` credits direct-with-area to the
(line, area, product) rep row (Phase C, [[direct-orders-phase-c-injection-design]]). Measured on prod
2026-09-05: every booked order carries area + brick, items vs fact rollup exact, achievement stored vs
live **0 drift** ([[direct-orders-are-counted-in-the-month-finance-books-them]], owner golden rule
2026-09-05). Only the **retired Excel `DIRECT` vintage** (2026-01..07; its Feb–Jun rows carry a blank
`area_code = ''`) stays region-only — and the owner ruled 2026-09-06 to keep it invisible to
area-scoped viewers. **Do not
re-open this gap, do not backfill an area onto the old vintage, and do not build option B below.**
**Superseded 2026-10-02:** previously "direct orders attribute at region level only; reps/DMs get ZERO direct share — owner must choose fix A or B" — Phase C direct-with-area attribution (2026-07-19) and the 2026-09-05 golden rule (`direct-orders-are-counted-in-the-month-finance-books-them`).

**Owner-flagged real gap in the God-Mode / automatic monthly closing (2026-07-18), as it stood then:** direct (company) orders are distributed only to REGION, never to area — so **no medical rep and no DM gets any share of direct orders** in their achievement.

**Verified on live prod (`ozucdzovmcqvepbozvqf`):**
- Attribution engine `au.f_monthly_attribution` (migration `20260713014207_au_monthly_attribution_engine.sql`) has 3 branches. **Branch B (direct):** `select 'direct', coalesce(region_code,'NATIONAL'), product_code ... where is_direct group by line, region, product` — **rep_seat_id / dm_seat_id are NOT set** (null). Only indirect (Branch A) rides the (line,area)→seat→rep/dm map.
- Root cause is the SOURCE: `source_of_sales_import_rows` direct rows carry **no area_code** (June: 139 direct rows, 0 have area, 7 regions). The Direct Orders master only knows region (Line 1=Pedia, 2=Anti, General=HO-excluded).

**Materiality (6-mo value EGP, fact rollup):** Pedia direct 4,354,904 = **29.8%** of line; Anti direct 1,262,286 = **25.0%**; CNS direct 0 (CNS has no direct). ≈5.6M EGP of sales credited to no rep.

**How the MANUAL solved it:** manual closing `Type=Discount` rows were typed WITH an Area by hand (Fayoum, Cairo East 1, October-Zayed…) — a human assigned each direct deal to a rep's territory. Phoenix's feed has no such info.

**Fix options as offered on 2026-07-18 — SETTLED, not open:** the system direct-order module took the
A route (each order carries its pharmacy's area and brick); B was never built and must not be.
**Superseded 2026-10-02:** previously "owner must choose the business rule between A and B" — Phase C / the 2026-09-05 golden rule (`direct-orders-are-counted-in-the-month-finance-books-them`).
- A) Capture area/customer→brick at direct-order upload (accurate; needs the file or a person to supply territory).
- B) Model it: split each region's direct across its areas proportional to indirect sales (automated estimate, like the "Stores" model).
- Rule params owner must set: per-product vs per-line; weight by indirect sales / target / equal.

This is the 6th full-god-mode gap, on top of: load target numbers (au.monthly_targets=0 rows), 4 missing SoS product maps (Trencedia/Heal Quick/Lacto LF/Rispadex 2mg), freeze-on-publish snapshot, month-readiness checklist, the god-mode workbook itself. Targets machine + rep/DM attribution (42-area seat model) already BUILT & live (area-unification Phase 5/9). See [[field-sales-3way-report-spec]], [[manual-closing-audit-sos-source-gap]], [[area-unification-42-areas-design]].
