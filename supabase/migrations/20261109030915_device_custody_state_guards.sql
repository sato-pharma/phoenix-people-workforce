-- device_custody_state_guards
--
-- WHAT THIS CHANGES: replaces two custody functions, `phx_device_mark` and `phx_device_reconcile`,
-- with the same bodies plus three refusals and a row lock. No table, column, index, row or grant
-- changes meaning; no money is touched (no value, settlement or item price is read differently).
--
-- WHY (the 9 Nov 2026 register audit):
--
--   1. `phx_device_mark` never looked at a RESERVATION. Marking a reserved device "in stock" left its
--      `reserved` assignment live on an in-stock device — which then could not be issued (the
--      one-live-claim index `uq_device_assignments_live_device` refuses a second claim) and could not
--      be revoked either (`phx_device_revoke` only resets a device still `reserved`). Marking it lost,
--      stolen, retired or in repair left a reservation that reconcile would later turn into a signed
--      custody. A reserved device's state is now changed only after the reservation is ended.
--
--   2. `phx_device_reconcile` moved the device to `assigned` WHATEVER state it was in, so a reserved
--      tablet marked lost in the meantime came out as a signed custody, its value frozen under
--      البند (9), for a machine nobody could hand over. It now requires the device to be `reserved`.
--
--   3. `phx_device_reconcile` bound the reservation to any hr_id that existed, a leaver included. A
--      day-one handover to somebody who has resigned or been terminated cannot have happened. It now
--      refuses one. (`phx_device_issue` is left as it is on purpose: the bulk import records custody a
--      leaver ALREADY holds, which is the exposure the register exists to show; the app refuses a new
--      handover to a leaver in `issueDevice`.)
--
--   4. Neither function locked what it read, so a mark racing an issue could put a signed-out
--      device back "in stock", and two reconciles of one reservation could both write. Each now
--      takes `for update` on the rows it decides on.
--
-- The app refuses all three with readable sentences before calling (`markRefusal`,
-- `reconcileRefusal`, `holderRefusal` in src/lib/devices/service.ts); this is the database half, so
-- the rule holds for every caller.
--
-- ROLLBACK: re-run sections 5 and 6 of 20260907220000_company_device_register.sql (phx_device_mark)
-- and section 6 of 20260928230000_device_assignment_placeholder_reservation.sql (phx_device_reconcile).
-- Both are `create or replace` with unchanged signatures, so the grants below survive either way.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This migration is neither: it writes no row.

begin;

-- ---------------------------------------------------------------------------
-- 1. Marking a device — now refused while the device is reserved.
-- ---------------------------------------------------------------------------
create or replace function public.phx_device_mark(
  p_device_id uuid,
  p_status text,
  p_actor text,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.company_devices%rowtype;
begin
  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'A device status change must record who made it.';
  end if;

  -- Locked: an issue or a reservation racing this mark waits, and the checks below read what it left.
  select * into v_device from public.company_devices where id = p_device_id for update;
  if not found then
    raise exception 'Device % was not found.', p_device_id;
  end if;

  if p_status not in ('in_stock', 'repair', 'lost', 'stolen', 'retired') then
    raise exception 'Unknown device status %. Issue a device to make it assigned.', p_status;
  end if;

  if p_status in ('lost', 'stolen', 'retired', 'repair')
     and (p_reason is null or char_length(trim(p_reason)) = 0) then
    raise exception 'Marking a device % needs a written reason.', p_status;
  end if;

  -- NEW. A reservation is ended (revoked, or reconciled on day one) before the device's state moves.
  if v_device.status = 'reserved' or exists (
    select 1 from public.device_assignments
    where device_id = p_device_id and status = 'reserved'
  ) then
    raise exception
      'Marking % is refused while it is reserved for somebody. Revoke the reservation (or reconcile it) first.',
      v_device.asset_tag;
  end if;

  -- Unchanged: a lost or stolen device does NOT release its holder (البند 10, 11), and a device that
  -- is signed out is never put back in stock by hand — its return is recorded instead.
  if p_status = 'in_stock' and exists (
    select 1 from public.device_assignments
    where device_id = p_device_id and status = 'outstanding'
  ) then
    raise exception
      'Device % is signed out. Record the return (محضر رد العهدة) rather than putting it back in stock.',
      v_device.asset_tag;
  end if;

  update public.company_devices
  set status = p_status,
      status_reason = nullif(trim(p_reason), ''),
      status_changed_at = now(),
      status_changed_by = p_actor,
      updated_at = now()
  where id = p_device_id;

  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Reconcile — now refused unless the device is still reserved, and refused for a leaver.
-- ---------------------------------------------------------------------------
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

  -- Locked, so two presses on one reservation cannot both write.
  select * into v_row from public.device_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'Device assignment % was not found.', p_assignment_id;
  end if;
  if v_row.status <> 'reserved' or not v_row.is_placeholder then
    raise exception 'Only a reservation can be reconciled to an employee.';
  end if;

  select * into v_device from public.company_devices where id = v_row.device_id for update;
  if not found then
    raise exception 'Device % was not found.', v_row.device_id;
  end if;

  -- NEW. A reserved device marked lost, stolen, retired or in repair is not in the building.
  if v_device.status <> 'reserved' then
    raise exception
      'Reconciling % is refused: the device is %, not reserved, so it cannot be handed over.',
      v_device.asset_tag, v_device.status;
  end if;

  -- lower() on both sides — hr_id is mixed case in this database (see the register migration).
  select e.hr_id, e.full_name, e.nickname, e.job_title, e.employment_status
  into v_employee
  from public.employees e
  where lower(e.hr_id) = lower(trim(p_employee_hr_id))
  limit 1;
  if not found then
    raise exception 'No employee matches HR ID %.', p_employee_hr_id;
  end if;

  -- NEW. `employment_status` is stored in mixed case ('Resigned' and 'resigned' are both present).
  if lower(trim(coalesce(v_employee.employment_status, ''))) in ('resigned', 'terminated') then
    raise exception
      'Reconciling a reservation to % is refused: they have left the company (%).',
      coalesce(nullif(trim(v_employee.full_name), ''), v_employee.hr_id),
      lower(trim(v_employee.employment_status));
  end if;

  update public.device_assignments
  set status = 'outstanding',
      is_placeholder = false,
      placeholder_name = null,
      employee_hr_id = v_employee.hr_id,
      employee_name = coalesce(nullif(trim(v_employee.full_name), ''), v_employee.hr_id),
      job_title = v_employee.job_title,
      -- Frozen HERE, at the day-one signature — البند (9). Unchanged from the reservation migration.
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
-- 3. Grants — service_role only, exactly as before. Re-stated because a replaced SECURITY DEFINER
--    function must carry its own revoke from PUBLIC in the file that replaces it.
-- ---------------------------------------------------------------------------
revoke execute on function public.phx_device_mark(p_device_id uuid, p_status text, p_actor text, p_reason text) from public, anon, authenticated;
grant execute on function public.phx_device_mark(p_device_id uuid, p_status text, p_actor text, p_reason text) to service_role;

revoke execute on function public.phx_device_reconcile(p_assignment_id uuid, p_employee_hr_id text, p_actor text, p_declaration_no text, p_handover_place text, p_issued_on date) from public, anon, authenticated;
grant execute on function public.phx_device_reconcile(p_assignment_id uuid, p_employee_hr_id text, p_actor text, p_declaration_no text, p_handover_place text, p_issued_on date) to service_role;

commit;
