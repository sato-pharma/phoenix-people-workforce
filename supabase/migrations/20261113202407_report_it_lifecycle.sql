-- report_it_lifecycle
--
-- WHAT THIS CHANGES (audit REC-033 — a safety report gets a lifecycle and an owner):
--   1. public.report_it_reports gains five nullable columns: assessment_started_at, assessed_by_hr_id,
--      closed_at, closed_by_hr_id, due_at. No foreign key is added — an hr_id column is never
--      FK'd to employees(hr_id) in this module (the mixed-case trap that broke filing on 2026-06-10).
--   2. Existing rows with status 'submitted' become 'received' (the owner's mapping, 13 Nov 2026).
--      No other value is touched: the pre-check below ABORTS the whole migration if any row holds a
--      status other than 'submitted', 'received', 'under_assessment' or 'closed'.
--   3. due_at is backfilled for every row that has none, from the date the report was submitted
--      (created_at): 15 calendar days for a serious report, 90 for the rest. NOTHING IN THIS
--      REPOSITORY STATED A DUE RULE, so this is the owner's brief default, which follows common
--      pharmacovigilance practice (ICH E2D / EU GVP Module VI: a serious case is reported within
--      15 calendar days, a non-serious one within 90). The same two numbers live in
--      src/lib/report-it/lifecycle.ts (REPORT_IT_DUE_DAYS) and a test pins that they match.
--   4. The status default becomes 'received', and a check constraint allows only
--      'received', 'under_assessment', 'closed' — the three statuses in src/lib/report-it/types.ts.
--   5. A partial index on due_at for the open reports, which is exactly the desk's due-date view.
--   5b. A BEFORE INSERT trigger (report_it_lifecycle_defaults) that turns an incoming 'submitted' into
--      'received' and fills due_at by the same rule. So filing a report NEVER depends on the order of
--      this migration and the deploy: the code running today still inserts 'submitted' and is not
--      refused by the new check, and the new code sends no due_at at all.
--   6. public.phx_report_it_set_status(report_id, from, to, actor, metadata): moves one report one
--      step (received -> under_assessment -> closed; there is no reopen) AND writes its
--      report_it_audit_logs row in the same transaction. Executable by service_role only.
--   RLS and table grants are unchanged.
--
-- WHY: until now a report was inserted 'submitted' and nothing ever changed it or told anyone.
--   The owner of every new report is whoever holds report_it_dashboard_access (the QPPV today);
--   she follows open reports on her Report It desk by due date and moves them through the statuses.
--
-- PRE-CHECK (run before applying; the DO block below enforces the same thing):
--   select status, count(*) from public.report_it_reports group by status order by status;
--   Expected: only 'submitted' (and, if re-run, 'received' / 'under_assessment' / 'closed').
--
-- ROLLBACK (in this order):
--   drop trigger if exists report_it_reports_lifecycle_defaults on public.report_it_reports;
--   drop function if exists public.report_it_lifecycle_defaults();
--   drop function if exists public.phx_report_it_set_status(uuid, text, text, text, jsonb);
--   drop index if exists public.idx_report_it_open_due;
--   alter table public.report_it_reports drop constraint if exists report_it_reports_status_check;
--   alter table public.report_it_reports alter column status set default 'submitted';
--   update public.report_it_reports set status = 'submitted' where status = 'received';
--   alter table public.report_it_reports drop column if exists due_at, drop column if exists closed_by_hr_id,
--     drop column if exists closed_at, drop column if exists assessed_by_hr_id,
--     drop column if exists assessment_started_at;
--   Rolling back loses every status change made after this migration (the audit rows stay).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

-- ── Pre-check: no status outside the known set, or nothing is changed ──────────────────────────
do $$
declare
  v_other bigint;
  v_submitted bigint;
begin
  select count(*) into v_other
    from public.report_it_reports
   where status not in ('submitted', 'received', 'under_assessment', 'closed');
  select count(*) into v_submitted
    from public.report_it_reports
   where status = 'submitted';
  raise notice 'report_it_lifecycle: % report(s) will move submitted -> received', v_submitted;
  if v_other > 0 then
    raise exception 'report_it_lifecycle: % report(s) hold a status other than submitted/received/under_assessment/closed — nothing was changed', v_other;
  end if;
end;
$$;

-- ── The lifecycle columns ──────────────────────────────────────────────────────────────────────
alter table public.report_it_reports
  add column if not exists assessment_started_at timestamptz,
  add column if not exists assessed_by_hr_id text,
  add column if not exists closed_at timestamptz,
  add column if not exists closed_by_hr_id text,
  add column if not exists due_at timestamptz;

-- ── submitted -> received, and nothing else ────────────────────────────────────────────────────
update public.report_it_reports
   set status = 'received'
 where status = 'submitted';

alter table public.report_it_reports
  alter column status set default 'received';

-- ── The due date for every report that has none, from its submitted date ───────────────────────
update public.report_it_reports
   set due_at = created_at + case when is_serious then interval '15 days' else interval '90 days' end
 where due_at is null;

-- ── Only the three statuses ────────────────────────────────────────────────────────────────────
alter table public.report_it_reports
  drop constraint if exists report_it_reports_status_check;
alter table public.report_it_reports
  add constraint report_it_reports_status_check
  check (status in ('received', 'under_assessment', 'closed'));

-- ── The desk's due-date view reads the open reports by due date ────────────────────────────────
create index if not exists idx_report_it_open_due
  on public.report_it_reports (due_at)
  where status in ('received', 'under_assessment');

-- ── Every new row: 'submitted' becomes 'received', and the due date is filled ─────────────────
-- Runs before the check constraint is evaluated, so the code deployed before this migration (which
-- still inserts 'submitted' and no due_at) keeps filing reports without a single refusal.
create or replace function public.report_it_lifecycle_defaults() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is null or new.status = 'submitted' then
    new.status := 'received';
  end if;
  if new.due_at is null then
    new.due_at := coalesce(new.created_at, now())
      + case when new.is_serious then interval '15 days' else interval '90 days' end;
  end if;
  return new;
end;
$$;

revoke execute on function public.report_it_lifecycle_defaults() from public, anon, authenticated;
grant execute on function public.report_it_lifecycle_defaults() to service_role;

drop trigger if exists report_it_reports_lifecycle_defaults on public.report_it_reports;
create trigger report_it_reports_lifecycle_defaults
  before insert on public.report_it_reports
  for each row execute function public.report_it_lifecycle_defaults();

-- ── One step forward, and its audit row, in one transaction ────────────────────────────────────
create or replace function public.phx_report_it_set_status(
  p_report_id uuid,
  p_from text,
  p_to text,
  p_actor_hr_id text,
  p_metadata jsonb default '{}'::jsonb
) returns text
language plpgsql
set search_path = public
as $$
declare
  v_number text;
begin
  if p_report_id is null then
    raise exception 'Validation: a report is required.' using errcode = '22023';
  end if;
  if nullif(btrim(p_actor_hr_id), '') is null then
    raise exception 'Validation: the person making the change is required.' using errcode = '22023';
  end if;
  if not (
    (p_from = 'received' and p_to = 'under_assessment')
    or (p_from = 'under_assessment' and p_to = 'closed')
  ) then
    raise exception 'Validation: a report cannot move from % to %.', p_from, p_to using errcode = '22023';
  end if;

  update public.report_it_reports
     set status = p_to,
         assessment_started_at = case when p_to = 'under_assessment' then now() else assessment_started_at end,
         assessed_by_hr_id = case when p_to = 'under_assessment' then p_actor_hr_id else assessed_by_hr_id end,
         closed_at = case when p_to = 'closed' then now() else closed_at end,
         closed_by_hr_id = case when p_to = 'closed' then p_actor_hr_id else closed_by_hr_id end
   where id = p_report_id
     and status = p_from
  returning report_number into v_number;

  -- Not found, or someone else already moved it: nothing changed, so nothing is logged.
  if v_number is null then
    return null;
  end if;

  insert into public.report_it_audit_logs (report_id, actor_hr_id, action, metadata)
  values (
    p_report_id,
    p_actor_hr_id,
    'status_changed',
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('from', p_from, 'to', p_to, 'reportNumber', v_number)
  );

  return v_number;
end;
$$;

revoke execute on function public.phx_report_it_set_status(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_report_it_set_status(uuid, text, text, text, jsonb) to service_role;

commit;
