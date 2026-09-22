-- Daily Deductions module — Phase 1: the running-tally publish snapshot.
--
-- WHAT: two add-only tables (daily_deductions_publications + _lines) and two
-- SECURITY DEFINER RPCs (phx_publish_daily_deductions / phx_supersede_daily_deductions)
-- for a SECOND, parallel deductions surface that counts deductions day by day over
-- an operator-picked date range and is published on demand — the inverse of the
-- month-final unified Deductions module, which only opens once a calendar month has
-- fully closed (see collect.ts's isCollectableMonth).
--
-- WHY: the owner finalizes the payroll sheet by ~the 25th of the prior month and
-- pays on day 1, so a month-final deductions feed lands ~10 days too late for the
-- sheet. This module lets him accrue a running per-employee tally across a range he
-- picks (default the pay-cutoff start → today) and publish the current snapshot
-- whenever he wants; re-publishing supersedes the prior snapshot (latest wins). It
-- REUSES the unified module's category vocabulary (deductions_categories) and its
-- detection engines at the application layer — nothing here recomputes a deduction.
--
-- This NEVER touches the unified module's tables (deductions_candidates/_decisions/
-- _publications). Add-only, so re-running is safe and a rollback is a plain drop.
--
-- RLS mirrors the unified module (20260725115137_deductions_module.sql):
-- service_role bypasses RLS; admin access gated by
-- public.current_access_can_manage_employees() (Super Admin / HR); an employee may
-- read only their OWN lines under a PUBLISHED, non-superseded snapshot
-- (private.phx_can_access_employee, exactly as deductions_publication_lines_self_read).
--
-- ROLLBACK:
--   drop function if exists public.phx_supersede_daily_deductions(uuid, text);
--   drop function if exists public.phx_publish_daily_deductions(date, date, jsonb, text);
--   drop table if exists public.daily_deductions_lines;
--   drop table if exists public.daily_deductions_publications;

-- ---------------------------------------------------------------------------
-- daily_deductions_publications — one row per published running-tally snapshot.
-- At most one is active (published + not superseded) at any time: a fresh publish
-- supersedes the previous one, so "the latest snapshot" is always unambiguous.
-- ---------------------------------------------------------------------------

create table if not exists public.daily_deductions_publications (
  id                            uuid primary key default gen_random_uuid(),
  range_start                   date not null,
  range_end                     date not null,
  status                        text not null default 'published',
  published_by                  text not null,
  published_at                  timestamptz not null default now(),
  superseded_at                 timestamptz,
  superseded_by_publication_id  uuid references public.daily_deductions_publications(id) on delete set null,
  employee_count                integer not null default 0,
  line_count                    integer not null default 0,
  category_totals               jsonb not null default '{}'::jsonb,
  notes                         text,
  created_at                    timestamptz not null default now(),
  constraint daily_deductions_publications_status_check
    check (status in ('published', 'superseded')),
  constraint daily_deductions_publications_range_ordered
    check (range_start <= range_end),
  constraint daily_deductions_publications_published_by_not_blank
    check (btrim(published_by) <> ''),
  constraint daily_deductions_publications_counts_non_negative
    check (employee_count >= 0 and line_count >= 0)
);

comment on table public.daily_deductions_publications is
  'Daily Deductions module: one row per published running-tally snapshot over an operator-picked date range. A re-publish supersedes the prior active row; at most one active (status=published, superseded_at is null) row exists at a time. Governance/reporting only — no path here writes salary_records/salary_batches.';

-- At most ONE active publication. A partial unique index over a constant column
-- expression enforces the single-active invariant without a status singleton table.
create unique index if not exists daily_deductions_publications_single_active_idx
  on public.daily_deductions_publications ((1))
  where status = 'published' and superseded_at is null;
create index if not exists daily_deductions_publications_status_idx
  on public.daily_deductions_publications (status);
create index if not exists daily_deductions_publications_range_idx
  on public.daily_deductions_publications (range_start, range_end);

-- ---------------------------------------------------------------------------
-- daily_deductions_lines — the tally rows captured into a snapshot. One row per
-- (publication, employee, category). days_count is the clipped-to-range, weighted
-- day count that drives the money; raw_days_count keeps the unweighted count as
-- evidence, exactly as the unified connectors keep rawValue beside the weighted
-- charge. `dates` holds the specific in-range days the count is built from.
-- ---------------------------------------------------------------------------

create table if not exists public.daily_deductions_lines (
  id                      uuid primary key default gen_random_uuid(),
  publication_id          uuid not null references public.daily_deductions_publications(id) on delete cascade,
  category                text not null references public.deductions_categories(category),
  employee_hr_id          text not null,
  employee_hr_id_compact  text not null,
  employee_name           text,
  unit                    text not null default 'days',
  raw_days_count          numeric(14, 2) not null default 0,
  days_count              numeric(14, 2) not null default 0,
  amount                  numeric(14, 2) not null default 0,
  dates                   jsonb not null default '[]'::jsonb,
  source_system           text not null default '',
  reason                  text,
  hr_note                 text not null default '',
  created_at              timestamptz not null default now(),
  constraint daily_deductions_lines_unit_check check (unit in ('days', 'amount')),
  constraint daily_deductions_lines_employee_hr_id_not_blank check (btrim(employee_hr_id) <> ''),
  constraint daily_deductions_lines_employee_hr_id_compact_not_blank check (btrim(employee_hr_id_compact) <> ''),
  constraint daily_deductions_lines_counts_non_negative
    check (raw_days_count >= 0 and days_count >= 0 and amount >= 0)
);

comment on table public.daily_deductions_lines is
  'Daily Deductions module: the tally rows inside a snapshot. One row per (publication, employee, category). days_count is the clipped, weighted day count that drives amount; raw_days_count is the unweighted evidence count; dates are the specific in-range days.';

-- One live line per (publication, employee, category): a snapshot never carries a
-- category for the same person twice.
create unique index if not exists daily_deductions_lines_pub_employee_category_idx
  on public.daily_deductions_lines (publication_id, employee_hr_id_compact, category);
create index if not exists daily_deductions_lines_publication_idx
  on public.daily_deductions_lines (publication_id);
create index if not exists daily_deductions_lines_employee_idx
  on public.daily_deductions_lines (employee_hr_id_compact);

-- ---------------------------------------------------------------------------
-- Row Level Security — service_role bypasses; admin gated by
-- current_access_can_manage_employees(); employee self-read on published lines.
-- ---------------------------------------------------------------------------

alter table public.daily_deductions_publications enable row level security;
alter table public.daily_deductions_lines        enable row level security;

do $$
declare
  target_table text;
  targets text[] := array['daily_deductions_publications', 'daily_deductions_lines'];
begin
  foreach target_table in array targets loop
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_select', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_insert', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_update', target_table);
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_delete', target_table);

    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_select', target_table);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.current_access_can_manage_employees())',
      target_table || '_admin_insert', target_table);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.current_access_can_manage_employees()) with check (public.current_access_can_manage_employees())',
      target_table || '_admin_update', target_table);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_delete', target_table);
  end loop;
end $$;

-- Employee self-read: only your OWN lines, only under a PUBLISHED, non-superseded
-- snapshot. Mirrors deductions_publication_lines_self_read.
drop policy if exists daily_deductions_lines_self_read on public.daily_deductions_lines;
create policy daily_deductions_lines_self_read
  on public.daily_deductions_lines for select to authenticated
  using (
    private.phx_can_access_employee(employee_hr_id)
    and exists (
      select 1 from public.daily_deductions_publications p
      where p.id = daily_deductions_lines.publication_id
        and p.status = 'published'
        and p.superseded_at is null
    )
  );

-- ---------------------------------------------------------------------------
-- Grants — no anon; authenticated is RLS-gated; service_role full.
-- ---------------------------------------------------------------------------

do $$
declare
  target_table text;
  targets text[] := array['daily_deductions_publications', 'daily_deductions_lines'];
begin
  foreach target_table in array targets loop
    execute format('revoke all on table public.%I from anon', target_table);
    execute format('revoke all on table public.%I from public', target_table);
    execute format('grant select, insert, update, delete on table public.%I to authenticated', target_table);
    execute format('grant all on table public.%I to service_role', target_table);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- phx_publish_daily_deductions — atomically supersede any active snapshot and
-- write a fresh one from app-computed tally lines. SECURITY DEFINER, service_role
-- only. p_lines is a JSON array of tally rows; the RPC derives the publication's
-- counts and category_totals from what it actually inserts, never from the caller.
-- ---------------------------------------------------------------------------

create or replace function public.phx_publish_daily_deductions(
  p_range_start date,
  p_range_end   date,
  p_lines       jsonb,
  p_actor       text,
  p_notes       text default null
)
returns public.daily_deductions_publications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_publication public.daily_deductions_publications;
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  if v_actor = '' then
    raise exception 'phx_publish_daily_deductions: an actor is required';
  end if;
  if p_range_start is null or p_range_end is null or p_range_start > p_range_end then
    raise exception 'phx_publish_daily_deductions: range_start must be <= range_end and neither may be null';
  end if;
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' then
    raise exception 'phx_publish_daily_deductions: p_lines must be a JSON array';
  end if;

  -- Supersede the current active snapshot (if any) so exactly one stays active.
  update public.daily_deductions_publications
     set status = 'superseded', superseded_at = now()
   where status = 'published' and superseded_at is null;

  insert into public.daily_deductions_publications (range_start, range_end, published_by, notes)
  values (p_range_start, p_range_end, v_actor, nullif(btrim(coalesce(p_notes, '')), ''))
  returning * into v_publication;

  -- Repoint the just-superseded rows at the new publication for an audit trail.
  update public.daily_deductions_publications
     set superseded_by_publication_id = v_publication.id
   where status = 'superseded' and superseded_at is not null
     and superseded_by_publication_id is null
     and id <> v_publication.id;

  insert into public.daily_deductions_lines (
    publication_id, category, employee_hr_id, employee_hr_id_compact, employee_name,
    unit, raw_days_count, days_count, amount, dates, source_system, reason, hr_note
  )
  select
    v_publication.id,
    line->>'category',
    line->>'employeeHrId',
    line->>'employeeHrIdCompact',
    nullif(line->>'employeeName', ''),
    coalesce(nullif(line->>'unit', ''), 'days'),
    coalesce((line->>'rawDaysCount')::numeric, 0),
    coalesce((line->>'daysCount')::numeric, 0),
    coalesce((line->>'amount')::numeric, 0),
    coalesce(line->'dates', '[]'::jsonb),
    coalesce(line->>'sourceSystem', ''),
    nullif(line->>'reason', ''),
    coalesce(line->>'hrNote', '')
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;

  -- Counts and totals are derived from what was actually inserted.
  update public.daily_deductions_publications p
     set line_count = (
           select count(*)::int
           from public.daily_deductions_lines
           where publication_id = v_publication.id
         ),
         employee_count = (
           select count(distinct employee_hr_id_compact)::int
           from public.daily_deductions_lines
           where publication_id = v_publication.id
         ),
         category_totals = coalesce((
           select jsonb_object_agg(category, cat_total)
           from (
             select category, sum(amount) as cat_total
             from public.daily_deductions_lines
             where publication_id = v_publication.id
             group by category
           ) c
         ), '{}'::jsonb)
   where p.id = v_publication.id;

  select * into v_publication from public.daily_deductions_publications where id = v_publication.id;
  return v_publication;
end;
$$;

comment on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) is
  'Daily Deductions module: atomically supersede any active snapshot and publish a fresh running-tally snapshot from app-computed lines. Counts/category_totals are derived from the inserted rows. SECURITY DEFINER, service_role only.';

revoke execute on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) from public;
revoke execute on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) from anon;
revoke execute on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) from authenticated;
grant execute on function public.phx_publish_daily_deductions(date, date, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- phx_supersede_daily_deductions — withdraw the current snapshot without writing
-- a new one (the employee portal then shows nothing until the next publish).
-- SECURITY DEFINER, service_role only.
-- ---------------------------------------------------------------------------

create or replace function public.phx_supersede_daily_deductions(
  p_publication_id uuid,
  p_actor          text
)
returns public.daily_deductions_publications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_publication public.daily_deductions_publications;
begin
  if btrim(coalesce(p_actor, '')) = '' then
    raise exception 'phx_supersede_daily_deductions: an actor is required';
  end if;

  update public.daily_deductions_publications
     set status = 'superseded', superseded_at = coalesce(superseded_at, now())
   where id = p_publication_id
   returning * into v_publication;

  if not found then
    raise exception 'phx_supersede_daily_deductions: publication % not found', p_publication_id;
  end if;
  return v_publication;
end;
$$;

comment on function public.phx_supersede_daily_deductions(uuid, text) is
  'Daily Deductions module: mark a snapshot superseded (withdraw it) without publishing a replacement. SECURITY DEFINER, service_role only.';

revoke execute on function public.phx_supersede_daily_deductions(uuid, text) from public;
revoke execute on function public.phx_supersede_daily_deductions(uuid, text) from anon;
revoke execute on function public.phx_supersede_daily_deductions(uuid, text) from authenticated;
grant execute on function public.phx_supersede_daily_deductions(uuid, text) to service_role;
