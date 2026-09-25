---
name: d3-over-deletion-and-rebuild
description: "D3 purge over-deleted real bricks; rebuilt 33 from owner's master file. \"Delete D3\" = collapse grouping, NOT delete physical bricks."
metadata: 
  node_type: memory
  type: project
  originSessionId: c7414914-8c57-47c5-ad26-e694ea578860
---

On 2026-06-28 the "destroy all D3 traces" purge (done 06-27) was found to have **over-deleted real geography**: 41 bricks that the Delta (3) carve-out had merely *re-pointed* into region D3 were physically deleted from production, along with the D3 region/areas/blocks. This silently broke the owner's Source-of-Sales uploads — their mapping sheets referenced those (correct) brick IDs, which now blocked as "Brick ID not found in brick master." The brick IDs were never wrong.

**Root lesson:** "remove D3" meant **collapse the D3 grouping back into the original Delta/Cairo/Others regions** (the bricks carry `source_region_code`/`source_area_code` = their true home), NOT delete the physical bricks. A region carve-out re-points existing bricks; deleting `WHERE region_code='D3'` destroys real geography.

**Recovery (shipped):** owner supplied authoritative `phoenix-bricks-master.xlsx` (saved 2026-06-28, D3 already folded out, 360 bricks, 7 regions no D3). Rebuilt production to match: restored 3 Delta areas (D11 Qalubeya→D1, D24 Sharkia 1→D2, D25 Sharkia 2→D2), their blocks (B59-63, B95-99, B100-101), and **33 bricks** folded to home regions (9 CA, 9 D1, 14 D2, 1 OT). The 8 "pending" junk bricks (B61-20, B62-19/20/27/30, B63-67, B100-56, B101-56) were dropped on purpose. Idempotent INSERT … ON CONFLICT DO NOTHING, tagged `source_file='manual:d3_geography_rebuild_from_master'`. Verified 33/33 restored, 33/33 valid block FK, 0 D3 regions/bricks.

**Still needed after rebuild:** the customer→brick map rows for these bricks were also wiped in the prod purge, so the owner must **re-upload their customer/brick mapping sheets** — they now import clean (bricks resolve). See [[sos-brick-authoritative-geography]] and [[delta3-region-carveout]].

**Re-upload progress (2026-06-28, other session):** owner sent `ph.xlsx` (system-generated "Unmapped ROI Target Pharmacies" sheet, 33 rows, brick IDs filled). Mapped all **33/33** into `source_of_sales_customer_map` (distributor_code+customer_code → brick; region/area FROM brick master, owner-typed D3 ignored; source=`roi-unmapped-import`). 31 resolved immediately; the last 2 (B59-15 KALIOUB-BANHA→D1/D11, B96-3 DYARB NEGM→D2/D24) blocked at first because their bricks weren't in prod yet, then resolved minutes later once THIS rebuild session inserted them — live confirmation prod geography was being rebuilt concurrently. `phx_refresh_marketing_roi_facts(NULL)` re-run after. Related: [[marketing-requests-prod-wipe-restore]].

**Staging (izhmxvgiktiafqusolot) D3 removed correctly on 2026-06-28** — done the RIGHT way (collapse, not delete): staging's composite geo FKs are `ON UPDATE CASCADE`, so re-pointing parent areas (`UPDATE areas SET region_code` D11→D1, D24/D25→D2) auto-moved their blocks+bricks; Cairo/Suez bricks (areas D33/D31, blocks B302/B300) were explicitly moved to CA6/B20-38 and OT2/B122; then D3 carve-out blocks (B300/B301/B302) + areas (D31/D32/D33) + region D3 + aliases deleted. All 41 bricks re-pointed IN PLACE (brick_id unchanged) so all 2873 staging customer_map rows stayed valid; customer_map denormalized region/area refreshed off the bricks. Verified 0 D3 anywhere, 0 broken block FKs. 2 pre-existing custmap orphans (B99-2, B19-30) are unrelated to D3.

Composite FK: `source_of_sales_bricks(region_code,area_code,block_code)` → `source_of_sales_blocks(...)`; restoring bricks requires their area+block to exist first. Production blocks table is leaner than staging (no block_name/area_name/region_name columns).
