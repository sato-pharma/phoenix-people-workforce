---
name: the-is-iss-twin-mismatch-is-156-and-the-distributor-answers-124
description: "IS and IS-S are ONE distributor, so a code's brick must match on both copies — 156 of 2,975 broke that on 2026-10-12 (262,695 EGP); the distributor's OWN territory column answered 124, and 81 were applied that day (80 from the distributor's column + code 431648 on his ruling) leaving 75, of which 30 are unruled and 45 already ruled."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-12T00:00:00.000Z
---

Asked on 2026-10-12 to review brick/area mapping because **managers still report wrong mappings**, the
measurement located the defect precisely. He restated the governing rule himself that day: *"the Is-s
and the is are the same distributor… the pharmacies and codes here and their must be identical in
mapping in bricks and areas."*

🔴 **His clarification is what made the defect visible at the right size.** The area is inherited from
the brick through the block's composite FK, so an **area**-level check reports 51 and misses 105 codes
sitting in two different bricks of the same area. The defect set is every code whose **brick** differs.

**The census** — codes carried by BOTH `IS` and `IS-S` under the same normalized name, production:

| State | Before (2026-10-12) | After the apply |
| --- | --- | --- |
| Identical — correct | 2,819 (7,911,057.50 EGP) | **2,899** |
| Two bricks, same area | 105 (139,184.88) | 50 |
| Two **areas** | 34 (115,079.80) | 16 |
| Two **regions** — worst | 17 (8,430.46) | 10 |
| **Breaking the rule** | **156 of 2,975 — 262,695.14 EGP** | **76** |

🔴 **THE DISTRIBUTOR ANSWERS MOST OF IT — resolve `raw_row->>'Brick Name'` through
`source_of_sales_territory_aliases` (target_type `brick`).** It named exactly one of the two bricks for
**124 of 156**; after excluding his already-ruled rows, **80 of 110** (48 Ibn Sina, 32 Ibn Sina-Sato).
**Those 80 were applied to production on 2026-10-12** on his instruction *"apply the 80 rows the
distributor's own sheet answers"* — `source = 'distributor-territory-2026-10-12'`, `mapped_by =
'distributor-territory-column'`, **confidence 90** (100 is reserved for his own rulings), pre-image
`sos_backup_20261012.customer_map_twin_pre` (160 rows; the script refuses to write unless the
pre-image is complete, and prints the reverse SQL joining `m.id = p.id`). Proven after: 80 rows
updated, **0 of the 80 still disagreeing on brick, area or region**, and the count moved 156 → 76 read
two independent ways.

🔴 **MOVE BOTH COPIES TOGETHER, AND NEVER DECIDE FROM AN ADDRESS.** A one-sided write recreates the
split. All 110 rows carry an address (`marketing_pharmacy_reference`) and it was shown for his eye
only — an address-driven sweep is exactly what was reverted in full on 2026-09-11.

🔴 **ZERO of his 40 "Leave both" codes was touched** — the overlap was checked before the write, and
`verify.sql` checks 88 and 91 now read 26 identically, which proves it independently.

**What is still open (75):** the **30 nobody has ruled** — 29 where the distributor sends no
territory at all, 1 naming a third brick — in
`xlsx/ibn-sina-twin-mapping-questions-v2-2026-10-12.xlsx` (110 rows, dropdown `M5:M114`, address in C,
recommendation in K), plus the 45 he has already ruled at confidence 100.

🔴 **CODE 431648 IS RULED AND APPLIED — and it is the template for a both-sides-ruled conflict.**
عاطف جرجس محارب, 38,488.50 EGP, the largest single amount in the backlog, and the one code carrying a
confidence-100 ruling on BOTH sides: IS on B209-1 مدينة قنا / Qena 1 (`owner-ruling-2026-10-10-hold3469`)
against IS-S on B209B-1 / Qena 2 (`owner-ruling-qena-copy-his-sheet-2026-08-10`). **Two of his rulings
are not equal in standing — compare their dates before calling it a contradiction.** His Qena 1
ruling was a MONTH newer, the distributor's own territory text reads **"QENA CITY"** → مدينة قنا
(and it sends that text only on the IS side), and the address ش الميناء النهرى is Qena city proper.
Three signals, one answer. He ruled *"map 431648 to Qena 1 on both copies"* on 2026-10-12; the IS-S
copy moved to B209-1 / UE7 at confidence 100, `source = 'owner-ruling-2026-10-12-qena1-both-copies'`,
pre-image `sos_backup_20261012.customer_map_431648_pre`, and the count went 76 → 75.

**The broad mapping is healthy, so this is the thing to fix, not a sweep.**
`scripts/customer-territory-questions.ts` the same day: the territory column **agrees on 79,699
customers** and disagrees on 1,317 — 1,283 of those his own rulings, leaving **16 safe-to-apply (2,459
EGP)** and 18 weak.

**The skill is now clean: `resources/verify.sql` reads 78 checks, 78 PASS / 0 FAIL** (2026-10-12). It
was 68/10: checks **94, 95 and 96 were false alarms** because the Mapping Guard was **retired
completely in #5731** — `sos_map_guard_decide` does not exist (so 96 read NULL, not "no") and the
"184 pending holds" read 0. 🔴 **Never fix those by rebuilding the guard.** `sos_map_change_holds`
survives as frozen history (3,471 rows, 0 pending, newest 2026-10-09 23:20 Cairo). The other four
failures were stale DRIFT baselines, re-baselined with dated notes.

**Why:** the complaint sounds like a mass mapping failure and is not one — 94.8% of twin codes already
matched and 79,699 customers agree with their distributor. One pharmacy counted in two areas is seen by
two managers at once, which is exactly what produces the complaints.

**How to apply:** the map move alone changes nothing a manager sees — see
[[a-customer-map-move-finishes-itself-overnight-but-never-for-a-published-month]], and run nothing by
hand. Related: [[territory-is-not-geography]] ·
[[apply-sql-file-default-pooler-host-is-wrong-for-production]].
