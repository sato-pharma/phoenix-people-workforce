-- automated_payroll_draft_cell_history
--
-- WHAT THIS CHANGES: every change to a figure on an Automated Payroll draft row is recorded, one row
--   per cell — which run, which employee, which column, the value before and after, who wrote it, why
--   (a step saved, a step confirmed, Part 1 frozen or reopened, an exclusion, a Deductions or expense
--   resync), from which step, and when. Two new columns on automated_payroll_draft_rows
--   (write_reason, write_step_key) carry the "why" from the app into the trigger.
-- WHY: the sheet only kept edited_by — ONE name per row, overwritten by every save and every confirm,
--   and automated_payroll_audit records a COUNT per click ("edited: 102"), never a value. On
--   2026-10-07 the owner asked who typed two CRM deductions on the September run and nothing could
--   answer: the drift report called them hand-entered, and they turned out to be the module's own
--   figures frozen by a step confirm. A trigger, not app code, so no write path can skip it.
-- ROLLBACK:
--   drop trigger if exists automated_payroll_draft_cell_history_capture on public.automated_payroll_draft_rows;
--   drop function if exists public.phx_automated_payroll_draft_cell_history_capture();
--   -- SAFE: the history table only exists to be kept; drop it only if this whole change is abandoned.
--   drop table if exists public.automated_payroll_draft_cell_history;
--   alter table public.automated_payroll_draft_rows drop column if exists write_reason, drop column if exists write_step_key;
--   Nothing existing is changed or deleted: the two new columns start NULL and no figure moves.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.automated_payroll_draft_rows
  add column if not exists write_reason text,
  add column if not exists write_step_key text;

comment on column public.automated_payroll_draft_rows.write_reason is
  'Why the latest write to this row happened (step_saved, step_confirmed, part1_confirmed, ...). Read by the cell-history trigger; every writer in src/lib/automated-payroll/draft-store.ts sets it.';
comment on column public.automated_payroll_draft_rows.write_step_key is
  'The wizard step whose save or confirm made the latest write, when one did. Read by the cell-history trigger.';

create table if not exists public.automated_payroll_draft_cell_history (
  id                     bigint generated always as identity primary key,
  run_id                 uuid not null,
  employee_hr_id         text not null,
  employee_hr_id_compact text not null,
  column_name            text not null,
  old_value              text,
  new_value              text,
  changed_by             text,
  write_reason           text,
  step_key               text,
  input_mode             text,
  changed_at             timestamptz not null default now()
);

comment on table public.automated_payroll_draft_cell_history is
  'Append-only history of every cell change on automated_payroll_draft_rows, written by trigger. No FK to the run on purpose: the record outlives a cancelled run.';

create index if not exists automated_payroll_draft_cell_history_run_employee_idx
  on public.automated_payroll_draft_cell_history (run_id, employee_hr_id_compact, changed_at desc);

alter table public.automated_payroll_draft_cell_history enable row level security;
revoke all on table public.automated_payroll_draft_cell_history from anon, authenticated;
grant select, insert on table public.automated_payroll_draft_cell_history to service_role;

create or replace function public.phx_automated_payroll_draft_cell_history_capture()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  new_doc jsonb := to_jsonb(new);
  old_doc jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  key text;
begin
  for key in select jsonb_object_keys(new_doc) loop
    -- Identity and bookkeeping columns are not cells; the who/why columns are recorded WITH each cell.
    if key in ('run_id', 'employee_hr_id', 'employee_hr_id_compact', 'updated_at', 'edited_by',
               'source', 'write_reason', 'write_step_key') then
      continue;
    end if;
    if tg_op = 'INSERT' and new_doc -> key = 'null'::jsonb then
      continue;
    end if;
    if tg_op = 'UPDATE' and (new_doc -> key) is not distinct from (old_doc -> key) then
      continue;
    end if;
    insert into public.automated_payroll_draft_cell_history
      (run_id, employee_hr_id, employee_hr_id_compact, column_name, old_value, new_value,
       changed_by, write_reason, step_key, input_mode)
    values
      (new.run_id, new.employee_hr_id, new.employee_hr_id_compact, key,
       case when old_doc -> key is null or old_doc -> key = 'null'::jsonb then null else old_doc ->> key end,
       case when new_doc -> key = 'null'::jsonb then null else new_doc ->> key end,
       new.edited_by, new.write_reason, new.write_step_key, new.source);
  end loop;
  return null;
end;
$$;

revoke execute on function public.phx_automated_payroll_draft_cell_history_capture() from public, anon, authenticated;

drop trigger if exists automated_payroll_draft_cell_history_capture on public.automated_payroll_draft_rows;
-- AFTER, not BEFORE: an upsert fires BEFORE INSERT even when it resolves to an update, which would
-- record every cell of an existing row as freshly typed. AFTER INSERT fires only for a real insert.
create trigger automated_payroll_draft_cell_history_capture
  after insert or update on public.automated_payroll_draft_rows
  for each row execute function public.phx_automated_payroll_draft_cell_history_capture();

-- Append-only. A revoke never binds the table OWNER, and TRUNCATE fires no row trigger, so all three
-- verbs are refused by trigger as well.
create or replace function public.phx_automated_payroll_draft_cell_history_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'automated_payroll_draft_cell_history is append-only (% refused)', tg_op;
end;
$$;

revoke execute on function public.phx_automated_payroll_draft_cell_history_append_only() from public, anon, authenticated;

drop trigger if exists automated_payroll_draft_cell_history_no_change on public.automated_payroll_draft_cell_history;
create trigger automated_payroll_draft_cell_history_no_change
  before update or delete on public.automated_payroll_draft_cell_history
  for each row execute function public.phx_automated_payroll_draft_cell_history_append_only();

drop trigger if exists automated_payroll_draft_cell_history_no_truncate on public.automated_payroll_draft_cell_history;
create trigger automated_payroll_draft_cell_history_no_truncate
  before truncate on public.automated_payroll_draft_cell_history
  for each statement execute function public.phx_automated_payroll_draft_cell_history_append_only();

commit;
