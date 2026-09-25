---
name: store-sales-split-evenly-across-city-areas
description: "Store customers' sales divide evenly across the AREAS of the store's city, per product per month — not 100% to the one area's rep."
metadata: 
  node_type: memory
  type: project
  originSessionId: f92f2e0d-b5e9-4641-858a-f7863f7ea89a
  modified: 2026-08-04T20:28:55.994Z
---

Owner rule settled 2026-08-04, **shipped #1712**. For a customer classified as a STORE
([[sos-customer-channel-store-vs-pharmacy]]), sales on **Pedia / Anti Infective / CNS** no longer
credit only the rep whose area the store sits in. Per product, per month: divide the store's sales
**evenly across the AREAS of the store's city**, then let each area's share flow to whoever holds
that area's line seat. **A vacant seat keeps its share on the area** — same as the closing already
does for vacancies.

Settled, in his words and confirmed by MCQ:
- Pharmacies unchanged. **Head Office line excluded** for now (117.0M EGP, "huge data for later").
- Scope is **8,606,411.33 EGP**, 301 stores, 39 areas, 7 months (2026-01…2026-07).
- Split group = **city / governorate**, 25 cities over 49 areas — NOT the system region.
- **Distribute on the AREA, not the rep seat** — this is what makes it total-preserving.
- Lands in the **monthly closing downloaded sheet**, with a **separate column** showing how much of
  a rep's number came from the store split.
- **All 7 closed months restated, but incentive achievement frozen** on the old attribution so
  settled payouts don't move.

**Why:** one rep was booking a whole city's wholesaler business alone — Batool Rafiq Ali Abdelhady
holds 2.4M of Dakahlia CNS; after the split she and two colleagues take ~808,550 each.

**How to apply:**
- Verified total-preserving: 8,606,411.33 in, 8,606,411.33 out, difference **0.00**; reach widens
  from 39 to 46 areas and **nothing is stranded** (today 642,671 EGP reaches nobody).
- Dividing by rep headcount does NOT work — 20 city×line pairs have zero reps (**Cairo has no Pedia
  rep at all**). Areas always exist; that is the whole reason the unit is the area.
- Ambiguous areas are resolved from **`au.line_area_map.operational_region_code`** (the line
  organogram), the owner's tiebreak: Helwan-Maadi → **Giza** (GZ on all 3 lines); Aswan Legacy
  (OT3) is **absent from the organogram = retired**.
- Careful: `operational_region_code` is NOT a city. Its "OT" is a 12–14 area national catch-all, and
  it puts Down town in CNS's Giza and Kafr El-Sheikh 1 in Alexandria's. Use it to break ties, never
  as the split group itself.
- 107,422 EGP of store sales are **direct with a blank area code**; those already attribute to
  line+region only and stay outside this change ([[direct-sales-area-code-is-empty-string-not-null]]).

## The allocation belongs to the MONTH, never to the filter (owner, 2026-08-04)

Asked which behaviour a FILTERED export should show when a city straddles the filter, he restated
the rule instead of choosing: *"a Store in Alex East sold 750 units → we check the city → Alexandria
has Alex East, Alex West, Alex Center → 250 each."* **That answer IS the decision: 250/250/250 no
matter what anyone filtered.** So an area's number must be identical in a filtered and an
unfiltered export — the filter SELECTS rows, it must never CHANGE them. Renormalising the shares
across only the surviving areas, or skipping the split when the city is cut, were both rejected by
that reading: each invents a number that appears nowhere else.

**The defect this exposed (pre-existing, fixed on `claude/loving-lichterman-2fe5d9`).** The export
loaded its detail rows ALREADY narrowed to the filtered areas, then split them against the master
city map. Money vanished in **both** directions — outgoing shares aimed at excluded areas had no
row to land on and were skipped, while the origin's negative side still applied; and an in-scope
area never received its share from an excluded store in the same city. Measured on live June 2026:
every single-region filter across the three lines dropped **95,888 EGP in one month**; worst single
area, CNS/CA2 Cairo, dropped **271,294 of 325,553 (83%)**.

**A plain REGION filter is enough to trigger it** — this is not an exotic area-picker case. Against
live `au_v_line_area_map`, four cities straddle a region boundary: **Cairo** (CA5 → OT on
Pedia/Anti Infective, GZ on CNS), **Kafr El-Sheikh** (all three lines), **Giza** (CNS, Anti
Infective), **Qena** (Pedia, CNS), **Sharkia** (Anti Infective).

**The fix, in one sentence:** allocate over the whole month FIRST, narrow to the exported areas
SECOND (`src/lib/sales/closing-store-split-export.ts`), and state whatever still belongs outside
the filter as its own Total-sheet reconciliation line so Difference still reads zero. Costs nothing
— `readImportRows` always read the whole line/month and `applyDetailFilters` narrowed in memory,
so removing the place filter from the loader adds no query. See
[[no-data-must-never-render-as-absence-or-zero]].
