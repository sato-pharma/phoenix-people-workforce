# Two vacancy models, on purpose (for now)

Written 2026-07-27, alongside `supabase/migrations/20260727234500_au_area_state_follows_seat_occupancy.sql`.

Phoenix represents "this position is empty" in **two independent places**. Neither is wrong;
they answer different questions. This note exists because a bug went unnoticed for three weeks
purely because nobody had written down that both existed, so nobody was checking one against
the other.

## The two models

| | `public.position_vacancies` | `au.line_area_map.area_state` + `au.occupancy_history` |
| --- | --- | --- |
| Question it answers | "What are we recruiting for?" | "Is this sales area/seat staffed right now, and who sat in it in May?" |
| Grain | one row per opened requisition | one row per seat, one row per (line, area) |
| Keyed by | `position_id` / `line_id` / `area_id` (public org ids) | `seat_id`, `(line_code, area_code)` (au canonical codes) |
| Time model | `status` + `created_at` (a lifecycle, not a period) | period-versioned half-open spans `[effective_from, effective_to)` |
| Maintained by | the resignation flow (`public.phx_resign_employee_and_open_vacancy`), employees lifecycle triggers | `au.resign_occupant` / `au.hire_into_seat` / `au.transfer_occupant` |
| Read by | Recruitment, Vacancy Report, Organogram vacancy rows | Sales territory drilldown, monthly targets, attribution/achievement grids |
| Can answer "as of last May"? | No | Yes — this is the whole point of the seat model |

`au.v_org_tree` and `au.v_org_structure_kpis` derive vacancy from `au.occupancy_history`
(the seat), not from `area_state`. So the organogram and headcount KPIs read the seat model
directly and were never affected by the `area_state` drift this migration fixes.

## What went wrong

Resignation wrote to **both** models — but only halfway into the second one. It closed the
occupancy span and opened a vacant placeholder on the seat, and never released the matching
`au.line_area_map` row, which kept `area_state = 'occupied'` forever. Six rep areas across
July 2026 read as staffed with nobody in them until they were corrected by hand on 2026-07-27:

`anti_infective AB4` · `anti_infective CA2` · `pedia D16` · `pedia UE3` · `cns AB5` · `cns GZ2`

The root cause is not that there are two models. It is that **the seat model had columns no code
maintained** — `area_state`, and `seat_label` right beside it — and no reconciliation ran between
them. Both are now fixed:

- `au.sync_area_state_for_seat` maintains `area_state` from both lifecycle RPCs, in the same
  transaction as the occupancy write.
- `au.f_line_area_occupancy_drift()` (wrapper `public.au_v_line_area_occupancy_drift`) reconciles
  `area_state` against `occupancy_history`, run via `pnpm run db:au:reconcile-area-state`.

## Stale `seat_label` — the same defect, one column over

`au.seats.seat_label` baked occupancy into a static string at seed time
(`'PEDIA Cairo DM (VACANT)'`). Nothing maintained it, so it went stale the moment a seat was
filled or vacated. On 2026-07-27 two seats carried the suffix: `SEAT-AIF-DM-GZ` (genuinely
vacant, so the label happened to be right) and `SEAT-PED-DM-CA` (occupied by PD-0006 — the
label was simply wrong).

Fixed by **removing the state from the string, not by maintaining a third copy of it**: the
stored label is now a name, and `au.v_org_tree.seat_display_label` derives the `(VACANT)` suffix
from the open occupancy span at read time. Hard-coding state into a text column is what created
the bug; a derived value cannot go stale. `au.f_line_area_occupancy_drift()` reports
`seat_label_asserts_occupancy` if anyone re-introduces one.

## Known remaining gap — the larger half (NOT fixed here)

`au.hire_into_seat` has **no application caller**. The only `au` RPC the app invokes is
`au.resign_occupant`, via `public.phx_resign_employee_and_open_vacancy` from
`src/lib/resignations/service.ts`. As of 2026-07-27 `au.occupancy_history` holds 132
`seed_baseline` rows, 7 `resignation_rpc` rows, and exactly **one** `hire_rpc` row —
occupancy_id 143, created by hand that day to seat PD-0006 (Pedia Cairo DSM) on
`SEAT-PED-DM-CA`.

So **resignations flow into the seat model automatically; hires do not.** A new hire gets no
occupancy row unless somebody runs the RPC manually. Today the seat model is otherwise
re-aligned to reality only by the Phase-9 reconcile
(`20260718130000_au_occupancy_reconcile_from_master_phase9.sql`), which vacates stale occupants
but never fills a seat.

That is why the hire-side half of this migration is a latch rather than a repair: it is correct
and it must ship with the resign side (otherwise the bug simply inverts on the first hire), but
it will not do useful work at scale until something calls it. **Wiring hires into the seat model
is the single largest outstanding item in this area** and is deliberately out of scope here.

## The decision to make (deliberately deferred)

**Should the two models be merged?** Not in this PR, and not without an owner ruling. The
options, honestly stated:

1. **Keep both, reconcile automatically** (status quo + this PR). Cheapest, lowest risk. Each
   model stays good at its own job; the drift reconciler is the safety net. Cost: two things to
   keep right, and the hire gap above stays open until someone wires new hires into
   `au.hire_into_seat`.
2. **Make `area_state` fully derived.** Replace the stored column with a view/generated
   expression over `au.occupancy_history`, so drift becomes structurally impossible. Blocked
   today by `carries_target`, which is `generated always as (area_state in ('occupied',
   'vacant_will_hire')) stored` and is filtered on by `monthly-targets.ts` and
   `territory/skeleton.ts` — and by the Others rows (`other_permanent`,
   `other_line_specific`), which describe routing, not staffing, and have no seat to derive
   from at all.
3. **Collapse `position_vacancies` into the seat model.** Largest change, touches Recruitment
   and the Vacancy Report, and would force public org ids onto au canonical codes. Not
   justified by anything observed so far.

Recommendation: **option 1 now, option 2 when the Others rows have a home that does not depend
on `area_state`.** Revisit if the reconciler ever reports drift it cannot explain.

## If the reconciler fires

```bash
pnpm run db:au:reconcile-area-state
```

Non-empty output means a vacated area is reading as staffed somewhere in the sales territory
views (or the reverse). The `drift_kind` column says which shape it is; `occupied_but_seat_vacant`
is the original bug. Correcting it is a one-row `area_state` update on the open
`au.line_area_map` row — but find out what skipped the lifecycle RPC first, because the
reconciler firing at all means something wrote occupancy outside `au.resign_occupant` /
`au.hire_into_seat`.

`seat_label_asserts_occupancy` is different: it means someone stored a state in a name again.
Strip the suffix rather than correcting it — the display value is derived by
`au.v_org_tree.seat_display_label`.
