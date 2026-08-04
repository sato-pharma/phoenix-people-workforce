-- Outstation expenses — two photos and a captured workload before anything reaches payroll.
--
-- Owner request (2026-08-04). A submission currently auto-approves straight into payroll on the
-- strength of one GPS capture, plus a live car photo on CAR trips only. The new lifecycle is:
--
--   submit (location + ARRIVAL photo)  ->  pending_departure_photo
--   departure photo captured           ->  pending_workload
--   AM/PM workload captured per day    ->  pending  (the existing approval flow resumes here)
--
-- Owner decision, same date: NOTHING reaches payroll until all three are satisfied. That makes
-- this migration payroll-affecting, so the two safety properties below matter more than the
-- columns themselves.
--
-- ── SAFETY 1: the gate applies to NEW requests only ──────────────────────────────────────────
-- All 12 existing production requests are already decided (6 accepted_by_system, 3 approved,
-- 2 rejected_by_system, 1 rejected_by_admin) and several are already paid. Dropping them into
-- 'pending_departure_photo' would, under the owner's payroll rule, pull real money back out of
-- payroll for trips that happened weeks ago and can never now be photographed. Every existing
-- row is therefore stamped 'grandfathered' BEFORE the column default is switched to the strict
-- value — the order of the statements below is the safety property, not a style choice.
--
-- ── SAFETY 2: new rows fail CLOSED ───────────────────────────────────────────────────────────
-- Both gate columns end up NOT NULL with a strict default. A null gate state is not
-- representable, so a future insert that forgets to set one cannot land as "no gate known" and
-- be read as complete.
--
-- ── On reusing car_evidence_* as the ARRIVAL photo ───────────────────────────────────────────
-- Deliberately NOT renamed. Those columns already hold exactly what an arrival photo is — a live
-- in-app camera capture carrying GPS and a timestamp — and the 7 existing car photos ARE arrival
-- photos. Renaming would need a backfill, would break every current reader, and would buy only a
-- better name. The widened meaning is recorded as a column comment instead, so anyone reading
-- the schema sees it. Only the DEPARTURE side is new.

begin;

-- ── 1. Departure photo ───────────────────────────────────────────────────────────────────────

alter table public.outstation_expense_requests
  add column if not exists departure_evidence_image_path text,
  add column if not exists departure_evidence_metadata   jsonb,
  add column if not exists departure_captured_at         timestamptz;

comment on column public.outstation_expense_requests.car_evidence_image_path is
  'ARRIVAL photo (owner change 2026-08-04): the live in-app camera capture taken at the '
  'destination. Named car_* for history — it is now required for EVERY transportation type, not '
  'just car. Pairs with departure_evidence_image_path.';

comment on column public.outstation_expense_requests.departure_evidence_image_path is
  'DEPARTURE photo: the live in-app camera capture the employee must take before leaving the '
  'destination. Null until captured; the request holds at pending_departure_photo until then.';

-- ── 2. The two gates ─────────────────────────────────────────────────────────────────────────
-- Added nullable, backfilled, THEN defaulted and made NOT NULL — see SAFETY 1/2 above.

alter table public.outstation_expense_requests
  add column if not exists evidence_gate_status text,
  add column if not exists workload_gate_status text;

update public.outstation_expense_requests
   set evidence_gate_status = coalesce(evidence_gate_status, 'grandfathered'),
       workload_gate_status = coalesce(workload_gate_status, 'grandfathered')
 where evidence_gate_status is null
    or workload_gate_status is null;

alter table public.outstation_expense_requests
  alter column evidence_gate_status set default 'pending_arrival_photo',
  alter column workload_gate_status set default 'pending_workload';

alter table public.outstation_expense_requests
  alter column evidence_gate_status set not null,
  alter column workload_gate_status set not null;

-- 'grandfathered' is a real, permanent state, not a migration artifact: it is how the app tells
-- "this pre-dates the gate and must never be blocked by it" apart from "this satisfied the gate".
-- Collapsing the two would make an un-photographable July trip indistinguishable from a complete
-- August one.
alter table public.outstation_expense_requests
  drop constraint if exists outstation_evidence_gate_status_check;
alter table public.outstation_expense_requests
  add constraint outstation_evidence_gate_status_check
  check (evidence_gate_status in (
    'pending_arrival_photo',
    'pending_departure_photo',
    'complete',
    'grandfathered'
  ));

alter table public.outstation_expense_requests
  drop constraint if exists outstation_workload_gate_status_check;
alter table public.outstation_expense_requests
  add constraint outstation_workload_gate_status_check
  check (workload_gate_status in (
    'pending_workload',
    'complete',
    'manual',
    'grandfathered'
  ));

-- ── 3. Workload capture attempts, for the admin repair surface ───────────────────────────────
-- A failed grab must be visible and retryable rather than silently leaving the request stuck.
-- The error text is kept so an admin sees WHY it failed before deciding to enter it by hand.

alter table public.outstation_expense_requests
  add column if not exists workload_capture_attempts  integer not null default 0,
  add column if not exists workload_last_attempt_at   timestamptz,
  add column if not exists workload_last_attempt_error text;

-- The queue the repair screen reads: everything actually waiting on a gate. Partial, because the
-- overwhelming majority of rows are complete or grandfathered and must not sit in this index.
create index if not exists outstation_requests_pending_gate_idx
  on public.outstation_expense_requests (evidence_gate_status, workload_gate_status, created_at desc)
  where evidence_gate_status <> 'grandfathered'
    and (evidence_gate_status <> 'complete' or workload_gate_status not in ('complete', 'manual'));

-- ── 4. Workflow registry: the two new waiting states ─────────────────────────────────────────
-- workflow_registry_modules is CONFIG, and the owner can edit it through the workflow admin UI.
-- Every statement below is therefore additive and idempotent — the existing statuses and actions
-- are preserved and only extended, so a re-run (or an owner edit made in between) is not lost.
-- The one MODIFIED action is `submit`, whose target moves from 'pending' to the first gate.

-- ONE statement, not three. `workflow_registry_modules` carries a BEFORE UPDATE trigger
-- (phx_touch_workflow_registry_module) that sets `new.version = old.version + 1` and OVERWRITES
-- whatever the statement assigns — the module never controls its own version. Splitting this
-- into three updates therefore bumped the registry version by 3 per application (observed on
-- staging 2026-08-04: 4 -> 7 from a single apply). Collapsed into one statement, one application
-- moves the version exactly once, which is what the counter is supposed to mean.
--
-- Do NOT add `version` or `updated_at` to the SET list below: the trigger owns both, and
-- assigning them reads as intent that silently does nothing.
--
-- Every jsonb expression reads the OLD row (that is how UPDATE evaluates SET), and each is
-- guarded by a NOT EXISTS on the key it adds, so re-applying changes nothing. Verified on
-- staging: a second apply left statuses at 7 and actions at 9.
update public.workflow_registry_modules
   set statuses = statuses || coalesce((
         select jsonb_agg(candidate)
           from jsonb_array_elements('[
                  {"key": "pending_departure_photo", "label": "Pending Departure Photo", "terminal": false},
                  {"key": "pending_workload",        "label": "Pending Workload Capture", "terminal": false}
                ]'::jsonb) as candidate
          where not exists (
                select 1 from jsonb_array_elements(statuses) as existing
                 where existing->>'key' = candidate->>'key')
       ), '[]'::jsonb),
       -- `submit` is deliberately NOT retargeted here. It used to be, and applying that to
       -- production on 2026-08-04 broke every outstation submission for ~2 minutes until it was
       -- reverted.
       --
       -- Why: submitOutstationRequest calls assertOutstationExpenseWorkflowTransition with
       -- `expectedNextStatus: "pending"` (three call sites), and that helper THROWS when the
       -- registry's target does not match the string the code passed. The registry is the last
       -- gate before the write, so flipping `submit.to` without changing those three literals
       -- wedges the whole submit path — the same failure mode as the direct-orders chain
       -- incident earlier the same day, in the opposite direction.
       --
       -- It is not a deploy-ORDER problem that a later merge fixes: the code on the feature
       -- branch passes "pending" too. Retargeting submit therefore requires a code change that
       -- does not exist yet, and must ship in the same release as one — never from a migration
       -- on its own.
       --
       -- The two new statuses and actions below ARE added: they are inert to code that does not
       -- reference them, so they are safe ahead of the feature.
       actions = actions || coalesce((
         select jsonb_agg(candidate)
           from jsonb_array_elements('[
                  {
                    "key": "capture_departure_photo",
                    "label": "Capture departure photo",
                    "from": ["pending_departure_photo"],
                    "to": "pending_workload",
                    "allowedRoles": ["Employee", "Medical Rep", "District Manager", "Regional Manager",
                                     "National Sales Manager", "Product Manager", "Group Product Manager",
                                     "SFE Manager", "Training Manager", "Marketing Manager", "Manager",
                                     "Super Admin", "Finance Manager", "CEO"],
                    "auditLog": "Departure photo captured",
                    "sideEffects": ["store departure photo, its GPS and its capture time"],
                    "tests": ["a request with no departure photo never reaches payroll"],
                    "notifications": []
                  },
                  {
                    "key": "capture_workload",
                    "label": "Capture AM/PM workload",
                    "from": ["pending_workload"],
                    "to": "pending",
                    "allowedRoles": ["Super Admin", "Finance Manager", "CEO"],
                    "auditLog": "Trip workload captured",
                    "sideEffects": ["store per-day AM/PM workload and its evidence snapshot"],
                    "tests": ["a request with no captured workload never reaches payroll",
                              "a manually entered workload is marked manual, never as CRM evidence"],
                    "notifications": []
                  }
                ]'::jsonb) as candidate
          where not exists (
                select 1 from jsonb_array_elements(actions) as existing
                 where existing->>'key' = candidate->>'key')
       ), '[]'::jsonb),
       updated_by = 'outstation_two_photo_workload_gate'
 where module_key = 'outstation_expenses';

commit;
