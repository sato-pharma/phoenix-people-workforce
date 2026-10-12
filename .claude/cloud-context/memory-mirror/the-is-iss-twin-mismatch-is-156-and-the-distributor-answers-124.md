---
name: the-is-iss-twin-mismatch-is-156-and-the-distributor-answers-124
description: "IS and IS-S are ONE distributor, so a code brick must match on both copies - 156 of 2,975 broke that on 2026-10-12 (262,695 EGP); the distributor OWN territory column answered 124, and 80 were applied that day, leaving 76: 30 nobody has ruled, 45 he ruled on one side, and code 431648, a PER-LINE EXCEPTION that must stay split."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-12T22:00:00.000Z
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

**What is still open (76):** the **30 nobody has ruled** — 29 where the distributor sends no
territory at all, 1 naming a third brick — in
`xlsx/ibn-sina-twin-mapping-questions-v2-2026-10-12.xlsx` (110 rows, dropdown `M5:M114`, address in C,
recommendation in K), plus the **45** he has already ruled on ONE side, plus code **431648**, which is
not open at all (see below). Measured live 2026-10-12: **30 + 45 + 1 = 76** exactly.

🔴 **CODE 431648 IS A PER-LINE EXCEPTION, NOT A MISMATCH — DO NOT "FIX" IT AGAIN.**
عاطف جرجس محارب, 38,488.50 EGP, the largest single amount in the backlog, and the one code carrying a
confidence-100 ruling on BOTH sides: IS on B209-1 مدينة قنا / Qena 1
(`owner-ruling-2026-10-10-hold3469`) against IS-S on B209B-1 / Qena 2
(`owner-ruling-qena-copy-his-sheet-2026-08-10`).

**It was moved to Qena 1 on 2026-10-12 on his words — and REVERTED hours later the same day**, because
his own Qena town lists, typed afterwards, put **مدينة قنا in QENA 2**. The three signals that argued
for Qena 1 (his newer 2026-10-10 ruling, the distributor's **"QENA CITY"** text, the ش الميناء النهرى
address) were every one of them read **before those lists existed** — which is the lesson:
🔴 **two of his rulings are not settled by their dates when a THIRD, newer statement of his redefines
the territory itself.** Pre-image of the revert: `sos_backup_20261012.customer_map_431648_revert_pre`;
exactly **1 row** moved back, and the count went 75 → **76**, which is the correct number.

🔴 **WHY IT MUST STAY SPLIT.** **8 areas are a real staffed area for one line and an Others bucket for
another** (CA5, GZ3, GZ6, GZ7, OT2, OT9, UE8, UE9), so the two copies may legitimately differ when they
carry different lines. **IS sells the outsource products, where Qena is a SINGLE area; IS-S sells the
Sato products, where the Qena 1 / Qena 2 split is real.** So 431648 sits on `B209-1 / UE7` as IS and
`B209B-1 / UE8` as IS-S, deliberately. Of the 81 codes moved on 2026-10-12, **4** touch a split area
with differing lines and only 431648 crossed an area boundary; the other three (334225, 365339,
422036) moved brick-within-area and are fine.

**The broad mapping is healthy, so this is the thing to fix, not a sweep.**
`scripts/customer-territory-questions.ts` the same day: the territory column **agrees on 79,699
customers** and disagrees on 1,317 — 1,283 of those his own rulings, leaving **16 safe-to-apply (2,459
EGP)** and 18 weak.

**The skill is now clean: `resources/verify.sql` reads 78 checks, 78 PASS / 0 FAIL** (re-proved against production 2026-10-12 after the revert, which moved checks 80, 81, 88, 91 and 97 each by +1 - re-baselined to 308, 76, 26, 26 and 76). It
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
