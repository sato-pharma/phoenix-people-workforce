---
name: the-qena-brick-move-reaches-every-month-and-jan-feb-hold-orphan-targets
description: "Moving قوص and أبنود into Qena 2 re-stamps all nine months because nothing is locked, and January/February are the ONLY months holding an orphan Qena 2 target — so they are the one range where un-stranding the money and leaving the targets alone cannot both be had."
metadata:
  node_type: memory
  type: project
  originSessionId: 3dfa5eb2-1cfe-4ea8-b767-855d5e601f89
  modified: 2026-10-12T22:30:00.000Z
---

His Qena town lists (2026-10-12) put **قوص (`B209-8`) and أبنود (`B209-2`) in Qena 2**, and مدينة قنا
in Qena 2 as well. Phases 1 and 2 shipped; **Phases 3–5 did not.** What was measured on production
before stopping:

**Value sitting on those two bricks, by line and month (EGP):**

| Line | Jan–Feb | Mar–Jun | Jul–Sep | Who it scores today |
| --- | --- | --- | --- | --- |
| CNS | 41,366.13 | 66,599.82 | 79,646.69 | CN-0008 (Qena 1) in every month |
| Pedia | 69,440.63 | 155,449.14 | 70,942.50 | PD-0018 (Qena 1) in every month |
| Anti Infective | 1,627.20 | 5,911.65 | 9,400.70 | AI Qena 1; Qena 2 is staffed, so it lands on B-189 |
| Head Office | 292,358.78 | 750,992.78 | 383,136.75 | **nobody — HO is absent from the engine** |

🔴 **THE MOVE CANNOT BE CONFINED TO A PERIOD.** `sos_relocate_brick` re-points the customer map and
then `sos_move_brick_sales` re-stamps `source_of_sales_import_rows` for **every batch** that
`sos_import_batch_touches_locked_closing()` does not report frozen. Neither takes a period argument,
**every lock row is unlocked** and Jan–Jun were never locked at all — so the move reaches all nine
months, and a month whose destination area is an `other_*` bucket for that line credits the money to
**nobody**. See [[a-brick-move-re-stamps-every-unlocked-month]] in `sales-imports`.

🔴 **JANUARY AND FEBRUARY ARE THE ONLY MONTHS HOLDING AN ORPHAN QENA 2 TARGET** — CNS **92,163.59**
(Jan) and **41,509.20** (Feb), Pedia **104,252.74** (Feb). **March onward has none on either line.**
Because `carries_target` is generated from `area_state`, rolling Qena 2 up to the Qena 1 rep in those
two months necessarily hands those targets to that rep; leaving them in Others necessarily strands
the brick money. **March–June has no such tension at all** — a roll-up there is actuals-only and keeps
his "one target on Qena 1" exactly.

**What is live:** CNS Qena 2 → `SEAT-CNS-REP-UE7` from 2026-07-14 (two effective-dated rows, Others
kept as history). Pedia Qena 2 is still Others until 2026-09-01, then PD-0025's own area.
**Pedia Qena 2's own stranded money Jan–Aug is 77,726.27.**

🔴 **An attempt to extend the CNS roll-up back to 1 March was DECLINED at the MCP, and the row was
restored from `sos_backup_20261012.line_area_map_qena_pre2` — proven 0 differences both ways.** Do not
retry it without his word; it is the fork the work stopped on.

**Why:** the plan read as "move two bricks", and the reach is the whole year with 110,806.76 EGP of
Jan–Feb money and three orphan targets hanging on it.

**How to apply:** measure the per-line, per-month value on a brick BEFORE calling the relocate, and
check `au.monthly_targets` for the destination area in every month the move will touch. Related:
[[sos-monthly-closing-is-the-only-sales-truth]] ·
[[a-customer-map-move-finishes-itself-overnight-but-never-for-a-published-month]].
