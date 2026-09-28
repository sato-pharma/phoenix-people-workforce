-- Device custody — reservations for a not-yet-hired holder, and the day-one reconcile.
--
-- WHY THIS EXISTS. `20260907220000_company_device_register.sql` built the custody register around a
-- SIGNED receipt (إقرار استلام عهدة): a device is `assigned` only when a named, existing employee has
-- signed for it, its value FROZEN at signature (البند 9) and recovery capped at that figure (البند 10).
-- That leaves one real workflow unmodelled: a tablet is set aside for a rep who has NOT started yet,
-- and handed over — signed for — on day one.
--
-- The owner's decision (2026-09-28): a pre-provision is a RESERVATION, not a signed custody. It owes
-- nothing and freezes no value, because nobody has signed. On day one it is RECONCILED to the hired
-- employee, and THAT is the moment the real signed custody is created — value frozen then, البند 9/10
-- intact. So this migration adds:
--   * a `reserved` device state and `reserved`/`revoked` assignment states;
--   * a placeholder holder (a typed name, no hr_id, no value);
--   * phx_device_reserve / _revoke / _reassign_placeholder / _reconcile.
--
-- It touches NO existing row's meaning: every current assignment is a real one (is_placeholder defaults
-- false, employee_hr_id already present), so it satisfies the new holder-identity check on branch two,
-- and no current device is `reserved`.

begin;

-- ---------------------------------------------------------------------------
-- 1. A device can now be RESERVED — earmarked, not issuable to anyone else.
-- ---------------------------------------------------------------------------
-- `reserved` sits beside `assigned`: both mean the device is spoken for and not in stock, so
-- phx_device_issue's `status <> 'in_stock'` guard already refuses to issue a reserved device with a
-- readable error. It carries no reason (it is benign), so company_devices_status_reason_required — which
-- names only lost/stolen/retired/repair — is left exactly as it is.
alter table public.company_devices drop constraint if exists company_devices_status_check;
alter table public.company_devices add constraint company_devices_status_check
  check (status in ('in_stock', 'assigned', 'repair', 'lost', 'stolen', 'retired', 'reserved'));

-- ---------------------------------------------------------------------------
-- 2. An assignment can now be a placeholder reservation.
-- ---------------------------------------------------------------------------
-- A reservation has no signatory, so the two NOT NULLs that assume one are relaxed and a holder-identity
-- CHECK takes their place: a row is EITHER a real holder (an hr_id and a name, is_placeholder false) OR a
-- placeholder (a typed name, no hr_id, is_placeholder true). The existing char-length check on
-- employee_hr_id passes on NULL, so a placeholder row is fine under it.
alter table public.device_assignments add column if not exists is_placeholder boolean not null default false;
alter table public.device_assignments add column if not exists placeholder_name text;

alter table public.device_assignments alter column employee_hr_id drop not null;
alter table public.device_assignments alter column employee_name drop not null;

alter table public.device_assignments drop constraint if exists device_assignments_holder_identity;
alter table public.device_assignments add constraint device_assignments_holder_identity check (
  (is_placeholder = true
     and employee_hr_id is null
     and placeholder_name is not null and char_length(trim(placeholder_name)) > 0)
  or
  (is_placeholder = false
     and employee_hr_id is not null and char_length(trim(employee_hr_id)) > 0
     and employee_name is not null)
);

-- reserved — earmarked for a placeholder. Owes nothing; freezes no value.
-- revoked  — a reservation cancelled before it was ever signed for. A signed custody NEVER reaches this
--            state; it closes only by a recorded return or a written-off reason, as before.
alter table public.device_assignments drop constraint if exists device_assignments_status_check;
alter table public.device_assignments add constraint device_assignments_status_check
  check (status in ('outstanding', 'returned', 'written_off', 'reserved', 'revoked'));

-- One LIVE claim per device — a reservation is a claim too, so a reserved device cannot also be issued
-- and two reservations cannot race for one device. Replaces the outstanding-only index.
drop index if exists public.uq_device_assignments_outstanding_device;
create unique index if not exists uq_device_assignments_live_device
  on public.device_assignments (device_id)
  where status in ('outstanding', 'reserved');

comment on column public.device_assignments.is_placeholder is
  'True while this row is a reservation for a not-yet-hired holder — no hr_id, no signed value. '
  'Cleared by phx_device_reconcile on day one, which turns it into a real signed custody.';

-- ---------------------------------------------------------------------------
-- 3. Reserve a device for a typed name.
-- ---------------------------------------------------------------------------
create or replace function public.phx_device_reserve(
  p_device_id uuid,
  p_placeholder_name text,
  p_actor text,
  p_declaration_no text default null,
  p_handover_place text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.company_devices%rowtype;
  v_assignment_id uuid;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'Reserving a device must record who did it.';
  end if;
  if p_placeholder_name is null or char_length(trim(p_placeholder_name)) = 0 then
    raise exception 'A reservation needs the name it is being held for.';
  end if;

  select * into v_device from public.company_devices where id = p_device_id;
  if not found then
    raise exception 'Device % was not found.', p_device_id;
  end if;

  if v_device.status <> 'in_stock' then
    raise exception 'Device % is %, not in stock. Only a device in stock can be reserved.',
      v_device.asset_tag, v_device.status;
  end if;

  if exists (
    select 1 from public.device_assignments
    where device_id = p_device_id and status in ('outstanding', 'reserved')
  ) then
    raise exception 'Device % already has a live holder or reservation.', v_device.asset_tag;
  end if;

  insert into public.device_assignments (
    device_id, employee_hr_id, employee_name, is_placeholder, placeholder_name,
    declaration_no, handover_place, issued_by, agreed_value_egp, status, note
  )
  values (
    p_device_id, null, null, true, trim(p_placeholder_name),
    nullif(trim(p_declaration_no), ''), nullif(trim(p_handover_place), ''), p_actor,
    null, 'reserved', nullif(trim(p_note), '')
  )
  returning id into v_assignment_id;

  update public.company_devices
  set status = 'reserved',
      status_reason = null,
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = p_device_id;

  return v_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reassign a reservation to a different name (still nobody has signed).
-- ---------------------------------------------------------------------------
create or replace function public.phx_device_reassign_placeholder(
  p_assignment_id uuid,
  p_new_name text,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.device_assignments%rowtype;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'Reassigning a reservation must record who did it.';
  end if;
  if p_new_name is null or char_length(trim(p_new_name)) = 0 then
    raise exception 'A reservation needs the name it is being held for.';
  end if;

  select * into v_row from public.device_assignments where id = p_assignment_id;
  if not found then
    raise exception 'Device assignment % was not found.', p_assignment_id;
  end if;
  if v_row.status <> 'reserved' or not v_row.is_placeholder then
    raise exception 'Only a reservation can be reassigned to a different name. A signed custody is moved by recording its return and issuing it again.';
  end if;

  update public.device_assignments
  set placeholder_name = trim(p_new_name),
      updated_at = now()
  where id = p_assignment_id;

  return p_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Revoke a reservation — cancel it before anyone signs.
-- ---------------------------------------------------------------------------
create or replace function public.phx_device_revoke(
  p_assignment_id uuid,
  p_actor text,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.device_assignments%rowtype;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'Revoking a reservation must record who did it.';
  end if;

  select * into v_row from public.device_assignments where id = p_assignment_id;
  if not found then
    raise exception 'Device assignment % was not found.', p_assignment_id;
  end if;
  -- A signed custody is never revoked: البند (8) proves a return by a محضر رد العهدة, and البند (10)
  -- makes an unreturned device a debt closed only by a written-off reason. Revoke is for a reservation
  -- nobody has signed for yet.
  if v_row.status <> 'reserved' then
    raise exception 'Only a reservation can be revoked. A signed-out device must be returned (محضر رد العهدة) or written off.';
  end if;

  update public.device_assignments
  set status = 'revoked',
      reason = coalesce(nullif(trim(p_reason), ''), reason),
      updated_at = now()
  where id = p_assignment_id;

  update public.company_devices
  set status = 'in_stock',
      status_reason = null,
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = v_row.device_id and status = 'reserved';

  return 'revoked';
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Reconcile — day one. The reservation becomes a real signed custody.
-- ---------------------------------------------------------------------------
-- This IS the issue moment: the hired employee is bound, the device's value is frozen onto the row
-- (البند 9), and the device moves to `assigned`. The same row transitions reserved -> outstanding, so
-- the one-live-claim index is never violated and the reservation's own history (who it was held for,
-- when) is preserved rather than discarded.
create or replace function public.phx_device_reconcile(
  p_assignment_id uuid,
  p_employee_hr_id text,
  p_actor text,
  p_declaration_no text default null,
  p_handover_place text default null,
  p_issued_on date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.device_assignments%rowtype;
  v_device public.company_devices%rowtype;
  v_employee record;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'Reconciling a reservation must record who handed the device over.';
  end if;

  select * into v_row from public.device_assignments where id = p_assignment_id;
  if not found then
    raise exception 'Device assignment % was not found.', p_assignment_id;
  end if;
  if v_row.status <> 'reserved' or not v_row.is_placeholder then
    raise exception 'Only a reservation can be reconciled to an employee.';
  end if;

  select * into v_device from public.company_devices where id = v_row.device_id;

  -- lower() on both sides — hr_id is mixed case in this database (see the register migration).
  select e.hr_id, e.full_name, e.nickname, e.job_title
  into v_employee
  from public.employees e
  where lower(e.hr_id) = lower(trim(p_employee_hr_id))
  limit 1;
  if not found then
    raise exception 'No employee matches HR ID %.', p_employee_hr_id;
  end if;

  update public.device_assignments
  set status = 'outstanding',
      is_placeholder = false,
      placeholder_name = null,
      employee_hr_id = v_employee.hr_id,
      employee_name = coalesce(nullif(trim(v_employee.full_name), ''), v_employee.hr_id),
      job_title = v_employee.job_title,
      -- Frozen HERE, at the day-one signature — البند (9). A reservation carried no value.
      agreed_value_egp = v_device.estimated_value_egp,
      declaration_no = coalesce(nullif(trim(p_declaration_no), ''), declaration_no),
      handover_place = coalesce(nullif(trim(p_handover_place), ''), handover_place),
      issued_on = coalesce(p_issued_on, (now() at time zone 'Africa/Cairo')::date),
      issued_by = p_actor,
      updated_at = now()
  where id = p_assignment_id;

  update public.company_devices
  set status = 'assigned',
      status_reason = null,
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = v_row.device_id;

  return p_assignment_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants — service_role only, like every function in the register.
-- ---------------------------------------------------------------------------
revoke execute on function public.phx_device_reserve(p_device_id uuid, p_placeholder_name text, p_actor text, p_declaration_no text, p_handover_place text, p_note text) from public, anon, authenticated;
grant execute on function public.phx_device_reserve(p_device_id uuid, p_placeholder_name text, p_actor text, p_declaration_no text, p_handover_place text, p_note text) to service_role;

revoke execute on function public.phx_device_reassign_placeholder(p_assignment_id uuid, p_new_name text, p_actor text) from public, anon, authenticated;
grant execute on function public.phx_device_reassign_placeholder(p_assignment_id uuid, p_new_name text, p_actor text) to service_role;

revoke execute on function public.phx_device_revoke(p_assignment_id uuid, p_actor text, p_reason text) from public, anon, authenticated;
grant execute on function public.phx_device_revoke(p_assignment_id uuid, p_actor text, p_reason text) to service_role;

revoke execute on function public.phx_device_reconcile(p_assignment_id uuid, p_employee_hr_id text, p_actor text, p_declaration_no text, p_handover_place text, p_issued_on date) from public, anon, authenticated;
grant execute on function public.phx_device_reconcile(p_assignment_id uuid, p_employee_hr_id text, p_actor text, p_declaration_no text, p_handover_place text, p_issued_on date) to service_role;

commit;
