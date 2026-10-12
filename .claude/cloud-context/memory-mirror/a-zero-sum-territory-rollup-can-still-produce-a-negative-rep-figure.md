---
name: a-zero-sum-territory-rollup-can-still-produce-a-negative-rep-figure
description: "Moving customers between two areas preserves the pair total exactly, but the Office allocation is recomputed per area from its remaining non-Office VALUE share - so the area that lost its book can flip to a NEGATIVE actual. Qena 1 Pedia September went +72,061.03 to -13,113.84 on an unchanged pair total of 97,298.77, the only negative in nine months."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-12T23:40:00.000Z
---

🔴 **A TERRITORY ROLL-UP THAT TIES TO THE PENNY CAN STILL HAND A REP A NEGATIVE MONTH.** Check every
touched area for `actual_value < 0` before asking him to publish — the pair total proves the move,
it does not prove the result is publishable.

Measured on production 2026-10-12, after his Qena town lists moved 204 customer-map rows out of
Qena 1 (UE7) into Qena 2 (UE8) for the Pedia and Anti Infective lines:

| Pedia, 2026-09 | Own invoices | Engine actual | Implied Office allocation |
| --- | --- | --- | --- |
| Qena 1 before | 68,296.50 | **+72,061.03** | +3,764.53 |
| Qena 1 after | 10,972.13 | **−13,113.84** | **−24,085.97** |
| Qena 2 before | 34,998.75 | 25,237.74 | −9,761.01 |
| Qena 2 after | 92,323.13 | 110,412.61 | +18,089.49 |

**The arithmetic is correct at every level.** The pair total is **97,298.77 before and after**, and the
pair's allocation nets to **−5,996.48 both ways**. Nothing was lost or invented: 85,174.88 moved from
Taha Sheeba to Mostafa Ahmed, exactly the recorded per-rep delta.

**Why the sign flipped.** The Office allocation spreads a direct order's units across the line's areas
by each area's share of the line's **non-Office value** (the locked golden rule). Qena 1's own Pedia
book collapsed 68,296.50 → 10,972.13, while the month's large direct order — **1,152 units /
34,992.00 of Ivyronc from EP-BK** — sits on مدينة قنا `B209B-1`, now in Qena 2. So Qena 1's share
shrank to almost nothing while its allocation debit did not, and 10,972.13 of real invoices could no
longer absorb it. 🔴 **Every actual Ivyronc invoice row in both Qena areas is POSITIVE** — the only
negative Ivyronc row in the whole Pedia line that month is GZ5 `B34-15` at −212.63. The negative is
produced entirely by the allocation step.

🔴 **DO NOT CHASE IT INTO `src/lib/sales/office-allocation.ts`.** That step is the `GOLDEN RULE ·
LOCKED` region — protected file, password-gated, pinned by `tests/office-golden-rule-lock.test.ts` in
the required `test` job, and AUTORUN cannot waive it. Report the figure and let him rule; do not
re-derive the formula from outside and do not present a half-derived theory as the cause.

**It is one figure, not a pattern:** across all nine months and all three lines, exactly **one** area
row came out negative (`actual_value < 0` → 1 row). Everything else stayed positive.

**Why:** a rep published at −13,113.84 against a 175,631.20 target reads as −7.5% achievement, which
is precisely the kind of number that produces the manager complaints the whole thread started from.
A zero-sum proof is necessary and not sufficient.

**How to apply:** after any brick move, area re-map or seat roll-up, before putting a publish decision
to him, run `select ... where actual_value < 0` over the rebuilt snapshot for every touched period, and
name any negative in the report. Related: [[a-customer-map-move-finishes-itself-overnight-but-never-for-a-published-month]] ·
[[the-qena-brick-move-reaches-every-month-and-jan-feb-hold-orphan-targets]] ·
[[units-of-different-products-are-never-added]].
