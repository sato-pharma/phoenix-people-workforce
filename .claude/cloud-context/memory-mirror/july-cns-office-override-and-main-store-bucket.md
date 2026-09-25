---
name: july-cns-office-override-and-main-store-bucket
description: "REVERSED 2026-08-26 — the owner ordered the golden rule RE-RUN for July CNS Office, overwriting his 2026-08-12 spread; OTMS lost its 472 Office units (his parked tender rows STAY). Read the reversal block before acting on anything below it."
metadata: 
  node_type: memory
  type: project
  originSessionId: ff721f65-99c8-4ef2-92f2-305a08d0d465
  modified: 2026-08-28T09:58:35.128Z
---

## ⛔ REVERSED BY THE OWNER 2026-08-26 — read this before the 2026-08-12 record below

He was shown the exact cost of re-running (OTMS loses its 472 units, Giza 6 drops 964→412, the eight
areas he zeroed get units back) and **chose "Re-run the rule for July"** anyway, so July CNS Office
is now the **golden rule's EZ-aware output**, not his sheet spread. Everything from "Owner order
2026-08-12" onward is a **historical record of a state that no longer exists** — kept because it
explains where OTMS came from and why the parked rows are where they are.

**What is still true:** OTMS remains a real active area, and **his 154 parked tender rows are
untouched** — measured live after the re-run at **153 rows / 1,069 units**, and they live in the
DISTRIBUTOR batches (IS/PS/EG/EG-HOS/PS-T), never in the Office batch, which is why re-running Office
could not disturb them. What OTMS lost is only its **472.308 Office units**, which the rule
redistributed. Its attribution NULL-area bucket went 1,541.308 → 1,069.000 — exactly that 472.308.

**What is now false:** the "must NOT be re-run" trap below, and the 1,672-unit convergence figure —
that measured his spread against his sheet, and the rule's output is deliberately further from the
sheet. Full account, including the backups: [[ez-is-credited-evenly-across-cairo-giza-cns-reps]].

**Owner order 2026-08-12 ("my sheet is finalized — deep fix final fix now"): July 2026 CNS now
carries HIS Office spread verbatim, not the golden rule's output.** The rule code
(`office-allocation.ts`) is untouched and still governs future months — this is a data-level
override of one finalized month.

**What was done, in order:**
1. **Area `OTMS` "Main Store" created** in `source_of_sales_areas`, region OT — his sheet folds
   Main Store under Others, so Phoenix now does too. It appears in every line's skeleton (empty
   elsewhere).
2. **Office rows scaled to his 378 Stores cells** (from `Jul- 2026 Sales Closing ( CNS Line )
   Final  (2).xlsx` Data tab, Distributor=Stores, sum exactly 42,838): rollup 3,447 scaled / 180
   zeroed / 9 OTMS rows inserted; import_rows mirrored (3,627 scaled, 9 inserted). Areas his sheet
   gives no Office (OT1/OT2/OT10/OT7/OT4/OT5/OT8/UE9) are zeroed.
3. **His 154 parked rows moved to OTMS** (1,069 units; 2 units are net-zero return pairs):
   Ministry of Interior 472 + branch warehouses 138/42/95 (UPA tender) + 25 Tor Sinai + the
   Hurghada/Ras Ghareb/Safaga/Sharm/Dakhla remote-area pharmacies he parks centrally. Matched by
   (distributor family IS/PS/EG incl -S/-T/-BR/-HOS variants, client_code, product).

**Convergence, measured:** area×product total absolute disagreement vs his sheet went
**17,186 → 7,930 → 1,672 units** (of 105,152) across the day's three fixes. Line total conserved at
105,152.00 exactly; Main Store 1,541.31 vs his 1,543.31.

**The remaining 1,672 is nearly all his own "Phoenix is correct" rulings** (Alex Center/East
Conviban ±90-ish = customer 429955; Sohag/Qena pairs ±64 and under = customers he ruled Phoenix-side
on the 2026-08-12 ruling sheet) plus Dopaminect UPA Cairo East 1/Port Said ±45 (unruled) — so it
CANNOT be driven to zero without reversing rulings he himself made.

**Traps for future sessions:**
- ~~the golden-rule allocation must NOT be re-run for July CNS~~ — **OVERTAKEN 2026-08-26: he
  ordered exactly that re-run.** See the reversal block at the top. The reasoning was sound while it
  held, and the lesson survives the reversal: **a data-level override of one month is invisible to
  the rule that produced the month**, so anything that re-runs the rule silently reverts it. Surface
  the cost and get his word — do not infer either way.
- A rollup REFRESH on the Office batch rebuilds from import_rows, so both tables must always be
  rewritten consistently; that was true of the 08-12 override and is true of the 08-26 re-run.
- OTMS is a real active area now: filters, targets, weekly views and the AREA_CITY map all see it
  (absent from AREA_CITY → never city-split, which is correct).
- Backups (private schemas, grants revoked): `office_override_backup_20260812` (whole July CNS:
  17,272 rollup / 19,808 import rows pre-override), plus earlier
  `office_reimport_backup_20260812` and `placement_ruling_backup_20260812`.
- **⚠ DO NOT DROP `office_override_backup_20260812` — verified 2026-08-28 as the ONLY copy of the
  pre-override state.** Snapshot stamped `backed_up_at = 2026-08-12 07:57:10Z`, scope July 2026 CNS
  only, 14 batches, 105,152.000 units (the locked line total). It was tested against live the same way
  the redundant `ez_split_backup_20260826` tables were, and came out the **opposite**: 3,627 import
  rows are gone from live, and while all 3,627 exist by id in
  `ez_split_backup_20260826.office_july_import_preimage`, **all 3,627 hold DIFFERENT values there** —
  two vintages of the same rows (here = the golden rule's output; there = his 08-12 spread, which the
  08-26 re-run replaced). Neither substitutes for the other. A further **161** rows survive in live but
  differ: **153 of them / 1,069 units** are his parked tender rows *before* the move to OTMS, and the
  per-row origin bricks exist **only here** — the memory above records only the 472/138/95/42 totals.
  The remaining 8 are an unrelated Sohag restamp (client `0001511327`, `احمد عزت - سوهاج`, UE5→UE6,
  brick `B213-1`→`B165-3`, 23 units conserved) — **not** Orouba/Abdeen, a different customer.
  The only redundant part is 6 rollup rows, EZ again (client `1011654`, CA1, `B196-2`, 2,650 July
  units), reconstructible from the never-mutated live raw import. Size is not a reason to revisit
  this: 19 MB against a 1,938 MB database, with all 16 backup schemas together at 45 MB (2.33%).

See [[owner-office-allocation-rule-value-share]], [[office-golden-rule-is-mechanically-locked]],
[[placement-rulings-and-office-reimport-applied-2026-08-12]].
