---
name: fayoum-beni-suef-golden-rule-per-line
description: "GOLDEN RULE — Fayoum (GZ6) and Beni Suef (UE9) merge per LINE as a display fold (CLOSING_AREA_MERGES): Pedia up to and including 2026-08 (two areas from September), CNS from 2026-08, Anti Infective never. Two independent layers: au.line_area_map seats vs the display fold. KNOWN DEFECT LEFT AS PUBLISHED: the Pedia August 2026 matrix drops Beni Suef's El Qema share (175 units, 47,230.22 EGP) because the store split lands after the fold — never re-chase or retro-fix it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8c6bec23-3b91-45b3-9b59-0166d0428297
  modified: 2026-09-21T03:59:14.968Z
---

Fayoum (area_code `GZ6`) and Beni Suef (`UE9`, split out of GZ6 on 2026-08-03) merge **per line**, and
there are **TWO INDEPENDENT LAYERS** — do not conflate them:

## Layer 1 — the DISPLAY FOLD (application, `src/lib/sales/closing-area-merges.ts`) — the live user-facing rule

Owner rule **2026-08-30**: *"only one area in sales and in organogram and in everywhere. Of course, in
line pedia only … Also planning & coverage"* and *"Split CNS into two."* Shipped **PR #2795**
(squash commit `5e35a03a8`), live in production **2026-08-31**.

- `CLOSING_AREA_MERGES` folds `GZ6`+`UE9` into "Fayoum - Beni Suef" on **`pedia` (`untilPeriod: "2026-08"` — owner 2026-09-09: two separate areas from September, August not affected) AND `cns` (`fromPeriod: "2026-08"`)**. Anti Infective was never in it and must not be — its two areas are genuinely different DMs.
- 🔴 **CNS WENT OUT AND CAME BACK. Do not "restore" the split.** It was removed 2026-08-31 (PR #2795, owner "split CNS into two"), then re-added 2026-09-07 (PR #3446) gated to August onward. A session reading only the 08-31 decision will read the live `cns` entry as a regression and delete it. The `fromPeriod` is the tell that it is deliberate.
- **Pedia** shows ONE combined area **"Fayoum - Beni Suef"** on EVERY surface: SoS dashboard `byArea`/pickers, organogram (`organogram-au-source.ts`), territory drilldown (`territory/skeleton.ts`), CRM coverage (`crm/coverage-filters.ts`), monthly closing matrix (`applyClosingAreaMerges`), **weekly planning area picker** (`weekly-planning/planning-areas.ts` — PR #2796, squash `7c0fe44cb`, live 2026-08-31), and every `applyAchievementAreaMerges` caller.
- **Anti Infective shows TWO separate rows** (Fayoum, Beni Suef) — no rule, passes through unchanged. **CNS shows ONE from 2026-08 onward** and two before it.
- **It is a DISPLAY-ONLY fold, safe with NO access-scope change** — verified live: Pedia `GZ6` and `UE9` BOTH map to `dm_seat_id = SEAT-PED-DM-GZ` (occupant B-94) + `operational_region_code = GZ` + `rep_seat_id = SEAT-PED-REP-GZ6`, so every Pedia viewer who sees one already sees the other. The fold runs AFTER authorization (`keepExec` gates on the REAL area code), and a picked/scoped code is EXPANDED back to both real codes via `expandAreaCodeForLine` before any query, so **nothing Beni Suef sold is lost** (verified: Pedia Jul-2026 folded row = 179u = GZ6 121u + UE9 58u; sum(byArea)==totalValue at company and DM-B-94 scope).
- **Anti Infective is correctly NOT folded** — its GZ6 (`SEAT-AIF-DM-GZ`, region GZ) and UE9 (`SEAT-AIF-ADM-UE-1`, region UE-1) are genuinely DIFFERENT DMs, so folding would cross a real access boundary. CNS shares one seat (`SEAT-CNS-OTHERS`) so its un-merge is also display-only-safe.
- **Helpers** (all normalize line via `.trim().toLowerCase()`, so official "Pedia" matches key "pedia"): `getMergedAreaName`, `expandAreaCodeForLine`/`expandAreaCodesForLine` (GZ6→[GZ6,UE9]), `foldAreaCodeForLine` (UE9→GZ6), `foldAreaOptionsForLine` (drops merge code, renames survivor), `applyClosingAreaMerges`, `applyAchievementAreaMerges`, `hasClosingAreaMerges`.
- **Weekly planning — DONE 2026-08-31 (PR #2796).** The earlier guess that it "needs a schema touch" was WRONG: a plan stores the area NAME as free text (`WeeklyPlanDay.area`) and never filters sales by code, so no schema/expand step was needed. `loadPlanningAreaSeats` folds the seat list through `foldAreaOptionsForLine` before returning it — and because the picker (`planningAreaOptions`, seat-model-primary) AND the submit-time check (`planningAreaBelongsToRegion`) both read that one seat list, folding it once covers both. It also selects `area_code` (merge rule keys on CODE) and drops it on the way out to keep `PlanningAreaSeat` unchanged. Historical plan rows that stored "Fayoum"/"Beni Suef" separately were deliberately left as-is (only ~3 rows; cross-line name-collision risk).
- **Deferred, NOT done:** (1) **Delta-3 Anti Infective** Ismailia (`OT2`)+Suez (`OT9`) merge is a SEPARATE date-gated PR (Delta 3 only exists from 2026-09-01). (2) Latent hardening: `foldAreaOptionsForLine` blanks for a viewer scoped to UE9-alone (no live viewer today; follow-up task_90c5dd95) — a proper fix also needs `skeleton.ts`'s `remapAreaCode` (which hard-assumes GZ6 is the survivor).

## Layer 2 — the ORGANOGRAM SEAT STRUCTURE (`au.line_area_map`) — owner ruling 2026-08-07, UNCHANGED by this task

This is who STAFFS what (DM/rep seats, targets), a different table from the display fold above. Not touched by PR #2795.

- **Anti Infective** — SEPARATE seats. Fayoum → `SEAT-AIF-DM-GZ`/`SEAT-AIF-REP-GZ6` (region GZ); Beni Suef → `SEAT-AIF-ADM-UE-1`/`SEAT-AIF-REP-UE9` (region UE-1, with Minia 1/Minia 2).
- **Pedia, up to 2026-08-31** — both `GZ6` and `UE9` share `SEAT-PED-DM-GZ`/`SEAT-PED-REP-GZ6` (region GZ, DM Taha), "one rep covers both halves." Both `carries_target = true`.
- 🔴 **Pedia FROM 2026-09-01 — TWO AREAS, BOTH UNDER OSAMA MOHAMED EL-SAID (UE-1).** Owner, 2026-09-21, shouting: *"NO NO NO STARTING SEPTEMBER FAYOUM IS A AREA AND BANI SUEF ANOTHER AREA … IN PEDIA LINE UNDER OSAMA A"*. Live and correct in `au.line_area_map` (verified that day): `GZ6` Fayoum → `SEAT-PED-DM-UE-1` (PD-0014) + `SEAT-PED-REP-GZ6` (Esraa Awad Hemida); `UE9` Beni Suef → `SEAT-PED-DM-UE-1` + its OWN `SEAT-PED-REP-UE9` (vacant). Never describe September Pedia as one merged area, never put Beni Suef back under Giza/Taha or on Esraa's seat. Undated surfaces (organogram, pickers, targets template) read today's Cairo month, so they already show two.
- 🔴 **September's Pedia TARGETS predate the split** — uploaded 2026-08-04; `GZ6` alone carries the old COMBINED 147,953.25 (988 units) and `UE9` has NONE (nor does Qena 2 `UE8`). Reported to the owner 2026-09-21 as his to set on the Targets screen — never write or split a target yourself.
- **CNS** — both in region **OT (Others)**, `other_type = 'line_specific'`, `staffed_in_line_code = 'anti_infective, pedia'`, `carries_target = false`: covered by whoever holds Fayoum/Beni Suef on AI or Pedia, no dedicated CNS rep. (So CNS's Layer-1 display split into two rows reflects the SALES DATA, which always had GZ6/UE9 separate, not a change to this unstaffed seat structure.)

## Why the SALES geography is never touched

`source_of_sales_areas` / `source_of_sales_fact_rollup` keep `GZ6` and `UE9` as two genuinely separate
areas on every line — an invoice still books to GZ6 or UE9 specifically. Both layers above only change
who is CREDITED and how areas are LABELLED/GROUPED for a viewer; neither moves where a sale's units land.

**How to apply:** before touching `GZ6`/`UE9` on any line, decide which layer you mean. Display label/grouping
→ `closing-area-merges.ts` (Pedia only). Staffing/seats/targets → `au.line_area_map` (per the 2026-08-07
split). If a 4th roster line is ever added, ask the owner which pattern it follows — never assume. See
[[july-direct-overlay-and-rollup-must-move-together]] for a separate July-only Anti Infective exception.

## Layer 3 — what this means for El Qema's Upper Egypt block (2026-09-09)

> **SUPERSEDED for August 2026 (checked 2026-09-17):** `UPPER_EGYPT_AREAS` in
> `src/lib/sales/store-sales-city-split.ts` now names `GZ6` and `UE9` explicitly (the owner named both
> as Upper Egypt on 2026-09-09), so on Pedia August BOTH take an El Qema share — identical ones, 125
> units of Lacto Advanced 1 and 50 of Lacto Advanced 2 each. The paragraph below is the earlier,
> organogram-only reading.

The block reads `operational_region_code` from the organogram, so **Beni Suef is NOT in it on Pedia**
— Layer 2 puts `UE9` in region `GZ` on that line. It IS Upper Egypt on Anti Infective (`UE-1`), where
El Qema's rule does not run at all. Asked directly, the owner chose to follow the organogram rather
than geography: *"follow the organogram but later if we update the organogram the rule changes"*. So
this is not an exception to maintain — moving the seat moves the rule, with no code change.

## 🔴 Known defect LEFT AS PUBLISHED — Pedia August 2026 loses Beni Suef's El Qema share (found 2026-09-17)

**Recognise it by:** the Total sheet of any Pedia August export whose scope holds "Fayoum - Beni Suef"
(NSM, PM, the Giza managers, Super Admin) shows a Difference of exactly **47,230.22**. Scopes without
that area (e.g. Delta (1), Alex-BHR, Kafr El-Sheikh 1) show 0.

- **Mechanism.** `loadMonthlyClosingPartsWithStoreSplit` takes the matrix from `loadMonthlyClosingParts`,
  which has ALREADY folded `UE9` into `GZ6` (`applyClosingAreaMerges` drops the merged row). The store-split
  net (`loadClosingStoreSplit`) is computed on detail rows where the two areas are still apart, so El Qema's
  Upper Egypt pass lands one share on `GZ6` and an identical one on `UE9`. `applyStoreSplitToMatrix` skips
  any delta whose area row is absent: `GZ6`'s share lands on the folded row, `UE9`'s vanishes. No error, and
  the grand total the split is meant to conserve silently shrinks.
- **Size (production, Pedia 2026-08).** Beni Suef's lost share = Lacto Advanced 1, 125 units, 33,712.84 +
  Lacto Advanced 2, 50 units, 13,517.38 = **47,230.22**. Matrix grand total 3,795,907.87 against rollup +
  direct 3,843,138.10. "Fayoum - Beni Suef" shows 61,378.22 (41.9% of its 146,404.13 target) instead of
  108,608.44 (74.2%).
- **Who reads it.** Only the closing surfaces call that loader (admin page, portal, premium and consolidated
  exports, quarter gap, performance review, sales truth report), so they all agree with what was announced.
  No payroll, incentive, KPI or target code calls it.
- **Status — do NOT fix, do NOT re-raise.** Published 2026-09-10 20:35 Cairo, locked since 2026-09-14 22:55
  Cairo. It stays as published under [[never-fix-a-published-and-announced-month]]; reported to the owner
  2026-09-17. **Re-confirmed 2026-09-21** when an Employee 360 audit re-found it — his words: "fayoum and
  banii suef starting from septembver dont touch august".
- **The OTHER side keeps the share, so the two disagree for August forever.** Sales vs Target (the
  attribution engine, `phx_sales_vs_target_range`) builds its split net with `keepMergedAreasApart`, so it
  credits "Fayoum - Beni Suef" **108,608.44** — and so do Employee 360, the portal and the Business Review
  for Esraa Awad Hemida, who held both seats in August. `scripts/check-sales-truth.ts 2026-08` therefore
  always FAILS on exactly this one Sales vs Target row (+47,230.22). That is this decided defect, not a new
  finding — do not re-chase it, and do not "align" either side.
- **No later month is exposed (code-checked 2026-09-17).** Pedia stops folding after 2026-08 (`untilPeriod`),
  so from September `UE9` keeps its own row and its share. CNS folds from 2026-08, but `splitTargetsFor`
  returns the row's own-city block unless El Qema's rule applies (Pedia only), and Fayoum and Beni Suef are
  one-area cities in `AREA_CITY`, so `UE9`'s CNS movement nets to zero. **It returns only if a folded pair
  can receive a share from outside its own city:** El Qema's rule reaching CNS, a second area in the Fayoum
  or Beni Suef city, or a new fold on a Pedia period. If that happens, apply the split before the fold (or
  fold the net's area codes with `foldAreaCodeForLine`), and prove the Total sheet Difference reads 0. See
  [[el-qema-three-bands-plus-upper-egypt]].
