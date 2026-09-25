---
name: sos-bricks-are-the-authority-for-branch-to-area
description: "source_of_sales_bricks resolves a place name to an AREA from Sato's own data — use it before any web research when mapping distributor branches to areas"
metadata: 
  node_type: memory
  type: project
  originSessionId: 79f3f577-f3d1-4ba8-9694-cc8af3320030
  modified: 2026-08-12T00:03:14.204Z
---

`source_of_sales_bricks` holds **697 Arabic-named bricks covering all 49 areas**. It is the internal
authority for "which AREA does this place belong to" — e.g. دكرنس → Dakahlia 3, المنصورة → Dakahlia 1,
ميت غمر → Dakahlia 2, الزقازيق → Sharkia 1, فاقوس → Sharkia 2, السواح → Cairo East 1,
باب شرق → Alex Center.

**Why:** areas like Dakahlia 1/2/3 or Sohag 1/2 are *internal rep territories*. No public source knows
which one owns a given town, so web research can only guess at them. On 2026-08-12 a ChatGPT
branch→area run was checked against the bricks: on the **165 branches where both had an opinion it
agreed 165/165**, but its 3 remaining errors were all in the split territories, and only the bricks
caught them.

**How to apply:** when mapping distributor branches (or anything else) to areas, resolve against
bricks first, scoped to the branch's own region. Latin branch names need a transliteration bridge
(`tanta→طنطا`, `dekernes→دكرنس`, …) plus Arabic orthographic normalisation — see
[[arabic-name-search-needs-orthographic-normalization]]. A brick name that appears in two areas of
the same region decides nothing — treat it as a question, per
[[sos-duplicate-brick-names-are-decoys]]. Never guess a numbered split; ask via
[[ask-business-facts-via-xlsx-dropdown-sheet]].

Two traps found the same day:

- **`weekly_sales_branch_region_map` is keyed per (distributor, raw_branch, `source_file_type`)** —
  the same branch has separate `sales` and `stock` rows, and THEY CAN DISAGREE ON REGION. This was
  systemic, not a one-off: **14 Pharma Overseas branches** had scrambled `sales` regions (قنا→OT,
  ملوى→CA, اسيوط 3→CA, رئيسي الاسكندرية→UE) while their `stock` rows were right. Invisible because PS
  ships those warehouses only on the stock file, so the bad rows had produced **zero fact rows** —
  see [[unmapped-products-must-never-reach-a-report]] for the sibling "silent until it isn't" class.
  Fixed 2026-08-12 (`updated_by = claude-region-align-2026-08-12`) by copying each stock row's region
  onto its sales row. **`WS Kafr Elzayat` was the one case where the rule INVERTS** — there the STOCK
  row was wrong (Kafr El-Zayat is in Gharbia/D1, not Alex-BHR), so it was flipped the other way.
  Never "align sales→stock" blindly; decide per branch from the place name. Every pair agrees as of
  2026-08-12. Re-detect with: group the map by (distributor, raw_branch) over `source_file_type in
  ('sales','stock')` and `having count(distinct region_code) > 1`.
- **The map does NOT restamp facts on its own, but the 2026-08-12 import DID backfill
  `weekly_sales_rows.area_code`.** So a correction has to move *both* layers or the report and the
  map disagree. Live after that import: 206 branches carry an area, 11,079 of 34,838 validated fact
  rows (~32%) across 26 areas.

Because coverage is only ~32%, weekly manager attribution cannot simply switch from `(line, region)`
to `(line, area)` — it must prefer area where present and fall back to region. See
[[au-seat-drift-view-is-the-org-truth-check]].
