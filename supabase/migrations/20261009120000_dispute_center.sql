-- THE DISPUTE CENTER — one way of working across the three dispute modules (owner, 2026-10-09):
-- Calendar Disputes, Deduction Disputes and Weekly Attendance Review disputes all get a two-way
-- conversation with pictures on both sides, a decision, a reopen ("employee asks, reviewer
-- reopens"), a history nothing ever drops from, and a saved Case Briefing for the Super Admin.
--
-- What this migration adds:
--   1. `dispute-attachments` — a PRIVATE bucket + `dispute_attachments`, pictures on a calendar or
--      weekly-review dispute (deductions keep their own bucket and table, built 2026-10-08).
--   2. `attendance_digest_dispute_messages` — the conversation under a weekly-review dispute.
--   3. `dispute_case_events` — append-only history of every case: reopen requested / declined /
--      reopened, every decision (so a reopened case still shows what was decided before), refunds.
--   4. `dispute_assist_entries` — every saved Case Briefing and every question asked about a case.
--   5. `dispute_refunds` — money a revised decision gives back after that month's payroll was paid,
--      recommended into a LATER month's Additions -> Other Additions (owner, 2026-10-09: reopen, and
--      refund the deduction next month; "in additions, other"). A recommendation only: HR still
--      confirms the Additions step, exactly like the standing additions feeder.
--   6. `automated_payroll_draft_rows.other_additions` — the Additions step's new Other Additions cell.
--   7. Reversing entries in `attendance_annual_balance_charges` — a leave day given back when a
--      weekly-review dispute paid from annual leave is revised to upheld. The original charge stays
--      untouched; the give-back is a second, negative row, so every existing balance read (each sums
--      `days`) nets it by itself and no function body changes.
--   8. `phx_attendance_revise_digest_dispute` — re-decides a reopened weekly-review dispute.
--
-- ADDITIVE except §7, which relaxes the charge ledger's constraints to admit a reversal (the table
-- was empty in production when this shipped, and every guarantee about CHARGES still holds). Every new table
-- is RLS-enabled and service-role only: the browser never reads one directly.
--
-- ROLLBACK (in order):
--   drop function public.phx_attendance_revise_digest_dispute(bigint, boolean, text, text);
--   -- §7, only while no reversal row exists (select count(*) ... where reverses_charge_id is not null):
--   drop trigger attendance_annual_balance_charges_reversal_shape on public.attendance_annual_balance_charges;
--   drop function public.phx_attendance_balance_reversal_shape();
--   drop index public.attendance_annual_balance_charges_one_reversal_idx, public.attendance_annual_balance_charges_line_charge_idx;
--   drop index public.attendance_annual_balance_charges_employee_day_idx;
--   create unique index attendance_annual_balance_charges_employee_day_idx on public.attendance_annual_balance_charges (lower(employee_hr_id), work_date);
--   alter table public.attendance_annual_balance_charges add constraint attendance_annual_balance_charges_digest_line_id_key unique (digest_line_id);
--   alter table public.attendance_annual_balance_charges drop constraint attendance_annual_balance_charges_days_check,
--     add constraint attendance_annual_balance_charges_days_check check (days > 0), alter column settlement_id set not null,
--     drop column reverses_charge_id, drop column reversal_reason;
--   alter table public.automated_payroll_draft_rows drop column other_additions;   -- only if no run saved one
--   drop table public.dispute_refunds, public.dispute_assist_entries, public.dispute_case_events,
--     public.attendance_digest_dispute_messages, public.dispute_attachments;
--   drop policy dispute_attachments_service_role on storage.objects;
--   delete from storage.buckets where id = 'dispute-attachments';   -- after emptying it
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
--
-- APPLIED 2026-10-09 (owner: "apply the dispute center migration on staging then production"):
-- §1-§6 are live on STAGING (cifwmndunmlxjhyjugxa) and PRODUCTION (ozucdzovmcqvepbozvqf) — five
-- tables, RLS and its service-role policies, the append-only triggers, the private bucket and its
-- policy, and other_additions. §7 and §8 are NOT applied in either: every call carrying them was
-- refused by the session's permission layer, which declines a DROP, and §7 cannot be written without
-- one (the old `days > 0` check, the digest_line_id unique and the employee-day unique all have to
-- give way to their partial forms before a negative row can exist). §8 is held with it because its
-- body inserts the reversal §7 makes room for. Nothing else in this file drops anything: where it
-- used to drop-then-create a policy or a trigger, it now creates under a catalog guard, which is
-- what actually ran.

begin;

-- ── 1. Pictures on a calendar or weekly-review dispute ───────────────────────────────────────────
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('dispute-attachments', 'dispute-attachments', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null
     and not exists (
       select 1 from pg_policies
       where schemaname = 'storage' and tablename = 'objects' and policyname = 'dispute_attachments_service_role'
     ) then
    execute $policy$
      create policy dispute_attachments_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'dispute-attachments')
      with check (bucket_id = 'dispute-attachments')
    $policy$;
  end if;
end $$;

create table if not exists public.dispute_attachments (
  id                 uuid primary key default gen_random_uuid(),
  -- 'calendar' -> private_calendar_data_disputes.id; 'digest' -> attendance_digest_lines.id.
  case_kind          text not null,
  case_ref           text not null,
  -- The reply the picture rides on; NULL = it rides on the opening request itself.
  message_id         uuid,
  storage_path       text not null,
  file_name          text not null,
  content_type       text not null,
  size_bytes         bigint not null,
  uploaded_by_hr_id  text not null,
  created_at         timestamptz not null default now(),
  constraint dispute_attachments_kind_check check (case_kind = any (array['calendar'::text, 'digest'::text])),
  constraint dispute_attachments_path_key unique (storage_path),
  constraint dispute_attachments_type_check
    check (content_type = any (array['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])),
  constraint dispute_attachments_size_check check (size_bytes > 0 and size_bytes <= 5242880),
  constraint dispute_attachments_name_check check (btrim(file_name) <> '')
);
comment on table public.dispute_attachments is
  'Pictures on a calendar or weekly-review dispute, from either side. Bytes live in the private dispute-attachments bucket and are read only through /api/dispute-center/attachments/:id.';
create index if not exists dispute_attachments_case_idx on public.dispute_attachments (case_kind, case_ref, created_at);
create index if not exists dispute_attachments_message_idx on public.dispute_attachments (message_id);

-- ── 2. The conversation under a weekly-review dispute ────────────────────────────────────────────
create table if not exists public.attendance_digest_dispute_messages (
  id                  uuid primary key default gen_random_uuid(),
  line_id             bigint not null references public.attendance_digest_lines (id) on delete cascade,
  author_hr_id        text not null,
  -- true when a dispute reviewer (Super Admin or a named reviewer) wrote it, as they were at the time.
  author_is_reviewer  boolean not null default false,
  body                text not null,
  created_at          timestamptz not null default now(),
  constraint attendance_digest_dispute_messages_body_check check (length(btrim(body)) > 0)
);
comment on table public.attendance_digest_dispute_messages is
  'Replies on one weekly attendance review dispute. The employee''s own dispute_reason is the opening message and is not copied here.';
create index if not exists attendance_digest_dispute_messages_line_idx
  on public.attendance_digest_dispute_messages (line_id, created_at);

-- ── 3. Case history — append-only ────────────────────────────────────────────────────────────────
create table if not exists public.dispute_case_events (
  id           uuid primary key default gen_random_uuid(),
  -- 'calendar' -> dispute id; 'deduction' -> deductions_candidates.id; 'digest' -> digest line id.
  case_kind    text not null,
  case_ref     text not null,
  event_type   text not null,
  actor_hr_id  text,
  actor_role   text,
  note         text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  constraint dispute_case_events_kind_check
    check (case_kind = any (array['calendar'::text, 'deduction'::text, 'digest'::text])),
  constraint dispute_case_events_type_check
    check (event_type = any (array[
      'reopen_requested'::text, 'reopen_declined'::text, 'reopened'::text, 'decided'::text,
      'refund_recommended'::text, 'refund_cancelled'::text
    ]))
);
comment on table public.dispute_case_events is
  'Everything that happened to a dispute besides its messages: decisions (every one, so a reopened case keeps the earlier ruling), reopen requests and reopenings, refunds. Append-only.';
create index if not exists dispute_case_events_case_idx on public.dispute_case_events (case_kind, case_ref, created_at);

create or replace function public.phx_dispute_center_append_only()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  raise exception '% rows are append-only (attempted %)', tg_table_name, tg_op using errcode = 'restrict_violation';
end;
$$;

do $
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.dispute_case_events'::regclass and tgname = 'dispute_case_events_append_only' and not tgisinternal
  ) then
    create trigger dispute_case_events_append_only
      before update or delete on public.dispute_case_events
      for each row execute function public.phx_dispute_center_append_only();
  end if;
end $;

-- ── 4. Saved Case Briefings and questions — append-only ──────────────────────────────────────────
create table if not exists public.dispute_assist_entries (
  id                 uuid primary key default gen_random_uuid(),
  case_kind          text not null,
  case_ref           text not null,
  entry_kind         text not null,
  question           text,
  -- The checked statements, each with the record ids it rests on, plus how many were left out because
  -- the records did not support them. Never the raw model text.
  answer             jsonb not null,
  facts_fingerprint  text not null,
  fact_count         integer not null default 0,
  model              text,
  asked_by_hr_id     text not null,
  created_at         timestamptz not null default now(),
  constraint dispute_assist_entries_kind_check
    check (case_kind = any (array['calendar'::text, 'deduction'::text, 'digest'::text])),
  constraint dispute_assist_entries_entry_check check (entry_kind = any (array['briefing'::text, 'question'::text])),
  constraint dispute_assist_entries_question_check
    check ((entry_kind = 'briefing' and question is null) or (entry_kind = 'question' and length(btrim(question)) > 0))
);
comment on table public.dispute_assist_entries is
  'Every Case Briefing and every question asked about a dispute, with the checked answer and the fingerprint of the records it was built from. Super Admin only, append-only.';
create index if not exists dispute_assist_entries_case_idx on public.dispute_assist_entries (case_kind, case_ref, created_at);

do $
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.dispute_assist_entries'::regclass and tgname = 'dispute_assist_entries_append_only' and not tgisinternal
  ) then
    create trigger dispute_assist_entries_append_only
      before update or delete on public.dispute_assist_entries
      for each row execute function public.phx_dispute_center_append_only();
  end if;
end $;

-- ── 5. Refunds owed after a paid month ──────────────────────────────────────────────────────────
create table if not exists public.dispute_refunds (
  id                     uuid primary key default gen_random_uuid(),
  case_kind              text not null,
  case_ref               text not null,
  candidate_id           uuid,
  employee_hr_id         text not null,
  employee_hr_id_compact text not null,
  -- The month whose payroll took the money, and the month whose Additions step gives it back.
  source_month_key       text not null,
  target_month_key       text not null,
  amount                 numeric(12, 2) not null,
  reason                 text not null,
  status                 text not null default 'recommended',
  created_by_hr_id       text,
  created_at             timestamptz not null default now(),
  cancelled_at           timestamptz,
  cancelled_by_hr_id     text,
  cancel_reason          text,
  constraint dispute_refunds_kind_check check (case_kind = any (array['deduction'::text, 'digest'::text])),
  constraint dispute_refunds_amount_check check (amount > 0),
  constraint dispute_refunds_status_check check (status = any (array['recommended'::text, 'cancelled'::text])),
  constraint dispute_refunds_month_check
    check (
      source_month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'
      and target_month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'
      and target_month_key > source_month_key
    ),
  constraint dispute_refunds_cancel_shape_check
    check ((status = 'recommended' and cancelled_at is null) or (status = 'cancelled' and cancelled_at is not null))
);
comment on table public.dispute_refunds is
  'A deduction a revised dispute decision gives back after its month was already paid. Feeds the NEXT open payroll''s Additions -> Other Additions as a recommendation HR confirms; never pays by itself.';
-- One live refund per case: a second revision replaces it (cancel, then recommend) instead of stacking.
create unique index if not exists dispute_refunds_one_live_per_case
  on public.dispute_refunds (case_kind, case_ref) where status = 'recommended';
create index if not exists dispute_refunds_target_idx
  on public.dispute_refunds (target_month_key) where status = 'recommended';

-- ── 6. The Additions step's Other Additions cell ────────────────────────────────────────────────
alter table public.automated_payroll_draft_rows add column if not exists other_additions numeric;
comment on column public.automated_payroll_draft_rows.other_additions is
  'Additions step -> Other Additions (money). Recommended from dispute_refunds due this month; HR confirms. Paid in the Other Additions column beside Special Situations additions.';

-- ── 7. Leave days given back by a revised weekly-review dispute ──────────────────────────────────
-- A REVERSING ENTRY in the same ledger, never an edit. The original charge stays exactly as it was —
-- the table is still insert-only, its immutability trigger untouched — and a second row carrying the
-- NEGATIVE of its days records the give-back. Every balance read already sums `days`: the three
-- database functions (phx_attendance_balance_inputs, phx_attendance_settle_digest_line,
-- phx_apply_vacation_paid_approval) and the app's own read (vacation/service.ts
-- attendanceChargedDaysInPeriod). So each one nets the give-back by itself, none of their bodies
-- changes, and no reader can forget to subtract it.
--
-- What changes to make room for it, and what still holds:
--   - `days` may be negative, but ONLY on a reversal: reverses_charge_id and a reason set, no
--     settlement. A charge is still positive and still carries its settlement.
--   - One CHARGE per line and per employee-day, exactly as before — both uniques now count charges.
--   - At most one reversal per charge, mirroring it exactly (same line, employee, day, period, and
--     the negative of its days) — refused by the trigger below otherwise.
-- The table held NO rows when this shipped (production, 2026-10-09), so no existing row is touched.
alter table public.attendance_annual_balance_charges
  add column if not exists reverses_charge_id bigint references public.attendance_annual_balance_charges (id),
  add column if not exists reversal_reason text;
alter table public.attendance_annual_balance_charges alter column settlement_id drop not null;
alter table public.attendance_annual_balance_charges drop constraint if exists attendance_annual_balance_charges_days_check;
alter table public.attendance_annual_balance_charges add constraint attendance_annual_balance_charges_days_check
  check (
    (days > 0 and reverses_charge_id is null and settlement_id is not null and reversal_reason is null)
    or (days < 0 and reverses_charge_id is not null and settlement_id is null and reversal_reason is not null)
  );
alter table public.attendance_annual_balance_charges drop constraint if exists attendance_annual_balance_charges_digest_line_id_key;
create unique index if not exists attendance_annual_balance_charges_line_charge_idx
  on public.attendance_annual_balance_charges (digest_line_id) where days > 0;
drop index if exists public.attendance_annual_balance_charges_employee_day_idx;
create unique index if not exists attendance_annual_balance_charges_employee_day_idx
  on public.attendance_annual_balance_charges (lower(employee_hr_id), work_date) where days > 0;
create unique index if not exists attendance_annual_balance_charges_one_reversal_idx
  on public.attendance_annual_balance_charges (reverses_charge_id) where reverses_charge_id is not null;

create or replace function public.phx_attendance_balance_reversal_shape()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_charge public.attendance_annual_balance_charges;
begin
  if new.reverses_charge_id is null then
    return new;
  end if;
  select * into v_charge from public.attendance_annual_balance_charges where id = new.reverses_charge_id;
  if not found or v_charge.days <= 0 then
    raise exception 'A reversal must reverse a charge.' using errcode = '23514';
  end if;
  if new.days <> -v_charge.days
     or new.digest_line_id <> v_charge.digest_line_id
     or lower(new.employee_hr_id) <> lower(v_charge.employee_hr_id)
     or new.work_date <> v_charge.work_date
     or new.period_start <> v_charge.period_start
     or new.period_end <> v_charge.period_end then
    raise exception 'A reversal must mirror the charge it reverses exactly.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke execute on function public.phx_attendance_balance_reversal_shape() from public, anon, authenticated;

do $
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.attendance_annual_balance_charges'::regclass
      and tgname = 'attendance_annual_balance_charges_reversal_shape' and not tgisinternal
  ) then
    create trigger attendance_annual_balance_charges_reversal_shape
      before insert on public.attendance_annual_balance_charges
      for each row execute function public.phx_attendance_balance_reversal_shape();
  end if;
end $;

comment on table public.attendance_annual_balance_charges is
  'Annual leave days spent on attendance deductions the employee chose to pay from balance, and (negative rows, reverses_charge_id set) days given back when that dispute was revised to upheld. Every annual balance read sums days, so a reversal nets itself. Charges are written only by phx_attendance_settle_digest_line, reversals only by phx_attendance_revise_digest_dispute; never updated or deleted.';

-- ── RLS: service role only, for every new table ──────────────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array[
    'dispute_attachments', 'attendance_digest_dispute_messages', 'dispute_case_events',
    'dispute_assist_entries', 'dispute_refunds'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = t || '_service_role_all'
    ) then
      execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', t || '_service_role_all', t);
    end if;
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

-- ── 8. Re-deciding a reopened weekly-review dispute ─────────────────────────────────────────────
-- The first decision is a settlement, and a settlement is immutable and one per day — so a revised
-- decision does not re-settle. It moves the LINE to the new outcome (the line is what every reader
-- asks: the deductions guard, the bridge's "already cleared" check, the portal), gives a leave day
-- back when an upheld revision undoes a balance charge, and reports what it found so the caller can
-- carry the money side through the Deductions module. A revision to "rejected" always applies
-- SALARY: spending leave needs the employee's own choice and a live balance check, which a revision
-- after the fact cannot honestly make.
create or replace function public.phx_attendance_revise_digest_dispute(
  p_line_id bigint,
  p_uphold boolean,
  p_reviewer_hr_id text,
  p_notes text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_line public.attendance_digest_lines;
  v_digest public.attendance_weekly_digests;
  v_charge public.attendance_annual_balance_charges;
  v_restored numeric := 0;
  v_previous_action text;
  v_previous_method text;
begin
  if p_reviewer_hr_id is null or btrim(p_reviewer_hr_id) = '' then
    raise exception 'A revised decision needs its reviewer.' using errcode = '22023';
  end if;

  select * into v_line from public.attendance_digest_lines where id = p_line_id for update;
  if not found then
    raise exception 'Digest line was not found.' using errcode = 'P0002';
  end if;
  if v_line.action not in ('dispute_upheld', 'dispute_rejected') then
    raise exception 'Only a decided dispute can be revised.' using errcode = '40001';
  end if;

  select * into v_digest from public.attendance_weekly_digests where id = v_line.digest_id for update;
  if v_digest.dry_run is distinct from false then
    raise exception 'This day belongs to a trial-run week.' using errcode = '40001';
  end if;

  v_previous_action := v_line.action;
  v_previous_method := v_line.chosen_method;

  if p_uphold then
    if v_line.action = 'dispute_upheld' then
      return jsonb_build_object('changed', false, 'previousAction', v_previous_action, 'previousMethod', v_previous_method);
    end if;
    update public.attendance_digest_lines
      set action = 'dispute_upheld',
          review_notes = coalesce(nullif(btrim(p_notes), ''), review_notes),
          updated_at = now()
      where id = v_line.id;

    -- The same lock key every balance writer takes, so a give-back cannot interleave a charge or a
    -- leave approval for this employee.
    perform pg_advisory_xact_lock(hashtext(lower(v_digest.employee_hr_id)));
    select * into v_charge from public.attendance_annual_balance_charges
      where digest_line_id = v_line.id and days > 0;
    if found and not exists (
      select 1 from public.attendance_annual_balance_charges where reverses_charge_id = v_charge.id
    ) then
      insert into public.attendance_annual_balance_charges (
        settlement_id, digest_line_id, employee_hr_id, work_date, days, period_start, period_end,
        created_by, reverses_charge_id, reversal_reason
      ) values (
        null, v_line.id, v_charge.employee_hr_id, v_charge.work_date, -v_charge.days,
        v_charge.period_start, v_charge.period_end, p_reviewer_hr_id, v_charge.id,
        coalesce(nullif(btrim(p_notes), ''), 'Dispute revised to upheld')
      );
      v_restored := v_charge.days;
    end if;
  else
    if v_line.action = 'dispute_rejected' then
      return jsonb_build_object('changed', false, 'previousAction', v_previous_action, 'previousMethod', v_previous_method);
    end if;
    update public.attendance_digest_lines
      set action = 'dispute_rejected',
          chosen_method = 'salary',
          review_notes = coalesce(nullif(btrim(p_notes), ''), review_notes),
          updated_at = now()
      where id = v_line.id;
  end if;

  return jsonb_build_object(
    'changed', true,
    'previousAction', v_previous_action,
    'previousMethod', v_previous_method,
    'restoredDays', v_restored,
    'employeeHrId', v_digest.employee_hr_id,
    'workDate', v_line.work_date,
    'deductionDays', v_line.deduction_days,
    'deductionValue', v_line.deduction_value
  );
end;
$$;

revoke execute on function public.phx_attendance_revise_digest_dispute(bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.phx_attendance_revise_digest_dispute(bigint, boolean, text, text) to service_role;

notify pgrst, 'reload schema';

commit;

-- Verify (catalog, not the ledger):
--   select relname, relrowsecurity from pg_class where relname in ('dispute_attachments','attendance_digest_dispute_messages','dispute_case_events','dispute_assist_entries','dispute_refunds');
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.attendance_annual_balance_charges'::regclass;
--   select id, public, file_size_limit from storage.buckets where id = 'dispute-attachments';
--   select column_name from information_schema.columns where table_name = 'automated_payroll_draft_rows' and column_name = 'other_additions';
--   select proname from pg_proc where proname = 'phx_attendance_revise_digest_dispute';
