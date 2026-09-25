---
name: direct-orders-region-only-no-rep-attribution
description: "GAP (owner-flagged 2026-07-18) — Direct orders attribute at region level only; reps/DMs get ZERO direct share. ~25% Anti, ~30% Pedia value orphaned."
metadata: 
  node_type: memory
  type: project
  originSessionId: e809b225-37bc-4db0-b13f-de36f150f936
---

**Owner-flagged real gap in the God-Mode / automatic monthly closing (2026-07-18):** direct (company) orders are distributed only to REGION, never to area — so **no medical rep and no DM gets any share of direct orders** in their achievement.

**Verified on live prod (`ozucdzovmcqvepbozvqf`):**
- Attribution engine `au.f_monthly_attribution` (migration `20260713014207_au_monthly_attribution_engine.sql`) has 3 branches. **Branch B (direct):** `select 'direct', coalesce(region_code,'NATIONAL'), product_code ... where is_direct group by line, region, product` — **rep_seat_id / dm_seat_id are NOT set** (null). Only indirect (Branch A) rides the (line,area)→seat→rep/dm map.
- Root cause is the SOURCE: `source_of_sales_import_rows` direct rows carry **no area_code** (June: 139 direct rows, 0 have area, 7 regions). The Direct Orders master only knows region (Line 1=Pedia, 2=Anti, General=HO-excluded).

**Materiality (6-mo value EGP, fact rollup):** Pedia direct 4,354,904 = **29.8%** of line; Anti direct 1,262,286 = **25.0%**; CNS direct 0 (CNS has no direct). ≈5.6M EGP of sales credited to no rep.

**How the MANUAL solved it:** manual closing `Type=Discount` rows were typed WITH an Area by hand (Fayoum, Cairo East 1, October-Zayed…) — a human assigned each direct deal to a rep's territory. Phoenix's feed has no such info.

**Fix (owner must choose the business rule):**
- A) Capture area/customer→brick at direct-order upload (accurate; needs the file or a person to supply territory).
- B) Model it: split each region's direct across its areas proportional to indirect sales (automated estimate, like the "Stores" model).
- Rule params owner must set: per-product vs per-line; weight by indirect sales / target / equal.

This is the 6th full-god-mode gap, on top of: load target numbers (au.monthly_targets=0 rows), 4 missing SoS product maps (Trencedia/Heal Quick/Lacto LF/Rispadex 2mg), freeze-on-publish snapshot, month-readiness checklist, the god-mode workbook itself. Targets machine + rep/DM attribution (42-area seat model) already BUILT & live (area-unification Phase 5/9). See [[field-sales-3way-report-spec]], [[manual-closing-audit-sos-source-gap]], [[area-unification-42-areas-design]].
