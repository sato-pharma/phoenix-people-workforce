-- deductions_module_per_line_push
--
-- WHAT THIS CHANGES:
--   Adds per-line "push" to the unified Deductions module, so the Super Admin
--   can release ONE employee's ONE deduction at a time (approve/edit/delete/add
--   per person, per deduction) instead of the current month-atomic publish.
--
--   1. deductions_publication_lines gains:
--        line_status            'active' | 'withdrawn'  (NOT NULL default 'active')
--        pushed_by              text        (who pushed this one line; null = legacy wholesale publish)
--        pushed_at              timestamptz (when; null = legacy wholesale publish)
--        notified_at            timestamptz (set once the employee/CC notice is sent)
--        notification_status    text        ('sent' | 'failed' | 'skipped' | null)
--        superseded_by_line_id  uuid        (the active line that replaced a withdrawn one)
--      + partial unique index (publication_id, candidate_id) WHERE line_status='active'
--      + index (month_key, line_status)
--
--   2. phx_push_deduction(p_month_key, p_month, p_year, p_pushed_by, p_line jsonb)
--      — ensures a status='published' publication exists for the month (creating
--        an empty one if none), withdraws any existing active line for that
--        candidate, inserts one new active line, locks the candidate, recomputes
--        the publication's candidate_count/employee_count/category_totals from
--        ACTIVE lines only, writes a 'pushed' audit row, returns the new line row.
--
--   3. phx_withdraw_deduction(p_line_id, p_actor) — flips one line to 'withdrawn',
--      clears the candidate's lock so it can be edited/re-pushed, recomputes the
--      publication counts, writes a 'withdrawn' audit row.
--
--   Both are SECURITY DEFINER, service_role execute only (the Super-Admin gate is
--   enforced in application code before either is called), mirroring
--   phx_publish_deductions in 20260725130500_deductions_module_publish.sql.
--
-- WHY:
--   The owner's rule: deductions are functioning but NEVER automatic. Nothing is
--   deducted from an employee's pay, and no notification fires, until the Super
--   Admin pushes that specific line. "Push two of an employee's three, leave one."
--
-- ROLLBACK:
--   Additive and reversible. To undo:
--     drop function if exists public.phx_push_deduction(text, integer, integer, text, jsonb);
--     drop function if exists public.phx_withdraw_deduction(uuid, text);
--     drop index if exists public.deductions_publication_lines_active_candidate_idx;
--     drop index if exists public.deductions_publication_lines_month_status_idx;
--     alter table public.deductions_publication_lines
--       drop column if exists superseded_by_line_id,
--       drop column if exists notification_status,
--       drop column if exists notified_at,
--       drop column if exists pushed_at,
--       drop column if exists pushed_by,
--       drop column if exists line_status;
--   Production holds ZERO publication rows today, so no data is touched by this
--   migration — the ALTER only widens the (empty) table's shape.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is additive and non-destructive (no DROP, no UPDATE of existing data,
-- no backfill), so no pre-image is required.

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-line push columns on the snapshot table.
-- ---------------------------------------------------------------------------

alter table public.deductions_publication_lines
  add column if not exists line_status           text not null default 'active',
  add column if not exists pushed_by             text,
  add column if not exists pushed_at             timestamptz,
  add column if not exists notified_at           timestamptz,
  add column if not exists notification_status   text,
  add column if not exists superseded_by_line_id uuid references public.deductions_publication_lines(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'deductions_publication_lines_line_status_check'
      and conrelid = 'public.deductions_publication_lines'::regclass
  ) then
    alter table public.deductions_publication_lines
      add constraint deductions_publication_lines_line_status_check
      check (line_status in ('active', 'withdrawn'));
  end if;
end $$;

comment on column public.deductions_publication_lines.line_status is
  'active = currently released to the employee and counted for payroll; withdrawn = pulled back by the Super Admin (kept for the audit trail, invisible to the portal and payroll).';
comment on column public.deductions_publication_lines.pushed_by is
  'HR id of the Super Admin who pushed this individual line; null for a legacy month-atomic (wholesale) publish.';
comment on column public.deductions_publication_lines.pushed_at is
  'When this individual line was pushed; null for a legacy month-atomic (wholesale) publish.';

-- One ACTIVE line per candidate per publication. A re-push withdraws the old
-- line first (below), so this never collides with an intentional re-push, only
-- with a genuine double-insert.
create unique index if not exists deductions_publication_lines_active_candidate_idx
  on public.deductions_publication_lines (publication_id, candidate_id)
  where line_status = 'active';

create index if not exists deductions_publication_lines_month_status_idx
  on public.deductions_publication_lines (month_key, line_status);

-- ---------------------------------------------------------------------------
-- 1b. Make the double-deduction guard line_status-aware.
--
-- deductions_publication_lines_guard_day_overlap (20260725161204) refuses an
-- INSERT whose employee-day already appears on another line of the same
-- published publication. With per-line push it must count only ACTIVE lines:
--   * a re-push withdraws the candidate's old line and inserts a new one for the
--     SAME day — the withdrawn line must not block its own replacement;
--   * a withdrawn line no longer deducts anything, so it must not block a
--     different candidate covering that day either.
-- The guard still fires for two ACTIVE lines colliding on a day (the real
-- double-deduction it exists to stop). CREATE OR REPLACE clears a function's
-- proconfig, so the search_path pin from 20260801140000 is restated here.
-- ---------------------------------------------------------------------------

create or replace function public.deductions_publication_lines_guard_day_overlap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_conflict record;
begin
  -- A withdrawn line no longer deducts anything, so it must not block a re-push
  -- of the same candidate/day or a genuine push of a different candidate.
  if new.line_status <> 'active' then
    return new;
  end if;

  select l.category, d.day, l.candidate_id
    into v_conflict
  from public.deductions_publication_lines l
  cross join lateral jsonb_array_elements_text(l.dates) as d(day)
  join public.deductions_publications p on p.id = l.publication_id
  where l.publication_id = new.publication_id
    and l.employee_hr_id_compact = new.employee_hr_id_compact
    and l.id <> new.id
    and l.line_status = 'active'
    and p.status = 'published'
    and d.day in (select jsonb_array_elements_text(new.dates))
  limit 1;

  if v_conflict.day is not null then
    raise exception
      'deductions_publication_lines: employee % is already being deducted for % under category "%" in this publication — one employee-day may only be deducted once (conflicting candidate %)',
      new.employee_hr_id_compact, v_conflict.day, v_conflict.category, v_conflict.candidate_id
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. phx_push_deduction — release ONE line, atomically. SECURITY DEFINER,
--    service_role execute only (same reasoning as phx_publish_deductions: the
--    Super-Admin gate is enforced in application code; a broad grant would let
--    any authenticated caller bypass it via direct RPC).
-- ---------------------------------------------------------------------------

create or replace function public.phx_push_deduction(
  p_month_key text,
  p_month integer,
  p_year integer,
  p_pushed_by text,
  p_line jsonb
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_publication_id uuid;
  v_candidate_id   uuid := (p_line->>'candidate_id')::uuid;
  v_new_line_id    uuid := gen_random_uuid();
  v_old_line_id    uuid;
  v_result         jsonb;
begin
  -- Ensure a single active publication exists for the month; create an empty
  -- container on the first push of the month.
  select id into v_publication_id
  from deductions_publications
  where month_key = p_month_key and status = 'published'
  for update;

  if v_publication_id is null then
    v_publication_id := gen_random_uuid();
    insert into deductions_publications (
      id, month, year, published_by, status,
      candidate_count, employee_count, category_totals, notes
    ) values (
      v_publication_id, p_month, p_year, p_pushed_by, 'published',
      0, 0, '{}'::jsonb, null
    );
  end if;

  -- A re-push replaces the candidate's current active line. Three ordered steps,
  -- because the two constraints pull opposite ways: the partial-unique index
  -- forbids two active lines for one candidate, so the old line must go
  -- 'withdrawn' BEFORE the new one is inserted; but superseded_by_line_id's FK
  -- cannot point at the new line until it EXISTS. So: retire the old line first
  -- (capturing its id — the unique index guarantees at most one), insert the new
  -- active line, then link the old line to its replacement. Same two-phase shape
  -- as phx_publish_deductions.
  update deductions_publication_lines
  set line_status = 'withdrawn'
  where publication_id = v_publication_id
    and candidate_id = v_candidate_id
    and line_status = 'active'
  returning id into v_old_line_id;

  insert into deductions_publication_lines (
    id, publication_id, candidate_id, decision_id, employee_hr_id, employee_hr_id_compact,
    employee_name, month_key, category, unit, original_value, applied_value, applied_amount,
    dates, reason, hr_note, line_status, pushed_by, pushed_at
  ) values (
    v_new_line_id, v_publication_id, v_candidate_id,
    nullif(p_line->>'decision_id', '')::uuid,
    p_line->>'employee_hr_id',
    p_line->>'employee_hr_id_compact',
    nullif(p_line->>'employee_name', ''),
    p_line->>'month_key',
    p_line->>'category',
    p_line->>'unit',
    (p_line->>'original_value')::numeric,
    (p_line->>'applied_value')::numeric,
    (p_line->>'applied_amount')::numeric,
    coalesce(p_line->'dates', '[]'::jsonb),
    nullif(p_line->>'reason', ''),
    nullif(p_line->>'hr_note', ''),
    'active', p_pushed_by, now()
  );

  -- Now that the replacement exists, link the retired line to it (FK-safe).
  if v_old_line_id is not null then
    update deductions_publication_lines
    set superseded_by_line_id = v_new_line_id
    where id = v_old_line_id;
  end if;

  update deductions_candidates
  set locked_at = now()
  where id = v_candidate_id and locked_at is null;

  -- Recompute the publication's headline figures from ACTIVE lines only, in the
  -- exact shape publishMonth writes: candidate_count = active lines,
  -- employee_count = distinct employees, category_totals = { category: sum(amount) }.
  with active as (
    select category, employee_hr_id_compact, applied_amount
    from deductions_publication_lines
    where publication_id = v_publication_id and line_status = 'active'
  ),
  by_cat as (
    select category, round(sum(applied_amount), 2) as amt
    from active
    group by category
  )
  update deductions_publications p set
    candidate_count = (select count(*) from active),
    employee_count  = (select count(distinct employee_hr_id_compact) from active),
    category_totals = coalesce((select jsonb_object_agg(category, amt) from by_cat), '{}'::jsonb)
  where p.id = v_publication_id;

  insert into deductions_audit (publication_id, candidate_id, actor_hr_id, action, detail)
  values (
    v_publication_id, v_candidate_id, p_pushed_by, 'pushed',
    jsonb_build_object(
      'line_id', v_new_line_id,
      'month_key', p_month_key,
      'category', p_line->>'category',
      'applied_amount', (p_line->>'applied_amount')::numeric
    )
  );

  select to_jsonb(l) into v_result
  from deductions_publication_lines l
  where l.id = v_new_line_id;

  return v_result;
end;
$$;

revoke execute on function public.phx_push_deduction(text, integer, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_push_deduction(text, integer, integer, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. phx_withdraw_deduction — pull ONE line back. SECURITY DEFINER,
--    service_role execute only.
-- ---------------------------------------------------------------------------

create or replace function public.phx_withdraw_deduction(
  p_line_id uuid,
  p_actor text
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_publication_id uuid;
  v_candidate_id   uuid;
  v_month_key      text;
begin
  select publication_id, candidate_id, month_key
    into v_publication_id, v_candidate_id, v_month_key
  from deductions_publication_lines
  where id = p_line_id and line_status = 'active'
  for update;

  if v_publication_id is null then
    return jsonb_build_object('ok', false, 'reason', 'line not found or already withdrawn');
  end if;

  update deductions_publication_lines
  set line_status = 'withdrawn'
  where id = p_line_id;

  -- Free the candidate so HR can edit and re-push it. A candidate belongs to a
  -- single month/publication, so this line was its only active one.
  update deductions_candidates
  set locked_at = null
  where id = v_candidate_id;

  with active as (
    select category, employee_hr_id_compact, applied_amount
    from deductions_publication_lines
    where publication_id = v_publication_id and line_status = 'active'
  ),
  by_cat as (
    select category, round(sum(applied_amount), 2) as amt
    from active
    group by category
  )
  update deductions_publications p set
    candidate_count = (select count(*) from active),
    employee_count  = (select count(distinct employee_hr_id_compact) from active),
    category_totals = coalesce((select jsonb_object_agg(category, amt) from by_cat), '{}'::jsonb)
  where p.id = v_publication_id;

  insert into deductions_audit (publication_id, candidate_id, actor_hr_id, action, detail)
  values (
    v_publication_id, v_candidate_id, p_actor, 'withdrawn',
    jsonb_build_object('line_id', p_line_id, 'month_key', v_month_key)
  );

  return jsonb_build_object(
    'ok', true,
    'publication_id', v_publication_id,
    'candidate_id', v_candidate_id,
    'line_id', p_line_id
  );
end;
$$;

revoke execute on function public.phx_withdraw_deduction(uuid, text) from public, anon, authenticated;
grant execute on function public.phx_withdraw_deduction(uuid, text) to service_role;

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20260922021403 was minted to sort after every migration already on main.
