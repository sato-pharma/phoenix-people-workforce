---
name: org-visibility-and-seat-vanish-diagnosis-2026-08-04
description: "Full diagnosis of the two recurring org problems: line-blind visibility resolvers vs the per-line au truth, and the organogram seat-vanish (rowKey collision on double occupancy). Fix plan proposed 2026-08-04, owner approval pending."
metadata: 
  node_type: memory
  type: project
  originSessionId: 10e06afa-c79f-4b2e-a156-1458a3d6b0b7
  modified: 2026-08-04T21:14:21.473Z
---

Diagnosed 2026-08-04 (control-tower session). The owner's "EU tables" = the **`au` schema** (no
`eu_*` objects exist). Both recurring problems are systemic, which is why point fixes never stuck.

**Problem 1 — managers can't see subordinates.** The truth is stored correctly:
`au.line_area_map` gives each line its own region per area; 16 of 42 areas legitimately diverge
(e.g. D16 Kafr El-Sheikh 1 = D1 for anti_infective, AB for cns/pedia). The app has exactly ONE
line-aware resolver — `src/lib/sales/seat-area-scope.ts` — gated to DM/Manager/RM on `DM`/`RSM`
seat tiers only (ACTING_DM excluded at :95, NSM excluded by SEAT_AREA_SCOPED_ROLES at :48, falls
back soft to the line-blind region label). Everything else is line-blind:
- `canSeeEmployee` (permissions.ts:1309-1343): RM + NSM get DIRECT reports only.
- `resolveRegionalManagerRegionCodes` (portal-sos-dashboard.ts:185-232): flattens subordinates'
  region_name labels; empty set blacks out the dashboard.
- Territory drilldown DM branch (territory/root-scope.ts:74-91): own region label only, ignores
  seat areas.
- territory-management/service.ts:221-229 compares SoS region codes against au operational codes —
  different vocabularies (UE vs UE-1/UE-2; sos got UE-1/UE-2 codes 2026-08-02 but no rows re-tagged).
Live victims 08-04: CN-0006 (CNS Down town, true GZ / static CA), B-144 (CNS D16, true AB /
static D1), all 7 AIF Upper Egypt reps (true UE-1/UE-2, static UE). 25 line×area combos diverge
from `source_of_sales_areas.region_code`; 10 have seated reps.

**Problem 2 — refilled seat vanishes from the organogram.** The organogram render is now **100%
`au_v_org_tree`** (`src/lib/reports/organogram-au-source.ts`; the employees∪position_vacancies
logic incl. `suppressFilledVacancyRows` is DEAD CODE on this path — survives only in the flat
vacancy report reconciliation). All 133 seats exist in the view; the structure itself never loses
a seat. The vanish mechanism: `rowKey = type-hrId-sourceRowNumber` (organogram-view-model.ts:133)
with au rows always `sourceRowNumber:null` and `hrId = occupant HR_ID when filled, else seat_id`
(organogram-au-source.ts:58-60,130). One person on TWO open seats → identical keys → every lane
sink dedups it (:461-463, :481-483, :561, :624) → the second seat renders NOWHERE (vacant seats
can't collide because seat_id is unique — so the box vanishes exactly at refill). Proven episode:
AI-0005 held SEAT-AIF-REP-CA2 + CA6 simultaneously on 2026-08-01 (hand-fixed same day,
`au.occ_bak_ai0005_20260801` is the residue). Wrong-seat auto-binding victims per migration
20260801150000: AI-0005, AI-0003, AI-0006, B-189. Root gaps still open: `au.hire_into_seat` has
no already-seated guard, `occupancy_history` has per-SEAT open uniqueness but none per PERSON,
the reconciler checks only position_vacancies.filled_by_hr_id, and migrations 20260804090813
(Route 2 line+area) + 20260804105756 (tiers 2/3) widened trigger firing on 08-04. No transfer
flow exists: editing an active employee's area/line touches au NOT AT ALL.

**Why the loop never ended:** two parallel org systems both live (legacy
employees/position_vacancies/areas vs au seat model); every surface reads a different mix;
duplicate open vacancies from 5 code eras (B-150's seat has 3 open rows); vacancy cancels on
08-04 wrote NO audit rows. Hand-fixes patched data, never the machinery.

**Fix plan status (2026-08-05 ~00:30 Cairo):** Phase B **MERGED + LIVE** (PR #1739, squash
`769cb411`, verified serving via /api/healthz + deployments API; both migrations 20260804190000 +
20260804191000 applied + probe-verified on staging AND prod; Seer's two "transfer_out on the
placeholder row" review threads were resolved as the PRE-EXISTING au.transfer_occupant convention,
occupancy 151 is the precedent). Phase A **SHIPPED to PR #1741** (branch
codex/phase-a-line-aware-visibility, merge pending): ACTING_DM in seat-area-scope + effective
window; RM/NSM subtree in canSeeEmployee via optional directory index (single-row callers keep
direct-only); portal SoS RM line-aware area fallback; territory drilldown DM area-level scope;
territory-management area precedence + UE-split bridge (exported
expandRegionCodesForOperationalMatch). No migrations in Phase A. Remaining NOT started: C =
vacancy dedupe + UE vocabulary alignment on sales rows + audited vacancy status changes; D =
reconciliation checks (person double-occupancy, employees-vs-au drift).
See [[organogram-vacancy-occupancy-truth]], [[au-schema-is-the-org-sos-linkage]],
[[au-hire-into-seat-vacancy-wiring]], [[new-hire-gets-no-organogram-seat-unless-replacing-someone]],
[[rep-area-assignment-three-conflicting-sources]].
