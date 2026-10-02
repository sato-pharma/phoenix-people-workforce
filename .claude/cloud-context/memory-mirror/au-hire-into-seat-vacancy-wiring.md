---
name: au-hire-into-seat-vacancy-wiring
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: Inserting a row in public.employees fires a trigger that seats the person ... Do NOT hand-write au.occupancy_history rows after an employee insert - the system has already written them (see `an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing`). Older text follows: PR #1411 — au.hire_into_seat wired via a position_vacancies trigger for REPLACEMENT hires only; brand-new headcount and transfers still unwired"
metadata: 
  node_type: memory
  type: project
  originSessionId: c6c301a6-eb56-4d59-8a41-01125ffb468e
  modified: 2026-07-28T09:29:45.853Z
---

PR #1411 (2026-07-28, branch `claude/au-hire-into-seat-wiring`, off `origin/main` post-#1399 —
NOT a continuation of the old `cranky-chebyshev-576239` branch, which was already merged).
Migration `20260728010000_au_wire_hire_into_seat_on_vacancy_fill.sql`: **APPLIED + VERIFIED ON
BOTH** 2026-07-28 — staging `cifwmndunmlxjhyjugxa` (recorded version `20260728082254`) and
production `ozucdzovmcqvepbozvqf` (recorded version `20260728083108`, same apply-timestamp-vs-
filename drift as every prior migration in this chain). PR #1411 **MERGED** to main 2026-07-28
11:35 Cairo as squash commit `b126a0ea` — repo and both DBs back in sync. Both envs' functional proof used IDENTICAL fully-synthetic rolled-back transactions
(`SEAT-TEST-HIRE-WIRING` etc.) — same trigger behavior confirmed on both: replacement-hire fill
→ correct auto-hire + audit log; headcount fill (negative control) → au untouched. Zero rows left
on either env. CI green on both commits before/after the secdef-guard fix.

**Design**: a trigger on `public.position_vacancies` (`AFTER UPDATE`, fires only when `status`
transitions to `'filled'`) reads `OLD.replacement_for_hr_id` (the departed predecessor — this
column already existed, set by the resignation flow), resolves that person's last occupied `au`
seat via new `au.f_last_occupied_seat_by_hr_id` (orders by `effective_to DESC` among **closed**
spans only — NOT `effective_from`, and NOT a bare equality lookup), and calls
`au.hire_into_seat`. Verified read-only against production before writing any code: all 6 real
open replacement vacancies from the original #1399 bug resolve, via nothing but occupancy
history, to exactly the 6 seats already fixed — zero title/tier guessing needed.

**Deliberately still unwired** (documented in `docs/area-unification/vacancy-models.md`):
- Brand-new headcount (vacancy with no `replacement_for_hr_id`) — no safe way to pick a seat
  without inventing a job_title→seat_tier map, which `src/lib/employees/access-role.ts` explicitly
  says not to trust job_title for.
- Employee transfers between seats while staying employed — `au.transfer_occupant` STILL has no
  application caller either; separate gap, not touched.

**Resign-side ORDER BY gap — NOW FIXED, PR #1416** (`20260728100000_au_resign_vacate_all_open_seats.sql`,
branch `claude/au-resign-vacate-all-open-seats`): `phx_resign_employee_and_open_vacancy` step 5
used `... limit 1` (no ORDER BY) so a multi-seat occupant would leave one seat stale on resign.
Fixed by LOOPING over ALL open person-spans (not just adding ORDER BY — deterministic-single would
still leave one stale). Only occupant affected = `B-1` (sole ACTING_DM: `SEAT-AIF-REP-UE1` +
`SEAT-AIF-ADM-UE-1`, both open). Migration mutates NO existing row (B-1 hasn't resigned; loop runs
once for all 131 single-seat occupants = byte-identical). **SHIPPED: applied+verified STAGING+PROD via the REAL
RPC against a synthetic dual-seat employee (both vacated, rolled back, B-1 untouched); PR #1416
MERGED `c097134d` 07-28 12:29 Cairo.** ⚠️ Migration `20260728100000` shares its timestamp with
#1415's independent `..._restore_report_rpc_statement_timeouts.sql` — BENIGN (both applied under
unique version keys, order-invariant, tests sort full filename); kept my filename matching the
applied DB name rather than renaming an already-applied migration.

**Employee transfers — INVESTIGATED, verdict DO-NOT-BUILD-YET** (documented in vacancy-models.md):
no transfer feature exists in the app at all (`grep transfer src/lib/employees` = nothing); editing
an active employee's area/line goes through `upsertEmployee` which touches `au.*` NOT AT ALL on the
update path (seat side effects gated behind `if(!isUpdate)`). So area/line edits are already
invisible to the seat model — a real latent gap. No `replacement_for_hr_id` equivalent exists for
transfers; destination-seat resolution would need net-new infra (open-span reverse resolver +
UI seat-picker or a same-tier inference rule). NOT a safe drop-in like the hire case was. Owner
decision whether to build.

**Observability limit, accepted on purpose**: `closeVacancyOnHire()` (TS) clears
`replacement_for_hr_id` to NULL in the SAME update that sets `status='filled'`, so nothing can
reconstruct "which vacancy should have triggered a hire" after the fact — `au.f_line_area_occupancy_drift()`
is blind to this trigger silently not firing (both au tables would just agree the seat is still
vacant). Mitigated with `public.audit_logs` rows (`entity_type: 'au_seat_hire'` /
`'au_seat_hire_failed'`) written by the trigger itself, not a drift check.

**Verification method**: fully synthetic data in a rolled-back transaction on staging
(`SEAT-TEST-HIRE-WIRING`, `TEST-PREDECESSOR-001`, `TEST-NEWHIRE-001/002`) — never touched a real
seat/employee/vacancy. Confirmed: replacement fill → correct auto-hire + audit log; parallel
headcount fill (negative control) → correctly touched au nothing. Zero rows left after rollback.

**Testing trap re-hit**: the pre-existing `migrations-secdef-revoke-guard.test.ts` requires the
LITERAL phrase `revoke execute on function ... from ... public ...` — writing `revoke all on
function ...` (functionally identical for a function object) fails it. Caught by running the full
suite before opening the PR, not assumed.

Follow-up to [[au-area-state-follows-seat-occupancy]]. See also
[[au-seat-occupant-period-aware-resolvers]].
