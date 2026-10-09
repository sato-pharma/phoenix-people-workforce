---
name: zeroing-is-bonus-turns-free-goods-into-sales
description: Blanking a distributor's is_bonus column makes every free-goods row a sale — and for the September 2026 EPDA-BULK book the owner saw the full difference and ruled "neglect th bonus coloumn", so its 11,398 units are FINAL and must never be "fixed" back to 9,723.
metadata:
  type: project
---

🔴 **SEPTEMBER 2026 EPDA-BULK IS FINAL AS UPLOADED — 73 rows, 11,398 units, 1,158,293.25 EGP, Ivyronc
6,736 in Pedia.** The owner's own words, 9 Oct 2026 ~21:45 Cairo: **"neglect th bonus coloumn"**, after he
was shown the whole difference (+1,675 free units, +75,312.99 EGP, Ivyronc 6,736 against 5,214 with 1,522
free packs in Pedia, the 21 missing flags being the same 21 lines as the 21 extra rows). He re-uploaded the
flag-cleared sheet at 21:46:35 as batch `42f334e2`; the import rebuilt the store-split net by itself nine
seconds later (492 cells, 21:46:44) and the attribution rollup moved to 181,727 units. **Never repair it,
never withdraw it, never put the discrepancy on the needs-you board, in a drift report or in a `Next step:`
line.** Measuring it once was right; raising it again is noise against his ruling.

🔴 **SCOPED TO THAT BOOK AND THAT MONTH.** He neglected the column for that upload — he did NOT retire the
free-goods rule, which still holds for every other distributor, every other month, and a future EPDA-BULK
book that arrives with its flags intact (bonus is never a sale: 2026-09-07, restated 2026-09-18).

**The mechanism, which is the lasting lesson.** The flag is the ONLY thing standing between a bonus row and
the closing, and a cleared column passes in total silence: `rows_ignored` reads 0, `total_bonus_qty` reads 0,
and the header total looks like a clean, complete book. Same file name, same 73 data rows, no flags →
**73 importable rows / 11,398 units** where the flagged version gave **52 / 9,723 / 1,082,980.26**. Only three
September sources carry a bonus at all: EP-BK and EP-PHS (`bonusColumns: ["is_bonus"]`, the only two in
`profiles.ts`, and no DB profile override adds one) and the Direct order template, whose 780 free units are
stored as `bonus_qty` and stay visible. El Qema's `بونص` is deliberately unmapped and every September row is 0.
EPDA-Pharmacies kept its flags through the same evening's re-upload (1,388 rows, 4,585 units, 7 free Ivyronc
units excluded), so the cleared column was specific to the wholesale book.

**How to apply:** read a re-uploaded EPDA book's own `is_bonus` column before trusting its header — a book whose
free-goods rows vanished shows MORE importable rows and a HIGHER total than the one before it. Then stop:
whether that matters is his call, and for September 2026's wholesale book he has already made it.

**History, so nothing reads as live.** The 20:02 batch `282d836b` was withdrawn on his instruction earlier the
same evening (pre-image in `ep_bk_202609_backup_20261009_batch` / `_rows` / `_prodrollup` / `_factrollup` /
`_summaries`), and the store-split net was rebuilt to 449 cells in between (pre-image
`public.msn_202609_backup_20261009`, 492 rows). Both of those are superseded by the 21:46 upload and the
492-cell net — the backups stay only until he says otherwise. See
[[head-office-products-are-not-tracked-weekly-golden-rule]] for why the book's other 4,627 units cost nothing,
and [[a-rebuilt-net-goes-stale-when-an-upload-is-withdrawn]].
