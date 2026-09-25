---
name: seat-is-now-a-foreign-key-of-the-hiring-ledger
description: "position_vacancies.seat_id is a real FK into au.seats (2026-08-05) — the org seat model is no longer an island re-derived by text matching"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10e06afa-c79f-4b2e-a156-1458a3d6b0b7
  modified: 2026-08-04T22:58:44.144Z
---

**The owner named the root cause 2026-08-05:** `au.seats` is the source of truth for org
structure, but NOTHING outside the `au` schema referenced a seat. `position_vacancies` had no
seat column; `employees` still has none. Every link was re-derived by matching **text**
(line + area + manager + job_title), every time. That single omission was the shared root of
the seat-vanish, the invisible-manager, the duplicate-vacancy and the silent-hire-failure bugs.

**Fixed in PR #1745 — MERGED `c4478a9d`, LIVE in production 2026-08-05 05:59 UTC** (verified via
/api/healthz revision + Railway deployment row; migrations `20260805010000` + `20260805020000`
were applied + probe-verified on staging AND production BEFORE the merge):

- `position_vacancies.seat_id` — real FK → `au.seats(seat_id)`, `on delete set null`.
  Backfilled **59** rows. The pre-write measurement is the reusable part: of 87 rows,
  **0 ambiguous**, 27 manager/head-office correctly NULL, 1 unresolvable.
- **Partial unique index** `position_vacancies_one_open_per_seat` on `(seat_id) where seat_id
  is not null and status='open'` — a second open vacancy per seat is now IMPOSSIBLE, not
  merely discouraged. This is what forced the 8 duplicate rows to be cancelled (audited,
  reversible; kept the row naming a departed predecessor, and `sharkia_2` over the mislabelled
  `sharkia_3` which pointed at Sharkia 2 too).
- `phx_hire_into_seat_on_vacancy_filled` gained **Route 0**: resolve from `new.seat_id` BEFORE
  the predecessor and line+area tiers. Proven on staging — audit recorded
  `resolvedBy: vacancy_seat_id`, zero text matching.
- `phx_stamp_vacancy_seat_from_predecessor` (BEFORE INSERT): a resignation-opened vacancy
  inherits the seat being vacated. **Claims a seat only when the predecessor holds EXACTLY ONE
  open span** — a dual-seat holder (B-1: acting DM + own rep seat) has no single seat to hand
  over. The first draft used `order by occupancy_id desc limit 1` and the repo's existing
  `au-seat-occupant-resolver.test.ts` guard REJECTED it. That guard is worth respecting, not
  suppressing.
- **Every vacancy status change is now audited** (`entity_type='position_vacancy'`,
  `trg_position_vacancies_audit`). Before this, `audit_logs` had **ZERO** vacancy rows in the
  system's entire history while 23 rows had been touched in the preceding week — which is why
  vacancy churn always looked like unexplained drift.

**Proven invariant, twice (rolled-back probe before, real check after): cancelling/altering
`position_vacancies` NEVER touches the organogram.** `au.seats` 133→133, `occupancy_history`
151→151, org tree 133 seats / 103 filled / 30 vacant — identical. A test asserts the migration
contains no `insert/update/delete/alter` against `au.` at all.

**Still open (owner's structural call, deliberately untouched):**
`VAC-PEDIA-CAIRO-DOWNTOWN-SHOUBRA-MR` is an open vacancy for a **Pedia** rep in Down town —
an area Pedia does not staff (only CNS has a Down town rep seat; Pedia maps CA5 to Others).
It can never be filled correctly: either Pedia needs that seat, or the vacancy is cancelled.

**Remaining gap of the same class:** `employees.area_id` / `region_code` / `manager_hr_id` are
still denormalized COPIES of what the seat knows. Phase A fixed the readers to prefer the seat;
the copies themselves are not yet derived. Same disease, next dose.

See [[org-visibility-and-seat-vanish-diagnosis-2026-08-04]] for the full diagnosis this closes.
