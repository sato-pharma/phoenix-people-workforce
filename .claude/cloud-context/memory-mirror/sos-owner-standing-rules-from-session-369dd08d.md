---
name: sos-owner-standing-rules-from-session-369dd08d
description: "Owner's verbatim standing rules for SoS bricks/blocks/customer-mapping, extracted from session 369dd08d — smallest-brick rule, brick-retirement/hard-delete ruling, merge tiers, Others handling, and the 3 questions still unanswered."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-31T16:22:52.058Z
---

Extracted 2026-07-28 from session `369dd08d-4bde-4f2a-a45a-5ed8b561c2d9`
(= CCD `local_e5b1535e-4689-4f9f-8b04-8844b45136a2`, "SOS master database change", 5,744 msgs).
The owner said he'd "discussed every single detail" there — **read it before asking him anything
about bricks/blocks/mapping.**

## Verbatim rules

- **`U ALWAYS MAP ON THE SAMALLEST BRICK AVAILABLE`** — the single most important rule. He
  corrected the assistant 6+ times toward the *smaller* unit (دمنهور not دمنهور شبراخيت; طما not
  مدينة سوهاج). It's why he rejected `FINAL NEW (3).xlsx`/`(2).xlsx` — they deleted street-level
  bricks.
- **Trust the new over the old:** `law fi admin w gedid hantrust el gedid` → current master wins
  over `Vlookup-Masterrr`.
- **The file outranks his own verbal ruling:** `my aplogy folllow this sheet` (he'd said Sohag city
  → Sohag 2, the sheet said Sohag 1, he backed the sheet).
- **Fix one issue at a time:** `lets fix issue by issue ... donot rush`. Number them, plain English.
- **Matching precedence:** brick → block → area → governorate, LocationIQ LAST. Never address-only.
- **Escalate only low confidence:** `you check as me only is the non cofiedence`.
- Street beats nearby square (`ش الجلاء` > `ميدان رمسيس`); generic street must never beat a city
  (`الزقازيق` > `ش الجيش`); cross-area match → review, **never auto-apply**; a distributor's
  territory label is routing, NOT geography; `DIRECT`/`Office` are out of scope.

## Brick retirement — the rule he reversed 3× (final ruling: hard DELETE)

He first ruled imports were **ADD+UPDATE only** (2026-07-27) — never deactivate a brick to make
room for a replacement. He **reversed it on 2026-07-28**: *"they will mislead me and confuse the
system one day."* Dead bricks are now **hard-deleted**. He was right — duplicate/stale bricks
silently mis-attributing 81,821 units was the whole problem being cleaned up. (A prior memory
titled "never retire bricks" asserted the pre-reversal rule; it was deleted 2026-07-31 because the
title alone misled.)

Both halves still stand, and they are not in conflict:

- **Imports stay additive.** Never retire a brick merely because a new workbook supersedes it —
  every live code the workbook omits stays active and untouched. Modelled against the live DB, a
  replace-and-retire import orphaned 62% of `source_of_sales_customer_map` and 72% of
  `source_of_sales_fact_rollup`; applied additively it orphans **zero**. Accept the resulting
  overlap and resolve it later with a crosswalk, never by deactivating.
- **Genuinely dead bricks get deleted.** Only once there are zero rows in `customer_map`,
  `fact_rollup`, `import_rows` and `customer_directory_rollup`, and zero references from the CRM,
  sales-ops and direct-order tables. ⚠️ both CRM FKs
  (`ireports360_crm_*_brick_resolutions`) are **ON DELETE SET NULL** — a missed reference silently
  nulls a CRM decision instead of erroring. Snapshot every column first.

2026-07-28 result: 227 deleted (1,142 → 915), 3 held back (Office rows still land on them), zero
orphans, grand total unchanged at 1,441,262. The 225 legacy `Vlookup-Masterrr.xlsx` bricks went
only after their sales were merged into current-master twins; 229 unused bricks from his own master
were deliberately **KEPT** — allocated territory with no sales yet is not a dead row.

Two things additive-import does **not** protect, so check on every import: **in-place renames** of
an area/brick code silently re-attribute history (area `D21` "Dakahlia 1" → "Menoufia 2" — give a
new meaning a new code), and **duplicate codes inside the workbook** are still hard PK failures.
See [[sos-duplicate-brick-ids-same-place]], [[sos-always-todays-geography-rule]].

## Merge tiers (his practice, approved repeatedly)

| Same name + … | Action |
| --- | --- |
| same **area** | merge, "no judgement needed" — just do it |
| different **area** | his call, case-by-case |
| different **governorate** | his call — this is the unreturned `SAME_NAME_REVIEW` file |

## Others (OT) — his longest ruling

Others areas are places *"we will never hire in… not vacant areas"*. Their sales go to the **line
total and the NSM only — never to a district manager or medical rep**. IMS for Others is ONE
bucket (4.97%) on the region row, never split per area ([[sos-ims-ratio-storage]]).
He also ruled **`no make the block name others`** for the 12 OT blocks — ⚠️ superseded on 07-28
when he demanded all block names be Arabic; prod now holds Arabic place names and he approved that
master with "go".

## Still unanswered by him (do NOT re-ask casually — these are genuinely open)

1. **`SAME_NAME_REVIEW_2026-07-28.xlsx`** — 35 same-name groups (15 same-governorate, 20
   different). Never returned. `عرب الاطاولة` (UE4 vs UE6) belongs here.
2. **Empty bricks** — 143 with zero customers/sales. Asked twice, never answered.
3. **`fact_rollup` backfill vs clean break** after the sales purge.

## Applied 2026-07-28 from these rulings

`حدايق الاهرام GZ4` — he ruled it, the prior session wrongly claimed no GZ4 brick existed and
skipped it. `B54-40` DOES exist; `B206-4` (GZ7, 39c) merged into it → 50c. Plus 7 other merges
(6 spelling dupes + `ميدان الجيش`→`ش الجيش`). Bricks 704→696, zero orphans.
See [[sos-master-complete-704-applied-2026-07-28]].

⚠️ **`Master of Master.xlsx` is his declared source of truth** — *"the files and folders i was
pasting here where only for fallback"*. Today's master came from his `FINAL NEW (3) - Copy` edits
+ 97 restored places, and he approved it with "go" — but if a conflict ever surfaces, that file is
the arbiter.
