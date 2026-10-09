---
name: zeroing-is-bonus-turns-free-goods-into-sales
description: Blanking a distributor's is_bonus column makes every free-goods row a sale — the re-uploaded September EPDA-BULK book put 1,522 free Ivyronc packs (46,230.75 EGP) into Pedia, and the batch header reads 11,398 instead of 9,723.
metadata:
  type: project
---

The free-goods flag is the ONLY thing standing between a bonus row and the closing. 9 Oct 2026,
19:40 → 20:02 Cairo: the September `ساتو قطاع الجملة.xlsx` (EPDA-BULK) was uploaded, withdrawn, edited on
disk at 19:59 so that no row carries `is_bonus` any more, and re-uploaded. Same 73 data rows, same
file name — but batch `282d836b` reads **73 importable rows / 11,398 units / 1,158,293.25 EGP** where
batch `c3e732e2` read **52 / 9,723 / 1,082,980.26**. The difference is exactly the 21 free-goods rows:
**+1,675 units, +75,312.99 EGP.**

What it costs where it is tracked: `source_of_sales_distributor_product_rollup` has September EP-BK
Ivyronc at **6,736** units in **Pedia** across 10 areas, i.e. **1,522 free packs = 46,230.75 EGP**
counted as sales (30.375 EGP/pack). Satoslim's 153 free packs land in Head Office, which is tracked in
neither weekly nor monthly, so they cost nothing — see [[head-office-products-are-not-tracked-weekly-golden-rule]].

**Why:** the owner's rule is that no distributor's bonus is ever a sale (2026-09-07, restated
2026-09-18), and the engine enforces it from ONE cell. A sheet edited to make its own total agree with
the screen silently repeals the rule, and nothing on the Validate screen says so — `rows_ignored` reads
0, `total_bonus_qty` reads 0, and 11,398 looks like a clean, complete book.

**How to apply:** before trusting a re-uploaded EPDA book, read the file's own `is_bonus` column and
compare the batch header: a book whose free-goods rows vanished shows MORE importable rows and a
HIGHER total than the one before it. Only three September sources carry a bonus at all — EP-BK and
EP-PHS (`bonusColumns: ["is_bonus"]`, the only two in `profiles.ts`, and no DB profile override adds
one) and the Direct order template, whose 780 free units are stored as `bonus_qty` and stay visible.
El Qema's `بونص` is deliberately unmapped and every September row of it is 0.
See [[a-closing-rule-that-moves-zero-may-simply-have-no-upload-yet]].
