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

## Hires now reach the seat model — for the REPLACEMENT case (2026-07-28)

Shipped in `supabase/migrations/20260728010000_au_wire_hire_into_seat_on_vacancy_fill.sql`.
`au.hire_into_seat` had **no application caller** at all until this — the only `au` RPC the app
invoked was `au.resign_occupant`, via `public.phx_resign_employee_and_open_vacancy`. As of
2026-07-27 `au.occupancy_history` held 132 `seed_baseline` rows, 7 `resignation_rpc` rows, and
exactly **one** `hire_rpc` row — occupancy_id 143, created by hand that day to seat PD-0006
(Pedia Cairo DSM) on `SEAT-PED-DM-CA`.

The fix does **not** attempt to resolve a seat from an employee's line/area/job_title. There is
no title -> `seat_tier` (REP/DM/RSM/NSM) mapping anywhere in this codebase, and
`src/lib/employees/access-role.ts` states outright why one shouldn't be invented: *"a job title
is descriptive only and is NEVER a permission source... Auto-provisioned accounts therefore
always start at the least-privilege role."* Building a string-matching heuristic here would have
been the first thing in this codebase to trust `job_title` for something consequential.

Instead it uses a link that already exists and needs no guessing:
`public.position_vacancies.replacement_for_hr_id` — "HR_ID of the resigned/terminated employee
whose position opened this vacancy" — set by the same resignation flow that vacates the
predecessor's `au` seat. A trigger on `position_vacancies` (`AFTER UPDATE`, firing only when
`status` transitions to `'filled'` for a vacancy that has a predecessor) resolves that
predecessor's **last occupied seat** via `au.f_last_occupied_seat_by_hr_id` and re-occupies it
with the new hire via `au.hire_into_seat` — exactly the "seat continuity" the lifecycle RPCs were
designed for. Verified read-only against production before shipping: all six real open
replacement vacancies from the original `area_state` bug resolve, via nothing but occupancy
history, to exactly the six seats already fixed.

**Deliberately still out of scope:**

- **Brand-new headcount** (a vacancy with no `replacement_for_hr_id`, i.e. real growth beyond the
  132 seeded seats) — there is no seat to inherit and no safe way to pick one. No-ops silently.
- **Brand-new headcount** and **employee transfers** — still out of scope; see the two sections
  below, which record what was investigated and why neither is wired yet.
- **Retroactive backfill** — the six vacancies above are still open as of this writing. When one
  is genuinely filled, the trigger handles it going forward; nothing was replayed for the past.

## Resign side: vacate EVERY open seat, not just the first (FIXED 2026-07-28)

Shipped in `supabase/migrations/20260728100000_au_resign_vacate_all_open_seats.sql`.

`public.phx_resign_employee_and_open_vacancy` step 5 used to locate the resigning employee's `au`
seat with `select seat_id ... limit 1` (no `order by`) and vacate that single seat.
`au.occupancy_history` has no per-HR_ID uniqueness — one person can hold more than one open span
at once. Exactly one occupant does today: `B-1` (the sole `ACTING_DM`), holding both
`SEAT-AIF-REP-UE1` and `SEAT-AIF-ADM-UE-1` open. Under the old code, B-1 resigning would close
one and leave the other showing a departed occupant forever — the same defect class as the
`area_state`/`seat_label` bugs, on the resign side.

Fixed by **looping over all open person-spans** rather than making the single pick deterministic:
a resigned employee cannot occupy any seat, so every one must close. For the 131 single-seat
occupants the loop runs exactly once (byte-identical behaviour); only B-1 changes. Applying the
migration mutates no existing row — it only changes what a *future* multi-seat resignation does.
Verified on staging via the real RPC against a synthetic dual-seat employee: both seats vacated,
rolled back. Guarded in `tests/au-seat-occupant-resolver.test.ts` (§6, forbids `limit 1`, requires
the loop).

## Employee transfers: investigated, deliberately NOT wired (2026-07-28)

`au.transfer_occupant` (move an employee between seats while they stay employed) has zero
application callers, same as `au.hire_into_seat` did. But unlike the replacement-hire case, there
is **no safe existing link to wire it to.** What the investigation found:

- **No transfer feature exists in the app at all.** `grep -rn "transfer" src/lib/employees
  src/lib/workforce app/api/employees` returns nothing. Changing an active employee's
  `area_id`/`line_id` today goes through the ordinary "Edit Employee" upsert
  (`employee-directory.ts` `upsertEmployee`), which treats it as a plain field edit — its only
  seat-adjacent side effect is gated behind `if (!isUpdate)` (the hire branch), so an update
  touches `au.*` **not at all**. `bulkUpdateEmployees` exists but is called nowhere (dead code).
- **Consequence — a real latent gap:** editing an active employee's area/line is invisible to the
  seat model. If they occupy an `au` seat, it stays open under the old occupant forever, and no
  new span opens. Nothing reconciles this today.
- **No `replacement_for_hr_id` equivalent.** `public.employees` has no previous-area/-line/
  transfer-date column; nothing writes an audit row on an area/line change. There is no
  deterministic "employee X moved from Y to Z" signal anywhere for a still-employed person — only
  for departures (via `au.occupancy_history` itself, which nothing populates on a lateral move).
- **Destination-seat resolution is only *partially* safer than headcount.** The *source* tier is
  knowable (resolve the employee's currently-open span), but the *destination* seat still needs
  either explicit UI/API selection or a "same-tier, new-area" inference — and there's no existing
  `public.areas`/`public.lines` → `au (line_code, area_code)` resolver outside the one-time seed,
  nor any signal distinguishing a lateral transfer from a promotion (which would change the tier).

**Verdict:** wiring transfers is *not* "connect an existing link" the way the replacement-hire was.
It needs net-new infrastructure (an open-span reverse resolver + a destination-seat source, either
a UI field or a justified inference rule). Left unbuilt on purpose; this is an owner decision about
whether transfers are common enough to warrant that build, not a safe drop-in fix.

**Observability limit, stated honestly:** `closeVacancyOnHire()` clears `replacement_for_hr_id`
to `NULL` in the same update that sets `status='filled'` — so by the time anything reads the
closed vacancy row, the link this trigger depends on is already gone. The trigger writes a
`public.audit_logs` row on both success and failure so the outcome is durably recorded regardless
— but `au.f_line_area_occupancy_drift()` cannot detect "this trigger silently failed to fire":
if it never ran, both `au.line_area_map` and `au.occupancy_history` simply keep agreeing the seat
is vacant, indistinguishable from it genuinely still being open. No drift kind claims to catch
this; that would be false confidence, not a real check. The audit log plus the trigger's own
correctness are the actual safety net.

## The decision to make (deliberately deferred)

**Should the two models be merged?** Not in this PR, and not without an owner ruling. The
options, honestly stated:

1. **Keep both, reconcile automatically** (status quo + this PR). Cheapest, lowest risk. Each
   model stays good at its own job; the drift reconciler is the safety net. Cost: two things to
   keep right, and brand-new-headcount hires still don't reach the seat model (replacement hires
   now do, per the section above).
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
