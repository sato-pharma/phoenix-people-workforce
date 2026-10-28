---
name: pharmacy-database-sync-runs-only-by-hand
description: phx_sync_sales_pharmacy_codes_into_marketing() is never called by the app; the pharmacy database only catches up with the customer map when a session runs it
metadata:
  node_type: memory
  type: project
  originSessionId: 67f15b49-6120-498b-a4bb-a6cae3f7ce6d
  modified: 2026-10-27T20:58:55.160Z
---

`public.phx_sync_sales_pharmacy_codes_into_marketing()` copies every active Source-of-Sales customer-map code into
`marketing_pharmacy_code_references` (`source_file='source_of_sales_customer_map'`). Nothing in `src/` calls it, so
the pharmacy database falls behind the map until a session runs it by hand.

- Run of 2026-08-19 21:43 Cairo: batch `a281791c-…`, 5,518 rows.
- Run of 2026-10-26 18:07 Cairo, made after the Ibn Sina file import: batch `c84d9ccc-6dc5-498d-b438-30b1ac2d413c`, 30,779 rows. That was two months of backlog across every distributor: Ibn Sina 15,041, Overseas 11,954, EGD 1,650, MEC 998, Ramco 773 and the rest. To reverse it, delete by `import_batch_id`.
- Run of 2026-10-27 19:31 Cairo: batch `7b451878-3d83-4155-ac62-71228f66071f`, 42 rows (EGD 38, Ibn Sina 4). The 4 were the last new Ibn Sina pharmacies placed by owner ruling.
- Run of 2026-10-27 19:44 Cairo: batch `7cb8b94b-9d5d-4d4b-b484-f59c06e1790e`, 7,209 rows, after 7,631 archive pharmacies (2024–2025 files of every other distributor, source `owner-archive-files-2026-10-27`, ids in `sos_backup_20261027_archives.inserted_ids`) were mapped. 319 EPDA codes were already in the database, and Sofico Tender (99) is held as a hidden vendor by design.
- Run of 2026-10-27 19:46 Cairo: batch `adb54ea6-0cde-4293-9a65-d91f502f84b1`, 323 rows, after the 326 archive pharmacies placed by district-neighbour suggestion (owner chose "Add the 338 suggested"; source `owner-archive-suggested-2026-10-27`, confidence 70). About 3,100 archive codes with no label, no address match and no loaded sales were left unmapped on his answer.
- Run of 2026-10-27 20:00 Cairo: batch `e3e95cee-4381-4899-9d00-f2114a2da30f`, 254 rows, after the Beshoy 2026 monthly files (owner: "map the Beshoy archives for 2026 too"). Of 40,373 distinct 2026 codes, 300 were new. 233 were mapped from label or address (source `owner-archive-2026-files-2026-10-27`). Another 21 were placed by district neighbours at ≥70% (`owner-archive-2026-suggested-2026-10-27`, confidence 70). 46 had no usable evidence and were left unmapped, among them the 8 Sofico Tender codes. All ids are in `sos_backup_20261027_archives.inserted_ids`.
- Run of 2026-10-27 20:05 Cairo: batch `c2b53f53-32b8-4eaa-a777-eef12c2bee76`, 14 rows. These are 14 of those 46 (Ramco 13, Sofico 1) whose 1–2 mapped neighbours all sit on one brick. The owner chose "Place the 14" (source `owner-archive-2026-suggested-few-2026-10-27`, confidence 70). The remaining 32 were left unmapped on his answer: 2 area-only, 8 Sofico Tender, and 22 with no evidence.
- Run of 2026-10-27 20:16 Cairo: batch `1f370d20-671e-466c-be84-91b4adbbb054`, 184 rows (MEC 54, Ramco 51, EGD 47, Sofico 17, Overseas 12, EPDA 3). The owner said "continue adding more pharmacies". These are archive codes still off the map whose name matches one active, non-suggested map row of ANOTHER distributor on a single brick, with at least 2 shared address words (or the district label agreeing), and no conflicting label (source `owner-archive-namematch-2026-10-27`, confidence 75). 22 were dropped because the twin was a tender or hospital row, or the name was a hospital or authority (هيئة). Left unmapped: 101 with one shared word, 277 matched on name only, and 8 with a conflicting label. A common name repeats across cities, so a name-only match is unsafe.
- Run of 2026-10-27 20:20 Cairo: batch `16c24905-8565-4054-8e71-f20c35c97b5e`, 98 rows (MEC 43, EGD 29, Ramco 24, Sofico 2). The owner chose "Add the 101 one-word": these are name matches sharing exactly one address word, with no district label (source `owner-archive-namematch-weak-2026-10-27`, confidence 65). 3 were dropped as tender, hospital or authority matches. Still unmapped on his answer: 277 name-only matches and 8 conflicting-label matches.
- Run of 2026-10-27 22:39 Cairo: batch `5fca786c-4e98-41ac-b569-e42c907c39a6`, 5,849 rows (Ramco 4,376, Sofico 553, Overseas 499, Ibn Sina 323, MEC 50, EGD 48), after the full-PC sheet scan (owner: "add the pharmacies the scan finds"). The scan found 10,521 codes not on the map, and 5,878 were inserted under these sources: `owner-archive-scan-2026-10-27` 4,511 (label or address, confidence 80/70), `…-suggested-` 743 (3+ neighbours at ≥70%, confidence 70), `…-suggested-few-` 408 (2 neighbours on one brick, 70), `…-namematch-` 146 (75) and `…-namematch-weak-` 70 (65). All ids are in `sos_backup_20261027_archives.inserted_ids`. 29 were already in the database: 24 Ibn Sina from the 22 May workbook and 5 Overseas stored as `0001…` POS codes. Measured on mapped codes by leaving each one out, neighbour placement lands on the right brick 86–92% of the time with 3+ neighbours, 83–84% with 2 and 61–70% with 1. So the 749 one-neighbour codes were held for his answer (scratchpad `w_nb1.json`). The 214 Ramco tender codes, which are Unified Procurement Authority hospitals placed on catch-all bricks (`w_rmt.json`), were also held. 17 label-versus-address conflicts and 3,663 codes with no usable evidence were left off. About 22:45 Cairo he chose "Leave them off" for both held groups (the 749 one-neighbour codes and the 214 tender hospitals), so neither was inserted.
- Run of 2026-10-27 23:15 Cairo: batch `bdeeeae7-8716-4997-92ea-47c9888fbcac`, 17 rows (Ramco 12, EGD 3, Overseas 1, Ibn Sina 1). These were the 17 label-versus-address conflicts. The owner said "place the 17 conflicting pharmacies by their address" (source `owner-archive-scan-address-conflict-2026-10-27`, confidence 70; ids in `sos_backup_20261027_archives.inserted_ids`). For two Zagazig rows the address matcher picked a brick with the same name in Sharkia 2: B101-12 الحسينيه for Ramco 6011003 and B101-13 منشية السادات for Ramco 8000101, a hospital. Block B101 is the Faqous and Husseiniya markaz. Both addresses actually say الزقازيق, so they went on B211-3 الزقازيق (Sharkia 1), which also agrees with their label. A neighbourhood name in an address can match a same-named brick in another markaz, so read the whole address before trusting the matcher.
- Run of 2026-10-27 23:29 Cairo: batch `7c6ae618-496e-4090-b0ac-0e2b6e849cd2`, 15 rows, all Overseas. The owner said "map the pharmacies from the next distributor files". No new sheet had reached the PC or Phoenix since 26 Oct 16:18. The only unmapped pharmacies in uploaded sheets were 74 Overseas `0001…` codes from the Aug and Sep 2026 sheets. 58 of them were already mapped under their 7-digit short code, which the importer and the closing resolve by stripping leading zeros, so they needed no row. Of the other 16, 15 were placed under the short code (source `owner-uploaded-sheets-2026-10-27`, confidence 65–80, ids in `sos_backup_20261027_archives.inserted_ids`). 0001582320 (ش الثلاثين, label الهرم 1) was held because its neighbours split across Talbiya, Omraniya and Haram. 1584775 (صفط اللبن) went by address to B189-6 in GZ2, against its GZ4 label. Umm Khenan has a same-named brick B201-5 in D12 (Quesna, Menoufia), but the Giza Umm Khenan is in Hawamdiya markaz, so 1578761 went on B41-18. Two old `normalizer` rows of 2026-09-18 are wrong. Kayan Pharma 1551496 is on B181-1 Assiut because its address names the Cairo–Assiut road (مصر اسيوط السريع), but its label is البدرشين and its branch W Cairo. حماده جمال 1570257 is on B199-8 Desouq, but its address is سيدي غازي, Kafr El Dawar, and its label is كفرالدوار. The uploaded rows already carry the right area (GZ1 and AB5), so the locked July–September closings are unaffected. About 23:35 Cairo the owner chose "Move both". Map row 758311 went to B194-1 البدراشين (GZ1) and row 756598 to B114-87 كفر الدوار (AB5), with source `owner-ruling-moved-by-label-2026-10-27`, confidence 80. Their pre-images are in `sos_backup_20261027_archives.moved_rows`. The sync never updates a code it already copied, so the two pharmacy-database copies were fixed by hand: ids 126426 and 127948 went from UE/UE4 and D1/D16 to GZ/GZ1 and AB/AB5. Any later move of a mapped code needs the same hand update.
- Audit of 2026-10-27, about 23:00–23:45 Cairo: **408 pharmacy-database copies were stale** (their area or region
  no longer matched the map row the candidate view returns), because the sync never updates a copy it already made.
  - The archive `EP` (EPDA) rows collided with active `EP-PHS` (EPDA-Pharmacies) rows on the same code. The 19:44 key
    check did not treat EP, EP-PHS and EP-BK as one distributor; `aggX.py`/`aggY.py` do (their `G` map → `EP*`).
  - 74 same-shop EP rows were aligned to their twin's brick (source `owner-archive-aligned-to-twin-2026-10-27`,
    pre-images in `sos_backup_20261027_archives.ep_twin_aligned` and `ep_twin_aligned2`). 6 of the first 72 were
    wrong and were restored from the pre-image at 23:40 (22198077, 22198286, 22198366, 22198525, 22198700,
    22199120): the twin had a NULL name, and `a <> b` with a NULL is NULL, so they fell into the "same" group.
    **Guard every name comparison with `coalesce`, and compare the address too** — names vary
    ("- الدقهلية" against "- السنبلاوين" was the same shop, 22198009).
  - 287 copies were refreshed in place (Ibn Sina 192, Overseas 60, EGD 15, EGD Branch 5, EPDA-BULK 4, Overseas
    Tender 3, Ramco 3, EPDA 2, one each EGD Hospital, Ramco Tender, Sofico Tender); full old rows in
    `sos_backup_20261027_archives.ref_area_refresh`.
  - Left at 23:45: 99 stale EPDA copies — 90 are codes EPDA reused. 95 archive EP rows (93 `owner-archive-files`,
    2 `owner-archive-suggested`) carry a 2024–2025 shop on a different area from the shop EPDA-Pharmacies holds the
    code for now; no EP upload uses any of them. The view now answers the old shop for those codes. The other 9 are
    older EP `sheet-verified` rows whose copy agrees with the EPDA-Pharmacies twin, left on purpose. Put to the
    owner as "Deactivate the 95 old-shop EPDA rows".
  - The owner, 23:50: EPDA is the mother company, and EPDA Pharmacies (`EP-PHS`), EPDA Bulk (`EP-BK`) and EPDA
    Hospital are its branches. Uploads agree that they share ONE customer code list: a code in two branches carries
    the same shop name 48 of 49 times (Bulk against Pharmacies) and 6 of 6 (mother against Bulk). Mother against
    Pharmacies agrees only 29 of 44, because codes are reused over time, and almost never in the same month (1).
    So one EP-family code is one pharmacy at a time, and the current holder's place wins.
  - About 23:55 the owner chose "Deactivate the 95". 95 EP rows were set `active = false` (93 `owner-archive-files`,
    2 `owner-archive-suggested`); full rows plus the current twin are in
    `sos_backup_20261027_archives.ep_old_shop_deactivated`, and setting `active = true` by id undoes it. Stale copies
    went from 99 to 9, the 9 older rows left on purpose.
  - About 23:58 the last four uploaded codes with no active map row were placed (`owner-uploaded-sheets-2026-10-27`).
    Three EPDA-Pharmacies rows had been switched off on 18 Sep by the owner's "Under 50% (545)" takeback of weak
    guesses. They were switched back on at confidence 70, on the bricks their uploaded July and August rows already
    carry, so no sales figure moved: ميديكال جروب and نورهان (الهرم, GZ4), الفاروق (الزاوية الحمراء, CA3). MEC 771019
    ص. يسرى رمسيس went in at 80 on أبو قير (AB1), from MEC's own territory text. Pre-images:
    `sos_backup_20261027_archives.uploaded_last4_pre`. Only Overseas 0001582320 is still held, because its
    neighbours are split three ways. No new sheet was on the PC at 23:58.

**Why:** a single "update the pharmacy database" request pulls in ALL map growth since the last run, not only
the file in hand. Report that scope.
**How to apply:** before the run, count candidates not yet synced, then report `references_synced` by distributor. Related:
[[sos-monthly-closing-is-the-only-sales-truth]].
