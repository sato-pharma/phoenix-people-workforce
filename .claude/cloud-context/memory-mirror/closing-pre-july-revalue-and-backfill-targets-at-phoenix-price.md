---
name: closing-pre-july-revalue-and-backfill-targets-at-phoenix-price
description: "Pre-July manual closings are re-valued at Phoenix's CURRENT factory price for BOTH sales and target units, and their target units are backfilled into the empty au.monthly_targets via phx_upsert_monthly_targets. Owner ruling 2026-08-14."
metadata:
  node_type: memory
  type: feedback
  originSessionId: e908adcc-abd2-4e16-9fb1-92d5cb0eeff1
  modified: 2026-08-14T20:20:16.961Z
---

Owner ruling 2026-08-14, while training on monthly closings. Two rules for **every pre-July
(Jan–Jun 2026) manual closing**:

1. **VALUE at Phoenix's CURRENT `source_of_sales_products.factory_price` for BOTH sales units and
   target units** — "our factory price / our known policy", NOT the manual's historical price. Jan
   Anti-Inf: Saginko `SA001` = **111.15** (manual had 126.72), Royafloxacin `RO001` = 60.75 (manual
   60.70, immaterial). **Achievement = sales ÷ target is INVARIANT to the price (it cancels),** so
   only the EGP *value* shifts. A Saginko value side-by-side vs the old manual therefore differs by
   design — do NOT "fix" it back. The 2026-08-11 realignment (126.72→111.15) stands for all months.
   Owner rejected both matching the manual's value and adding period-scoped prices.

2. **BACKFILL the empty historical targets.** `au.monthly_targets` had NO Jan–Jun rows (only
   Jul/Aug/Sep). Take **target units per product** from the manual `Total` sheet, × Phoenix price =
   target value, and upsert via `phx_upsert_monthly_targets(p_rows jsonb, p_actor, p_source)`
   (map-or-reject: area FK to `au.canonical_areas`, must `carries_target`; line FK to `au.lines`).
   "Two in one" — populate the target AND value it on our policy in one pass. The engine that shows
   it: `phx_monthly_targets` + `au.f_monthly_achievement` → `phx_monthly_achievement` → the
   Targets/achievement grid. The closing's `analytics.closing_fact` reads a DIFFERENT target
   (`sales_records.target_*`) — not this table.

**Area mapping** (the pre-July non-unification, [[closing-reconcile-per-customer-product-not-area-pre-july]]):
manual `Total`.`Sys` (old area name) → canonical, by name-match; the hard cases are already ruled by
**`au.area_migration_map`** (Dakahlia 4→D23 merge, Sharkia 3→D25, Faisal & October / Haram → Giza).
Anti-infective has **35** `carries_target` canonical areas incl `CA2`=Nasr City, `CA6`=Cairo West,
`GZ2`=Dokki-Mohandseen, `GZ4`=Haram-Faisal (July only used 30, so don't assume the July subset is the
whole set — read `au_v_line_area_map`). Heal Quick is excluded from targets as it is from sales.

**Jan Anti-Infective — DONE 2026-08-14:** 68 rows, RO001 10,993 u + SA001 8,980 u = **19,974 u /
1,665,998 EGP**, `source='manual-backfill-2026-01'`. Only 3 non-1:1 area calls (Ain Shams→CA3,
Marg→CA4 best-fit; Dakahlia 4→D23 merge) — all preserve region/line/product totals. Reverse with:
`delete from au.monthly_targets where period='2026-01' and line_code='anti_infective' and source='manual-backfill-2026-01';`
Achievement then read 46.3% by value because **actual sales are still Phoenix's SoS 9,516 u** (Direct
short 597, [[direct-orders-pre-july-from-manual-post-august-from-phoenix]]) vs the manual's 10,395 —
the Direct sales reconciliation is the paired half — **DONE 2026-08-14**: actual rose 9,516 -> 10,113 u. Then IBNSINA-POS + EPDA booked 2026-08-14 (owner: "epda [file] & ibnsina-pos in is & overseas"): **IBNSINA-POS 169 -> IS-S** (folded into Ibn Sina, all to IS-S since closing groups by area×product so the split is cosmetic), **EPDA 10 -> EP**, appended to the LIVE batches `8445032d`/`d5811390` (can't make a 2nd validated batch per distributor×period). Actual rose to 10,292 u. Then the last **103** (Overseas PS Saginko) booked 2026-08-14 → **Jan
Anti-Infective is now 10,395 u, UNIT-EXACT AND per-product-exact** (Royafloxacin 5,830, Saginko 4,565)
vs the manual. **The method that cracked the retail residual: reconcile by NORMALIZED PHARMACY CODE
(strip leading zeros), IGNORING area** — the area-level deltas were pure Dakahlia-non-unification
scramble (a red herring). Phoenix client_code `0001583229` == manual Pharmacy Code `1583229`; the
pharmacy sets were identical (721=721, zero overage), so the 103 was a clean add-only across **4
Delta-2 pharmacies** (100 of it in مكه فارم `1583229`: manual 200 / Phoenix 100). Appended
row_number 32883-32886 to LIVE PS batch `cd100eab`, SA001 @ 111.15. **DONE — do not redo/undo.**
Reuse the normalized-pharmacy-code method for every pre-July retail residual (Feb–June, then Pedia/CNS).

**Jan Pedia — DONE 2026-08-14 (same recipe, unit-exact & per-product-exact = 16,677.65).** Counted 4
today-active products ONLY (Ivyronc `IV001`, Guamusin `GU001`, Lacto Advanced 1 `LA001`, Lacto Advanced
2 `LA002`); excluded Lacto LF/Basic (Head Office line), Tigogrow, Dolabactin/Tebofortine. Sales: Direct
replace 7,088 + Office (**Stores→Office** Marcyrl) 556 + EPDA→EP 341 + PS/IS-S retail recon (net) — five
legs sum to 16,677.65 (IV 10,161 / GU 1,977 / LA1 3,322.65 / LA2 1,217). **Lacto price gotcha:** the
manual priced Lacto at **225.06**, Phoenix uses **270** — re-valued at 270 per this rule (units
untouched, only value shifts). Targets: 152 rows (38 canonical areas × 4), `source='manual-backfill-2026-01'`,
= IV 16,462.10 / GU 4,679.72 / LA1 6,332.18 / LA2 3,000.04 (30,474.04 u); achievement grid reads 54.7%
by units. Area merges: Alex Center 1+2→AB2, Dakahlia 3+4→D23, Sharkia 2+3→D25. Reverse sales:
`delete from source_of_sales_import_rows where invoice_period='2026-01' and official_line='Pedia' and raw_row->>'source'='manual-closing-2026-01';`
(**the `official_line='Pedia'` filter is MANDATORY** — batches `cd100eab`/`8445032d` also carry Anti-Inf
rows under the same source tag) then refresh the 5 batch rollups. Reverse targets:
`delete from au.monthly_targets where period='2026-01' and line_code='pedia' and source='manual-backfill-2026-01';`
**DONE — do not redo/undo.** `phx_upsert_monthly_targets` is a plain insert-on-conflict — NO carries_target
or line/area map validation in the function body; area_code/line_code FKs to `au.canonical_areas`/`au.lines`
are the only guardrails, so the caller must map areas correctly (no product FK at all).

**Jan CNS — DONE 2026-08-14 (unit-exact AND per-channel-exact = 79,145).** 1,556 offset rows booked
at **full customer×product×channel grain** (owner chose this over a coarser roll-up), tagged
`raw_row->>'source'='manual-closing-2026-01'`, `kind='cns-recon'`, into the **9 family batches**
(POS→PS, IBNSINA→IS, STORES→Office, EGD→EG, RAMCO→RM, SOFICO→SF, MEC→MC, EPDA→EP, CHIMIPHARM→CP); each
row qty = delta (manual − Phoenix), value = delta × factory_price, `is_direct=false`, row_number above
each whole-batch max. Geography **cloned from real Jan CNS pharmacy rows** via a 3-level fallback
(nc,fam,pc → nc,fam → family-dominant; the last covered only 4 EGD blank-pharmacy-code cells).
Net −278 (Phoenix 79,423 → 79,145). Counted 12 products with sales (CO001 3702, CO002 59, CO003 11233,
CO004 4249, DO002 771, DO003 1044, RI001 4460, RI002 4889, RI003 2931, TE001 1083, TE002 29036, TE003
15688) + TE005 zeroed (a stray +1 removed); 9 channels (POS 25013, IBNSINA 24847, STORES 22757, EGD
3853, RAMCO 1878, MEC 108, SOFICO 637, EPDA 22, CHIMIPHARM 30). **~1,380 of the 1,556 cells were POS
product RE-LABELLING** (UPA/tender reclass RI001↔RI002, RI003↔CO004, TE001↔TE003 — POS pharmacy totals
already matched, only product attribution differed); only ~186 were genuine qty corrections (IBNSINA
−3819, STORES +5995, RAMCO −2500 = a single RM-T tender row zeroed, EGD +112, SOFICO −66). Booked
**atomically in one DO block that RAISEs (rolls back) unless per-product + per-family + grand-total all
equal the manual.** Reverse sales:
`delete from source_of_sales_import_rows where invoice_period='2026-01' and official_line='CNS' and raw_row->>'source'='manual-closing-2026-01';`
then refresh the 9 batches (`phx_refresh_sos_fact_rollup`/`_channel_rollup`/`_customer_directory_rollup`).

**Jan CNS targets — 640 rows, `source='manual-backfill-2026-01'`, `line_code='cns'`.** Owner ruling
2026-08-14 **"Split by actual sales share"**: the CNS manual's `Sales Closing` area rows are a
**coarser, partly-COMBINED field geography that does NOT map 1:1 to canonical areas** (combined
territories Dak-Sharkia-P.D, Ghar-Menoufia-Qal, Ismailia-Suez, Luxor-Aswan, Faisal & October,
Alex-BHR-KFS, Dokki-Mohandsen-Imbaba + buckets Main Store / Others / Cairo Others / Upper Egypt), so
**do NOT force an area→area map here** (unlike Anti-Inf/Pedia). Instead each product's manual GRAND
target (from the `Sales Closing` sheet's *Target Units* columns, NOT `Total`) is distributed across
Phoenix areas by that product's **actual Jan-CNS sales share, positive-part normalized** (weight =
`greatest(net_units,0)` ÷ per-product sum → shares sum to 1, no negative target). The 3 products with a
target but zero actual sales (TE004, TE005, DO001) split by their **therapeutic-family** actual share
(Tebofortin family TE001+TE002+TE003 for TE004/TE005; DO002 for DO001). Per-product totals EXACT vs
manual; grand **260,596.59 u / 19,595,451.67 EGP** at Phoenix price (15 products incl TE004 @150.90,
TE005 @124.342105, DO001 @35.70). Reverse targets:
`delete from au.monthly_targets where period='2026-01' and line_code='cns' and source='manual-backfill-2026-01';`
**DONE — do not redo/undo.** psql was dead (stale `SUPABASE_DB_URL` password) so the whole thing ran via
MCP `execute_sql`; staging lived in `au.zz_cns_*` (dropped after).

**Feb Anti-Infective — DONE 2026-08-14 (unit-exact AND per-channel-exact = RO001 5,409 + SA001
4,620 = 10,029).** File `F:\Sales Closing\Feb\Jan-Feb 2026 Sales Closing ( Anti-Infective ) Final  .xlsx`
(two spaces before `.xlsx`). **Month-label trap: the `Total` sheet's `Month` column says "Jan" but the
data IS February** (proved via Heliopolis Saginko=60 matching the Feb summary + Data sheet, not Jan).
Authoritative grand from `Total` sheet: RO001 sales 5,409 / target 11,317.5; SA001 sales 4,620 / target
9,446.2 (all Retail; Stores=0). **Manual `Total` labels RO001's family "Dolabactin"** — a manual quirk;
the numbers (5,409 / 11,317.5) tie to RO001 (Royafloxacin), so Dolabactin-family → RO001. Only **8
offset rows** were needed (IBNSINA→IS-S 2,990 and EPDA→EP-PHS 14 were already unit-exact — untouched):
**DIRECT** (is_direct=true, blank area, region Delta(1)/D1) into LIVE batch `83e1a328` rows 87-88:
RO001 **+175**, SA001 **−42**; **PS** into LIVE batch `48e1ec94` rows 23479-23484: RO001 +10 & SA001 +10
(blank-code pharmacy, Menoufia 2/D13), SA001 +8 (code 1577318, Dakahlia 1/D21), SA001 −2/−1/−1 (codes
1552485/1518962/1576748, Minia 2/UE2). Booked **atomically in one DO block that RAISEs (rolls back)
unless per-family + per-product + grand all equal the manual**, tagged `raw_row->>'source'='manual-closing-2026-02'`
(kind `ai-direct-recon`/`ai-ps-recon`). Closing surface verified: `phx_monthly_closing_matrix('Anti Infective','2026-02')`
retail (RO 3,275 / SA 3,992) + Direct (RO 2,134 / SA 628) = manual exactly. Reverse sales:
`delete from source_of_sales_import_rows where invoice_period='2026-02' and official_line='Anti Infective' and raw_row->>'source'='manual-closing-2026-02';`
then refresh batches `83e1a328` + `48e1ec94` (`phx_refresh_sos_fact_rollup`/`_channel_rollup`/`_customer_directory_rollup`).
**Feb Anti-Inf targets — 67 rows, `source='manual-backfill-2026-02'`, `line_code='anti_infective'`.**
Used the **name-map (NOT sales-share)**: measured that the manual `Total`'s 9 unmappable buckets (Main
Store, Cairo Others, Giza Others, Down town, Qal, Ismailia-Suez, Luxor-Aswan, October-Zayed) all held
**ZERO** target, so 100% of target mass fell in the 35 cleanly-mappable canonical areas — same clean case
as Jan Anti-Inf (Dakahlia 4→D23 merge). At Phoenix price: RO001 11,317.5u / 687,538.14 EGP, SA001 9,446.2u
/ 1,049,945.17 EGP. Reverse targets:
`delete from au.monthly_targets where period='2026-02' and line_code='anti_infective' and source='manual-backfill-2026-02';`
**DONE — do not redo/undo.**

**Feb Pedia — DONE 2026-08-14 (unit-exact per product & per channel = GU 1,152.5 · IV 27,476 · LA1
4,602 · LA2 1,665 = 34,895.5).** File `...( Ped Line ) Final  .xlsx` (TWO spaces). Counted 4 today-active
(IV001/GU001/LA001/LA002). **18 offset rows** tagged `raw_row->>'source'='manual-closing-2026-02'`, booked
atomically (per-product + per-channel + grand asserts, RAISE-rollback). Batches: DIRECT `83e1a328`, EP-PHS
`98ec7978`, IS-S `c2f37770`, PS `48e1ec94`. **Military Ivyronc = 14, Main Store only** ([[ivyronc-military-price-is-14-main-store-only]]):
a 20,000-u Main Store depot order mis-booked under PS was reclassed PS→Direct and split into a military row
(20,000@14) + regular (935@30.375); Direct-IV units unchanged (22,990). Reverse sales:
`delete from source_of_sales_import_rows where invoice_period='2026-02' and official_line='Pedia' and raw_row->>'source'='manual-closing-2026-02';`
(**`official_line='Pedia'` filter MANDATORY** — `83e1a328`/`48e1ec94` also hold Feb Anti-Inf under the same tag)
then refresh those 4 batches. Targets: 149 rows, `source='manual-backfill-2026-02'`, `line_code='pedia'`
(IV 18,720.474 / GU 5,074.08 / LA1 5,996.8094 / LA2 2,941.006 u; value 3,290,094.91). Reverse targets:
`delete from au.monthly_targets where period='2026-02' and line_code='pedia' and source='manual-backfill-2026-02';`
**DONE — do not redo/undo.**

**Feb CNS — DONE 2026-08-14 (unit-exact per product AND per channel = 106,618.5).** File
`...( CNS Line ) Final .xlsx` (SINGLE space). 12 counted products (CO001-004, DO001-003, RI002-003, TE001-003);
RI001 has a target but ZERO sales, TE005 nets to 0. CNS has NO Direct and NO military/Main-Store line. Phoenix
was OVER by **+1,630.5** (108,249 vs 106,618.5) — two real stories: an IBNSINA→Office(Stores) reclass ~2,800 u,
and a genuine DO001 UPA drop −1,470 (Phoenix carried 1,595 in the PS-T tender; manual counts 125); the rest were
within-channel product relabels netting ~0. **1,074 offset rows** tagged `raw_row->>'source'='manual-closing-2026-02'`,
`kind='cns-recon'`, total qty EXACTLY −1,630.5, booked atomically (grand + per-(channel×product)-cell asserts,
RAISE-rollback). Method = **proportional-area-spread**: each differing cell's diff spread across areas by Phoenix's
own sub-channel×product area distribution, residual to the top-share area (areas are pre-July scramble, NOT
reconciled at area grain). Tender fold: PS-T→P.O.S, IS-T→IBNSINA, EG-BR & EG-HOS→EGD. 9 batches: CP `a3ed0339`,
EG `3d2c32ee`, EP `3ecbbe97`, IS `c61c2ab9`, MC `8ef6aa71`, Office `e1168a0e`, PS `48e1ec94`, PS-T `eb48b4d2`,
RM `5057dc96`. Verified live: 12 products exact, 8 channels exact (CP 37 · EG 3,076 · EP 5 · IS 30,294 · MC 59 ·
Office 50,121 · PS 19,041 · RM 3,985.5), grand 106,618.5. Reverse sales:
`delete from source_of_sales_import_rows where invoice_period='2026-02' and official_line='CNS' and raw_row->>'source'='manual-closing-2026-02';`
(**`official_line='CNS'` filter ESSENTIAL** — `48e1ec94` also holds Feb Pedia + Feb Anti-Inf under the same tag)
then refresh those 9 batches. Targets: 545 rows, `source='manual-backfill-2026-02'`, `line_code='cns'`, manual
grand 141,540 u → 10,014,595.51 EGP at Phoenix price; owner ruling "split by actual sales share" (each product's
target spread by its own positive actual area share from `phx_monthly_closing_matrix`; **RI001** 14,000/0-actual
spread by Rispadex family RI002+RI003). Reverse targets:
`delete from au.monthly_targets where period='2026-02' and line_code='cns' and source='manual-backfill-2026-02';`
**DONE — do not redo/undo.**

Ledger: scratchpad `closing-ingest-ledger.md`. Related:
[[closing-reconcile-per-customer-product-not-area-pre-july]]
[[closing-retail-value-is-units-times-factory-price]]
[[sos-monthly-closing-is-the-only-sales-truth]].
