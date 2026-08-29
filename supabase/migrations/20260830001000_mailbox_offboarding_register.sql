-- Mailbox offboarding register — the leaver half of the Turbify email lifecycle.
--
-- WHY THIS EXISTS. Measured on production 2026-08-29, before anything here was designed:
--
--   105 active employees, 103 holding a first.last@satopharma.com address (100% of the populated
--       ones follow that one shape — there is no second convention to accommodate).
--    52 LEAVERS still carrying a company address in the directory, 42 of whom left within the
--       last 90 days, the earliest on 2026-04-30.
--     1 clearance checklist has ever been opened, against 54 recorded resignations.
--
-- Phoenix already revokes everything Phoenix owns when someone leaves —
-- `deactivateEmployeeAccessIfSupported` flips `app_auth_users.is_active` and
-- `user_access_profiles.is_active` and disables Telegram. What no table anywhere records is
-- whether the person's MAILBOX was closed, because the mailbox does not live in Phoenix. It lives
-- in Turbify, and Turbify publishes no email API of any kind (its only public API is the
-- Merchant Solutions order API, which is ecommerce). So the mailbox half of an exit has always
-- been a human action with no memory attached to it, and 52 rows is what that produces.
--
-- ---------------------------------------------------------------------------
-- THE RULE THIS TABLE EXISTS TO ENFORCE: A PASSWORD RESET IS NOT A REVOCATION.
-- ---------------------------------------------------------------------------
-- Turbify Business Email runs on the Yahoo platform, and Yahoo's own documentation
-- (help.yahoo.com/kb/sln15241.html) states that third-party app passwords REMAIN ACTIVE after the
-- account password is changed — they have to be deleted explicitly. A leaver who ever set up mail
-- on a phone or in Outlook therefore keeps sending and receiving company mail after the reset that
-- everyone assumes closed the door, and the control panel shows nothing wrong.
--
-- That is why `phx_mailbox_offboarding_refresh_status` below will NOT report `revoked` on a
-- password reset alone. Revocation requires either the app passwords cleared as well, or a
-- disposition that makes them moot (the mailbox deleted or suspended). The rule is in plpgsql
-- rather than in the service for the same reason the clearance settlement gate is: a rule in a
-- page is bypassed by the next page. tests/mailbox-offboarding.test.ts pins the clause verbatim,
-- and that test runs in the required CI `validate` job.
--
-- ---------------------------------------------------------------------------
-- WHY THIS ONE IS BACKFILLED, WHEN CLEARANCE DELIBERATELY WAS NOT.
-- ---------------------------------------------------------------------------
-- 20260828160000 declined to backfill clearance for the 54 existing resignations, and was right
-- to: those checklists would have been 378 pending items of historical paperwork that nobody was
-- ever going to action, burying the live ones.
--
-- This is the opposite case and the distinction is the point. An un-actioned clearance station is
-- a missing signature on a departure that is otherwise finished. An un-actioned mailbox is a live
-- credential belonging to someone who does not work here — it is not a record of a past event, it
-- is a present exposure, and it is the exact thing the register is being built to find. Backfilling
-- is therefore not archaeology; it is the first inventory. The 52 rows land as `pending` with
-- source `backfill`, and the admin's real question — "is this mailbox actually still alive?" — is
-- answered per row against the Turbify control panel, not guessed here.
--
-- WHAT THIS DOES NOT DO: it never touches Turbify. Nothing in Phoenix can, and no row here should
-- ever be read as evidence that a mailbox was closed — only as a record that a named person said
-- they closed it, at a recorded time. That distinction is why every step column carries an actor.

begin;

-- ---------------------------------------------------------------------------
-- 1. The register
-- ---------------------------------------------------------------------------

create table if not exists public.mailbox_offboarding_tasks (
  id uuid primary key default gen_random_uuid(),

  -- The leaver. Not a foreign key to employees(hr_id) on purpose: hr_id is MIXED CASE in this
  -- database and joins on it are matched case-insensitively everywhere else (see the `lower()`
  -- comparisons throughout src/lib). A FK would impose exact-case matching that the rest of the
  -- system does not honour, and would block a task for someone whose directory row is later
  -- corrected. Uniqueness is enforced on the lowered value instead, by the index below.
  employee_hr_id text not null check (char_length(trim(employee_hr_id)) > 0),

  -- Snapshotted, exactly like hr_clearance_items.station_label. The person's name and address at
  -- the moment they left are what the audit trail is about; a later directory correction must not
  -- silently rewrite what this register says was revoked.
  employee_name text not null,
  work_email text not null check (position('@' in work_email) > 1),
  job_title text,
  last_working_date date,

  -- pending        — nothing recorded yet.
  -- in_progress    — at least one step recorded, but the mailbox is NOT yet closed.
  -- revoked        — the door is shut. See the refresh function for what earns this.
  -- not_applicable — there was no mailbox, or it was handled outside Phoenix. Requires a reason.
  --
  -- Only phx_mailbox_offboarding_refresh_status writes this column. No service recomputes it.
  status text not null default 'pending'
    check (status in ('pending', 'in_progress', 'revoked', 'not_applicable')),

  -- Step 1 — cuts webmail. On its own it cuts NOTHING else. See the header.
  password_reset_at timestamptz,
  password_reset_by text,

  -- Step 2 — cuts the phone, Outlook, and every other IMAP client. This is the step that closes
  -- the hole a reset leaves open, and the one most likely to be skipped because nothing in the
  -- control panel suggests it is outstanding.
  app_passwords_cleared_at timestamptz,
  app_passwords_cleared_by text,

  -- What ultimately happened to the mailbox itself.
  --   deleted   — gone. Terminal, and makes both steps above moot.
  --   suspended — retained but sign-in disabled. Also makes them moot.
  --   forwarding— still alive, delivering to someone else. Does NOT revoke anything by itself.
  --   retained  — deliberately left running (a shared or role address). Revokes nothing.
  disposition text
    check (disposition is null or disposition in ('deleted', 'suspended', 'forwarding', 'retained')),
  disposition_at timestamptz,
  disposition_by text,

  -- Only meaningful when disposition = 'forwarding'. The expiry is the point: forwarding set at an
  -- exit and never removed is how a leaver's mail quietly reaches someone for years.
  forwarding_to text,
  forwarding_expires_on date,

  -- Required by a CHECK for not_applicable, mirroring hr_clearance_items.reason.
  reason text,
  note text,

  source text not null default 'resignation'
    check (source in ('resignation', 'backfill', 'sweep')),

  opened_at timestamptz not null default now(),
  opened_by text,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A status that names a decision must carry the decision's reason, exactly as clearance does.
  constraint mailbox_offboarding_reason_required
    check (status <> 'not_applicable' or (reason is not null and char_length(trim(reason)) > 0)),

  -- Forwarding without a destination is a setting nobody can verify or unwind.
  constraint mailbox_offboarding_forwarding_target
    check (disposition is distinct from 'forwarding' or (forwarding_to is not null and char_length(trim(forwarding_to)) > 0))
);

-- One open task per person, case-insensitively — see the employee_hr_id note above. Partial, so a
-- rehire years later can legitimately have a second task once the first is closed out.
create unique index if not exists uq_mailbox_offboarding_open_employee
  on public.mailbox_offboarding_tasks (lower(employee_hr_id))
  where status in ('pending', 'in_progress');

create index if not exists idx_mailbox_offboarding_status
  on public.mailbox_offboarding_tasks (status, last_working_date);

create index if not exists idx_mailbox_offboarding_email
  on public.mailbox_offboarding_tasks (lower(work_email));

-- Forwarding that is due to be torn down. Queried by the daily sweep.
create index if not exists idx_mailbox_offboarding_forwarding_expiry
  on public.mailbox_offboarding_tasks (forwarding_expires_on)
  where disposition = 'forwarding';

comment on table public.mailbox_offboarding_tasks is
  'Turbify mailbox revocation register for leavers. A row records that a named admin SAID a step '
  'was performed at a recorded time — Phoenix cannot verify Turbify, which has no email API.';

comment on column public.mailbox_offboarding_tasks.app_passwords_cleared_at is
  'The step that actually cuts IMAP. Yahoo app passwords survive a password change and must be '
  'deleted explicitly, so a reset alone leaves phone and Outlook access live.';

-- ---------------------------------------------------------------------------
-- 2. Status — the rule, in the database
-- ---------------------------------------------------------------------------

create or replace function public.phx_mailbox_offboarding_refresh_status(p_task_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.mailbox_offboarding_tasks%rowtype;
  v_status text;
begin
  select * into v_row from public.mailbox_offboarding_tasks where id = p_task_id;
  if not found then
    raise exception 'Mailbox offboarding task % was not found.', p_task_id;
  end if;

  -- An explicit not_applicable is a decision, not a computed state. Nothing recomputes it away.
  if v_row.status = 'not_applicable' then
    return v_row.status;
  end if;

  -- REVOKED, and the whole point of this function.
  --
  -- Deleting or suspending the mailbox ends it outright: there is nothing left for an app password
  -- to authenticate against. Short of that, BOTH steps are required — the password reset closes
  -- webmail and the app-password clear closes every third-party client. A reset on its own is
  -- deliberately NOT enough, because Yahoo app passwords survive a password change (see the
  -- migration header). Weakening this condition to `password_reset_at is not null` would make the
  -- register report a door as shut while it is standing open, which is worse than no register.
  --
  -- 'forwarding' and 'retained' are NOT revocations — both describe a mailbox that is still alive.
  if v_row.disposition in ('deleted', 'suspended')
     or (v_row.password_reset_at is not null and v_row.app_passwords_cleared_at is not null) then
    v_status := 'revoked';
  elsif v_row.password_reset_at is not null
     or v_row.app_passwords_cleared_at is not null
     or v_row.disposition is not null then
    v_status := 'in_progress';
  else
    v_status := 'pending';
  end if;

  update public.mailbox_offboarding_tasks
  set status = v_status,
      -- Stamped once, on the transition. Re-running this must not move the revocation time.
      revoked_at = case
        when v_status = 'revoked' then coalesce(revoked_at, now())
        else null
      end,
      updated_at = now()
  where id = p_task_id;

  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Opening a task
-- ---------------------------------------------------------------------------

create or replace function public.phx_mailbox_offboarding_open(
  p_employee_hr_id text,
  p_actor text,
  p_source text default 'resignation'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee record;
  v_existing uuid;
  v_task_id uuid;
begin
  -- lower() on BOTH sides. hr_id is mixed case in this database and a plain `=` silently
  -- under-returns — the failure that hid 28% of reps' own orders and 100% of occupancy joins.
  select e.hr_id, e.full_name, e.work_email, e.job_title, e.last_working_date, e.employment_status
  into v_employee
  from public.employees e
  where lower(e.hr_id) = lower(trim(p_employee_hr_id))
  limit 1;

  if not found then
    raise exception 'No employee matches HR ID %.', p_employee_hr_id;
  end if;

  -- No mailbox, nothing to revoke. Returning null rather than raising: the caller is usually the
  -- exit workflow, and an employee who never had an address is a normal case, not an error.
  if v_employee.work_email is null or char_length(trim(v_employee.work_email)) = 0 then
    return null;
  end if;

  select id into v_existing
  from public.mailbox_offboarding_tasks
  where lower(employee_hr_id) = lower(v_employee.hr_id)
    and status in ('pending', 'in_progress')
  limit 1;

  -- Idempotent by design. The exit workflow, the daily sweep and a manual open all call this, and
  -- two of them run unattended — a second task would split one person's evidence across two rows.
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.mailbox_offboarding_tasks (
    employee_hr_id, employee_name, work_email, job_title, last_working_date, source, opened_by
  )
  values (
    v_employee.hr_id,
    coalesce(nullif(trim(v_employee.full_name), ''), v_employee.hr_id),
    trim(v_employee.work_email),
    v_employee.job_title,
    v_employee.last_working_date,
    case when p_source in ('resignation', 'backfill', 'sweep') then p_source else 'resignation' end,
    p_actor
  )
  returning id into v_task_id;

  return v_task_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Recording a step
-- ---------------------------------------------------------------------------

create or replace function public.phx_mailbox_offboarding_record(
  p_task_id uuid,
  p_step text,
  p_actor text,
  p_disposition text default null,
  p_forwarding_to text default null,
  p_forwarding_expires_on date default null,
  p_reason text default null,
  p_note text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.mailbox_offboarding_tasks%rowtype;
begin
  select * into v_row from public.mailbox_offboarding_tasks where id = p_task_id;
  if not found then
    raise exception 'Mailbox offboarding task % was not found.', p_task_id;
  end if;

  -- A revoked row is frozen against further steps, but NOT against correction — see the 'reopen'
  -- branch below. A register with no correction path is a defect this repository has already paid
  -- for once: the marketing licence verdict is write-once at approval, and because the write gate
  -- requires a step that stops existing the moment the request is decided, not even a Super Admin
  -- can fix a wrong one. It is then displayed on a register indefinitely. The same shape here —
  -- an admin ticking "app passwords cleared" on the wrong row — would permanently assert that a
  -- live mailbox is shut, which is precisely the false negative this whole table exists to prevent.
  if v_row.status = 'revoked' and p_step <> 'reopen' then
    raise exception 'This mailbox is already recorded as revoked. Reopen it before recording anything further.';
  end if;

  if p_actor is null or char_length(trim(p_actor)) = 0 then
    raise exception 'A step must record who performed it.';
  end if;

  if p_step = 'password_reset' then
    -- coalesce, not overwrite: the first admin to do it is who did it.
    update public.mailbox_offboarding_tasks
    set password_reset_at = coalesce(password_reset_at, now()),
        password_reset_by = coalesce(password_reset_by, p_actor),
        note = coalesce(nullif(trim(p_note), ''), note),
        updated_at = now()
    where id = p_task_id;

  elsif p_step = 'app_passwords_cleared' then
    update public.mailbox_offboarding_tasks
    set app_passwords_cleared_at = coalesce(app_passwords_cleared_at, now()),
        app_passwords_cleared_by = coalesce(app_passwords_cleared_by, p_actor),
        note = coalesce(nullif(trim(p_note), ''), note),
        updated_at = now()
    where id = p_task_id;

  elsif p_step = 'disposition' then
    if p_disposition is null or p_disposition not in ('deleted', 'suspended', 'forwarding', 'retained') then
      raise exception 'A disposition must be one of deleted, suspended, forwarding or retained.';
    end if;
    if p_disposition = 'forwarding' and (p_forwarding_to is null or char_length(trim(p_forwarding_to)) = 0) then
      raise exception 'Forwarding needs a destination address.';
    end if;

    update public.mailbox_offboarding_tasks
    set disposition = p_disposition,
        disposition_at = now(),
        disposition_by = p_actor,
        forwarding_to = case when p_disposition = 'forwarding' then trim(p_forwarding_to) else null end,
        forwarding_expires_on = case when p_disposition = 'forwarding' then p_forwarding_expires_on else null end,
        note = coalesce(nullif(trim(p_note), ''), note),
        updated_at = now()
    where id = p_task_id;

  elsif p_step = 'reopen' then
    if p_reason is null or char_length(trim(p_reason)) = 0 then
      raise exception 'Reopening a mailbox record needs a written reason.';
    end if;
    -- Clears the current state back to pending. The history is NOT lost: every step writes an
    -- audit row through writeRequiredAuditLog before it calls this function, so what was claimed,
    -- by whom and when survives the correction. This row is current state, the audit log is record.
    update public.mailbox_offboarding_tasks
    set status = 'pending',
        password_reset_at = null,
        password_reset_by = null,
        app_passwords_cleared_at = null,
        app_passwords_cleared_by = null,
        disposition = null,
        disposition_at = null,
        disposition_by = null,
        forwarding_to = null,
        forwarding_expires_on = null,
        revoked_at = null,
        reason = trim(p_reason),
        note = coalesce(nullif(trim(p_note), ''), note),
        updated_at = now()
    where id = p_task_id;
    return 'pending';

  elsif p_step = 'not_applicable' then
    if p_reason is null or char_length(trim(p_reason)) = 0 then
      raise exception 'Marking a mailbox not applicable needs a written reason.';
    end if;
    update public.mailbox_offboarding_tasks
    set status = 'not_applicable',
        reason = trim(p_reason),
        note = coalesce(nullif(trim(p_note), ''), note),
        updated_at = now()
    where id = p_task_id;
    return 'not_applicable';

  else
    raise exception 'Unknown mailbox offboarding step %.', p_step;
  end if;

  return public.phx_mailbox_offboarding_refresh_status(p_task_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. The first inventory — see the header for why this one IS backfilled
-- ---------------------------------------------------------------------------

insert into public.mailbox_offboarding_tasks (
  employee_hr_id, employee_name, work_email, job_title, last_working_date, source, opened_by
)
select
  e.hr_id,
  coalesce(nullif(trim(e.full_name), ''), e.hr_id),
  trim(e.work_email),
  e.job_title,
  e.last_working_date,
  'backfill',
  'migration:20260830001000'
from public.employees e
where e.employment_status in ('resigned', 'terminated')
  and e.work_email is not null
  and char_length(trim(e.work_email)) > 0
  and not exists (
    select 1
    from public.mailbox_offboarding_tasks t
    where lower(t.employee_hr_id) = lower(e.hr_id)
      and t.status in ('pending', 'in_progress')
  );

-- ---------------------------------------------------------------------------
-- 6. RLS and grants
-- ---------------------------------------------------------------------------

-- Visibility in this app is application-scoped (AGENTS.md §8) — every read here goes through the
-- service-role client behind an assertPermission call. RLS on with no authenticated grant is the
-- norm in this database (222 of 308 tables) and is the correct posture for an admin-only register
-- holding leavers' addresses: no browser session reaches this table at all.
alter table public.mailbox_offboarding_tasks enable row level security;

-- A SECURITY DEFINER function runs as its owner and bypasses RLS by design, so the default ACL
-- granting EXECUTE to PUBLIC is a hole straight through the posture above. Revoking PUBLIC also
-- strips service_role, so each is re-granted explicitly.
revoke execute on function public.phx_mailbox_offboarding_refresh_status(p_task_id uuid) from public, anon, authenticated;
grant execute on function public.phx_mailbox_offboarding_refresh_status(p_task_id uuid) to service_role;

revoke execute on function public.phx_mailbox_offboarding_open(p_employee_hr_id text, p_actor text, p_source text) from public, anon, authenticated;
grant execute on function public.phx_mailbox_offboarding_open(p_employee_hr_id text, p_actor text, p_source text) to service_role;

revoke execute on function public.phx_mailbox_offboarding_record(p_task_id uuid, p_step text, p_actor text, p_disposition text, p_forwarding_to text, p_forwarding_expires_on date, p_reason text, p_note text) from public, anon, authenticated;
grant execute on function public.phx_mailbox_offboarding_record(p_task_id uuid, p_step text, p_actor text, p_disposition text, p_forwarding_to text, p_forwarding_expires_on date, p_reason text, p_note text) to service_role;

commit;
