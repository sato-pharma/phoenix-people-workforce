---
name: weekly-sales-has-no-area-grain
description: "Weekly Sales facts are at distributor-BRANCH (depot) grain with no area/brick/customer, so area scoping needs an owner-maintained branch→area mapping"
metadata: 
  node_type: memory
  type: project
  originSessionId: fa9757e2-2eab-4f0a-b018-cf9adb57709c
  modified: 2026-07-30T02:56:10.216Z
---

`weekly_sales_rows` carries **region_code + branch_code/branch_name only** — no area, no brick, no
customer. Its grain is the distributor **depot** ("Kafr El Sheikh Branch", "Tanta Branch", "دسوق"),
not a rep territory, and a depot serves customers across several areas. Region is assigned at import
from `weekly_sales_branch_region_map` (876 rows, 6 distributors: EG, IS, IS-S, POS, PS), which has an
admin screen at `/sales/weekly/mapping` plus an Excel template import/export.

**Why it matters:** area-based scoping (see [[dm-sales-scope-drops-out-of-region-areas]]) cannot work
here from the data alone. Built 2026-07-30 (branch `codex/weekly-sales-area-scope`, stacked on
`codex/dm-area-sales-scope`): the branch map gained an **optional** `area_code`, the parser stamps it
onto `weekly_sales_rows.area_code`, and `applyWeeklyTerritoryScope` splits the bound —

- row's branch HAS an area → judged by the viewer's seat areas
- row's branch has NO area → keeps the viewer's own-region bound (unchanged)

so it is strictly additive and an empty map behaves exactly like the old region-only filter. The
hardcoded `Set(["AB","D1","D2"])` Pedia-RSM patch in `weekly/access.ts` is now derived from the seat
map (it reproduces that set exactly), with the literal kept only as a fallback.

**Kafr El-Sheikh is split across two areas** — D16 (كفر الشيخ, دسوق, بلطيم, بيلا, الحامول, سخا …) and
D17 (فوه, قلين, مطوباس, سيدى سالم …) — so no branch could be derived to one. **Owner ruling
2026-07-30: attribute ALL Kafr El-Sheikh branches (17 mapping rows) to D16**, accepting that D17's
CNS sales (~563 rollup rows) get credited to the Alex-BHR DM because D17 has no CNS district or rep
(it sits under `SEAT-CNS-OTHERS`, `other_line_specific`). This includes the branch literally named
"كفر الشيخ 2". Seeded in migration `20260730150100_weekly_kafr_elsheikh_area_seed.sql`.

**APPLIED 2026-07-30 to BOTH staging (`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`).**
Production: 17/17 branches carry D16 (staging only 15 — it lacks 2 POS rows), `area_name` auto-filled
by the trigger, 599 weekly rows stamped / 28,890 left NULL, zero stamped outside region D1. The
Alex-BHR CNS DM goes 2,804 → 3,135 visible weekly rows (+331 rows / EGP 158,535.18) while 2,304
Delta (1) CNS rows stay hidden. Trigger verified live in prod: rejects `AB1` on a D1 branch. NOTE the
stamp is line-agnostic (it's a branch property), so Head Office (95 rows), Pedia (93) and Anti
Infective (66) rows are stamped too — correct, since Pedia's D16 is also operationally under
`SEAT-PED-DM-AB`. **Rollback:** `update weekly_sales_branch_region_map set area_code=null where
area_code='D16'; update weekly_sales_rows set area_code=null where area_code='D16';`

**How to apply:** never infer a branch's area from its name — a test pins that the parser cannot
(`tests/weekly-area-scope.test.ts`). New area attributions are an owner decision entered in the admin
screen or an explicit seed migration. Related: [[sos-ambiguous-place-name-rule]],
[[sos-brick-authoritative-geography]], [[weekly-sales-module-map]], [[la003-la004-confidential-products]].
