---
name: weekly-sales-cannot-follow-the-organogram-it-is-depot-data
description: "Weekly Sales cannot be cut by area or manager the way Monthly Closing is - its rows are depot shipments with no customer and no brick; scope every figure to the three tracked lines first"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-08-26T20:50:42.663Z
---

**Scope FIRST, then measure.** Read
[[head-office-products-are-not-tracked-weekly-golden-rule]] before quoting any weekly number —
Head Office is 78% of the weekly tables and is NOT tracked. Every figure below is
**CNS + Anti Infective + Pedia only** (live prod, 2026-08-26): **EGP 84,103,964, 35,288 rows,
407 branches**.

**OWNER RULING 2026-08-27 — the title of this memory is now half wrong. A depot is not
unmappable, it is SPLITTABLE.** He was shown the 23 stranded Upper Egypt branches and answered with
a rule, not a classification: a branch's money spreads **evenly across the governorates its name
names, then evenly again across that governorate's areas**, resolved **per line from the
organogram**. So weekly CAN be cut by area — fractionally, one row into several areas. What stays
true below is the *grain*: a weekly row is still a depot shipment, so the split is an allocation
rule, never an observation of where the sale landed. See
[[weekly-anti-infective-ue-is-95pct-of-all-unmapped-value]].

**Weekly Sales does not follow the AU organogram row-for-row the way Monthly Closing does.**
`weekly_sales_rows` has no `customer` and no `brick` column — it carries distributor, branch (a
distributor DEPOT), product, line, qty, value. Monthly Closing goes customer → brick → area →
organogram; weekly has a warehouse, and a depot like "Tanta Branch" ships into several areas at once.
`area_code` on a weekly row is an assertion about the depot, not about where the sale landed, and it
is optional by design (documented in `src/lib/sales/weekly/branch-region-map.ts`).

On the tracked lines:

- **EGP 10,723,951 (12.8%) reaches no manager**, and **96% of it is ONE defect**: Anti Infective rows
  are tagged `UE`, but that line's organogram has only `UE-1` and `UE-2` — **EGP 10,289,490, 21.3% of
  the line**, matching no seat. Pedia loses 363,382 (1.8%, mostly a `NATIONAL` tag), CNS 71,079 (0.5%,
  blank region). Monthly Closing already solves this in
  `src/lib/sales/closing-organogram-regions.ts` (`loadLineOperationalRegions` /
  `usesOrganogramRegions` for `anti_infective`, `cns`, `pedia`); **weekly never calls it.**
- Where an area IS mapped, **15 line/area pairs contradict the organogram, EGP 5,298,449** — incl.
  CNS + Pedia `D16` credited to `D1` when the organogram says `AB`.
- **POS is the largest tracked-line distributor** (EGP 47,795,859, 56.8%) on only four uploads ever,
  and is **88.9% of August** — so month-over-month measures who sent a file, not who sold.

**Why:** the owner reads weekly region totals as a field-force distribution. They are not one. Asking
"why doesn't weekly follow the organogram" as if it were a mapping bug leads to months of branch
mapping that cannot succeed.

**How to apply:** never present a weekly area cut as *observed*; it is allocated by the split rule
above and must say so on screen — the owner asked for the calculation to be visible in the mapping
sheet. The fixable items are
(1) scope weekly to the three tracked lines, (2) call the closing's organogram mapper, (3) apply the
existing gap suppression beyond `weekComparison`, (4) correct the 15 pairs, (5) split the depot
branches per the owner's rule. Everything else must be
LABELLED, per [[an-export-must-match-the-screen-never-different-data]]. Coverage numbers:
[[weekly-area-coverage-judge-by-value-not-rows]]. Full audit published 2026-08-26.
