---
name: owner-office-allocation-rule-value-share
description: "The owner's Office allocation rule — Office imported LAST, each area's share of the line's NON-Office value (units x master factory price), one blended share applied to every product; validated 99.78% against his own sheet and NOT what Phoenix does today"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T18:32:52.517Z
---

Stated by the owner 2026-08-10, then validated against his own July CNS workbook.

**THE RULE, in his words:** Office must be imported **last**, after every other distributor for that
line and period. Then take the **line's total sales**, work out **each area's contribution** to it,
and **spread the Office units by that contribution**.

Nailed down precisely:

1. Denominator = the line's **NON-Office** sales value. Excluding Office is what makes it
   non-circular (his Excel appears circular because his share tab is a snapshot).
2. Value = **units × `source_of_sales_products.factory_price`** — his explicit instruction
   2026-08-10: *"neglect the values, you take units and × factory in master database."* Never the
   stored `source_of_sales_import_rows.value`.
3. **ONE blended share per area**, applied to every product's Office units — NOT per product. He
   accepted the consequence that a product's Office units land in areas that sold none of it.
4. Per line. Area level.

**Validation:** feeding his own share column back through the rule reproduces his Stores column to
**96 units out of 42,838 = 0.22%**, and that residual is entirely the EZ-wholesaler area pair.
Weighting by units instead of value is 4x worse (deviation 0.152 vs 0.035), so value is confirmed.

**Phoenix does something completely different today.**
[office-allocation.ts](src/lib/sales/office-allocation.ts) runs at **upload** time and splits each
product's Office units **per product**, **region → brick**, weighted by **units**. All four
dimensions differ. Replacing it means re-stamping every period, because placement is baked into the
stored rows.

Resolved without needing him: Office rows already carry a brick (1,925 rows / 391 bricks in July,
none carry a customer), so allocate to areas by his rule then sub-split within the area — the area
totals his rule specifies come out identical and the row shape stays valid. All 49 CNS areas have
non-Office sales, so nothing divides by zero. CNS has **zero Direct rows**, so "does Direct count in
the denominator" cannot affect CNS — it is open for Pedia/Anti-Infective only (his Pedia weight tab
totals 1,239,039.12, which matches none of his Pedia channels — do not guess).

**July CNS numbers** (2026-08-10, after that day's fixes): denominator **4,128,357 EGP**, Office
**42,838 units** = **41% of the line**. Top share Nasr City 9.90%.

**Sequencing warning:** the share is value-weighted and Tebofortine Forte 80 is 64% of Office volume
with a master price 14% too high — see [[cns-closing-value-inflated-by-wrong-factory-prices]]. The
owner said to proceed anyway.

**THE RULE DOUBLES ANY RETAIL PLACEMENT ERROR — this is the thing to remember.** Office is ~41% of
the line and is handed out on retail value share, so an area whose retail is N units misplaced also
gets its Office share wrong in the same direction by roughly the same amount. Measured live
2026-08-10 on Sohag: retail was ~520 units apart between his sheet and Phoenix, and the area totals
came out ~1,058 apart. **Never read a post-rule area gap as an Office problem without checking the
retail split first** — and never "fix" the rule to chase such a gap. Corollary: shop-placement
rulings are worth about twice their face value once this ships.

**Built and validated end to end 2026-08-10.** Lives in PR #2015 (branch
`codex/office-value-share-allocation`), which after the revert carries only `office-allocation.ts` +
its test; `check:harden` green, 716 test files. Measured against his workbook corrected for the
three defects below: **total absolute area error 12,096 → 3,553 (71% better)**, areas within 100
units 15/44 → 32/44. Sohag 1 +17, Sohag 2 +18, Qena 1 +8, Qena 2 +6, Heliopolis −22, Nasr City +109.
Worst remaining: Alex Center +377, Alex East −308, Down town +272.

**His workbook needed three corrections before it could be compared at all** (all applied to a COPY,
`… ( CNS Line ) CORRECTED.xlsx`; his original is never written to):
1. Area labels differ by CASE — `heliopolis` on 15 rows, `main store` on 1, counted as separate areas.
2. EZ (`1011654`, 13 rows, 2,650 units) sat in Heliopolis against his own ruling.
3. **His Office spread is 378 BAKED rows** (Type `Stores`, one per area × product, blank pharmacy
   code, Distributor `Stores`) — not a live formula. Moving anything on the retail side leaves them
   stale, so they must be recomputed or the comparison is meaningless. His `STORE Calculation` tab is
   a red herring: it spreads only 2,435 units, not the 42,838.

See also [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]],
[[store-sales-split-evenly-across-city-areas]].
