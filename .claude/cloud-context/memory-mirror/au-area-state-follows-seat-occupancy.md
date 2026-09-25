---
name: au-area-state-follows-seat-occupancy
description: "PR #1399 — au.line_area_map.area_state now maintained on resign/hire; records the still-open gap that hires never reach the au seat model"
metadata: 
  node_type: memory
  type: project
  originSessionId: c6c301a6-eb56-4d59-8a41-01125ffb468e
  modified: 2026-07-27T20:38:54.787Z
---

PR #1399 (2026-07-27) makes `au.line_area_map.area_state` follow seat occupancy via
`au.sync_area_state_for_seat`, called from `au.resign_occupant` and `au.hire_into_seat`.
Migration `20260727234500_au_area_state_follows_seat_occupancy.sql`:
**APPLIED + VERIFIED ON BOTH** 2026-07-27 — staging `cifwmndunmlxjhyjugxa` (recorded version
`20260727202235`) and production `ozucdzovmcqvepbozvqf` (recorded version `20260727203017`).
MCP apply-timestamp drift as usual: the recorded `version` is the apply time, the `name` carries
the filename, so the recorded version sorts EARLIER than `20260727231518_source_of_sales_ims_ratio`
despite applying later. No `area_state` backfill was needed (owner hand-corrected the six July
areas); the only data change was stripping 2 stale `seat_label` suffixes.

PR #1399 **MERGED** to main 2026-07-27 23:37 Cairo as squash commit `dbec4674` — repo and DB
are in sync. Worktree `.claude/worktrees/cranky-chebyshev-576239` + branch
`claude/cranky-chebyshev-576239` still alive, awaiting the owner's CLEAN ritual.
Rollback payload if ever needed: `SEAT-AIF-DM-GZ` = `'ANTI_INFECTIVE Giza DM (VACANT)'`,
`SEAT-PED-DM-CA` = `'PEDIA Cairo DM (VACANT)'`, then re-run migrations `20260713005901`
(resign/hire bodies) and `20260712223505` (v_org_tree).

Staging proof, all rolled back or read-only: a `DO` block ran resign→hire on a real REP seat
(`occupied → vacant_will_hire → occupied`), confirmed Others rows unchanged 21→21, confirmed a
DM resignation moved 0 areas, then `RAISE EXCEPTION` rolled the whole thing back (0 rows left
behind, 132 occupancy rows before and after). `pnpm run db:au:reconcile-area-state` against
staging returns `ok: true`.

Non-obvious facts established by reading production, worth not re-deriving:

- **`au.hire_into_seat` has no TypeScript caller.** As of 2026-07-27 `au.occupancy_history` =
  132 `seed_baseline` + 7 `resignation_rpc` + exactly ONE `hire_rpc` row (occupancy_id 143,
  `SEAT-PED-DM-CA`/PD-0006, run by hand by the owner that day — the first ever hire event).
  The app only ever invokes `au.resign_occupant` via `phx_resign_employee_and_open_vacancy`
  from `src/lib/resignations/service.ts`. Resignations flow into the au seat model
  automatically; **hires do not** — a new hire gets no occupancy row unless someone runs the
  RPC manually. This gap is still OPEN and is the largest outstanding item in this area.
- **`au.seats.seat_label` had the same stale-state bug** — it baked `(VACANT)` in at seed time.
  Fixed in the same PR by stripping the token and deriving
  `au.v_org_tree.seat_display_label` from the open occupancy span. Do NOT store occupancy in a
  name column again; the reconciler reports `seat_label_asserts_occupancy` if anyone does.
- **`au.v_org_tree` and `au.v_org_structure_kpis` read `au.occupancy_history`, NOT `area_state`.**
  So the organogram/headcount KPIs were never affected by area_state drift — contrary to the
  natural assumption. The only `area_state` consumers are the sales-side surfaces
  (Monthly Targets "vacant" badge, attribution/achievement label column).
- Only `REP` seats carry a non-null `area_code`; DM/RSM/NSM/CEO seats have `area_code IS NULL`.
  All 41 Others rows (`other_permanent`/`other_line_specific`) have `rep_seat_id IS NULL`.
  Those two invariants are what make the Others exclusion structural rather than conventional.
- `carries_target` is `generated always as (area_state in ('occupied','vacant_will_hire'))`, so
  flipping between those two states is a **no-op for targets/incentives/Others routing**. Say so
  up front in any related PR or reviewers will fear a payout impact.

**Why:** the dual vacancy model (`public.position_vacancies` vs the au seat model) is documented
in `docs/area-unification/vacancy-models.md` as **deliberately separate**. The owner still has to
rule on whether to make `area_state` fully derived (blocked today by the `carries_target`
generated column and by the Others rows, which describe routing and have no seat to derive from).

**How to apply:** run `pnpm run db:au:reconcile-area-state` after applying the migration, and any
time seat/area work is suspected of drifting. Non-empty output means something wrote occupancy
outside the lifecycle RPCs — find that first, don't just patch the row.

Follow-up to [[au-seat-occupant-period-aware-resolvers]]. See also
[[organogram-vacancy-occupancy-truth]] and [[au-schema-is-the-org-sos-linkage]].
