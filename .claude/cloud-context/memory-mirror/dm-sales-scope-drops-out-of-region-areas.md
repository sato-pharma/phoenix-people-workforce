---
name: dm-sales-scope-drops-out-of-region-areas
description: "RESOLVED + DEPLOYED 2026-07-30 (PR #1479, weekly half #1482), verified on the portal. Kept for the lesson: a DM/RM's sales scope USED TO BE one geographic region name, so operationally-assigned out-of-region areas (e.g. Saad Salama's Kafr El-Sheikh) vanished from every SoS-driven surface."
metadata: 
  node_type: memory
  type: project
  originSessionId: fa9757e2-2eab-4f0a-b018-cf9adb57709c
  modified: 2026-10-01T00:00:00.000Z
---

**VERIFIED ON THE PORTAL 2026-07-30**, as B-119 via dev-auth against prod data, on code byte-identical
to deployed main: Source of Sales serves all 6 areas including Kafr El-Sheikh 1, scope banner reads
"CNS · 6 areas" (was "Alex-BHR region"), and Qalubeya / Gharbia / Menoufia / Kafr El-Sheikh 2 are
ABSENT — the sibling DMs' Delta (1) areas did not leak. Weekly Sales serves his Kafr El-Sheikh
branches while Tanta / Banha / Kalioub / Elmahla stay absent.

**RESOLVED + DEPLOYED 2026-07-30.** PR #1479 merged (`3bb2b7e0`), shipped to prod inside revision
`phoenix-hr-00670-fiq` (tag `sha-3a1c3fbc`); the weekly follow-up #1482 (`9fb61a39`) is live as
`phoenix-hr-00673-wiy`. Both smoke-tested on `https://phoenix-hr.satopharma.com`. No migration was
needed for #1479 — it is pure scope logic. See [[weekly-sales-has-no-area-grain]] for the weekly half.

Confirmed 2026-07-30 in production. A district's areas are NOT always inside its
geographic region. `au.line_area_map` carries BOTH `operational_region_code` (which DM
actually owns the area) and `au.canonical_areas.code_region_code` (where the area sits
geographically). 6 live areas differ between the two:

- CNS **D16 Kafr El-Sheikh 1** → operational `AB` (Saad Salama B-119, CNS Alex-BHR DM), geographic `D1`
- Pedia D16 Kafr El-Sheikh 1 → operational `AB` (vacant_will_hire), geographic `D1`
- Pedia GZ5 Helwan-Maadi → operational `CA`, geographic `GZ`
- CNS CA5 Down town → operational `GZ`; plus AIF GZ6/UE splits (UE-1/UE-2)

`computeSalesAccessScope` in [access-scope.ts](src/lib/sales/access-scope.ts)
narrows SELF/TEAM/HIERARCHY viewers to `allowedRegionNames = {own employees.region_name}`.
Saad's row says ALEX-BHR → region code AB → **all 1,165 CNS D16 fact rows (7,350 units)
are invisible to him**, so his own Kafr El-Sheikh rep's sales are missing from every
Source-of-Sales-derived surface: portal SoS (`portal-sos-dashboard.ts:302`), admin SoS
(`sos-dashboard.ts`), Sales Analytics (`analytics/scope.ts`), Weekly Sales
(`weekly/access.ts:163`), Monthly Closing (`monthly-closing-portal.ts` /
`monthly-closing-details.ts`), Direct Orders (`direct-orders/service.ts:1115`), Territory Management
(`territory-management/service.ts:203`).

**Not affected:** HR-side team lists (portal Command Center "MY REPS", team size, DSM Team
Performance) — they key off `manager_hr_id`, so they correctly show all 5 active reps
including Kafr El-Sheikh. Verified live in the browser as B-119. Territory & Sales
Drilldown is also correct because `loadLineAreas` filters on `operational_region_code`
([skeleton.ts:88](src/lib/sales/territory/skeleton.ts)) — that file is the model to copy.

**Why:** region NAME is a coarse geographic label; the authoritative "who owns this area"
signal is the seat map (`dm_seat_id` / `operational_region_code`).

**How to apply:** never scope a DM/RM's sales by geographic region. Resolve allowed AREA
codes from `au_v_line_area_map` instead. Do NOT "fix" it by adding the out-of-region
region to `allowedRegionNames` — that leaks the whole of Delta (1) to Saad. The hardcoded
`new Set(["AB","D1","D2"])` RSM patch at `weekly/access.ts:166` is a previous band-aid for
this same class of bug. Related: [sos-per-line-region-columns-are-geographic-not-routing]],
[[au-schema-is-the-org-sos-linkage]], [[rep-area-assignment-three-conflicting-sources]].
