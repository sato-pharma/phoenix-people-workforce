-- Unified Deductions module — Phase 2: monthly publish snapshot + audit trail.
--
-- deductions_publications/deductions_publication_lines are the ONLY tables
-- Automated Payroll or the employee portal will eventually read (Phases 4-5) —
-- never deductions_candidates/deductions_decisions directly. At most one
-- ACTIVE ('published') publication can exist per month_key by constraint,
-- fixing a confirmed gap in the legacy deduction_monthly_summaries table
-- (which allows two "finalized" summaries to coexist for the same month).
--
-- The selection logic (which candidates qualify — mandatory categories unless
-- explicitly "Do Not Take Action"; other categories only if "Approved for
-- Payroll") lives in application code (src/lib/deductions/publish.ts), same
-- as the legacy phx_finalize_monthly_deductions's p_lines/p_decision_ids
-- pattern — this RPC only guarantees the WRITE is atomic, it does not
-- re-derive eligibility itself.

-- ---------------------------------------------------------------------------
-- deductions_publications — one row per publish action. status='published' is
-- the single active snapshot for its month_key; republishing supersedes it.
-- ---------------------------------------------------------------------------

create table if not exists public.deductions_publications (
  id                           uuid primary key default gen_random_uuid(),
  month                        integer not null,
  year                         integer not null,
  month_key                    text generated always as (year::text || '-' || lpad(month::text, 2, '0')) stored,
  status                       text not null default 'published',
  published_by                 text not null,
  published_at                 timestamptz not null default now(),
  superseded_at                timestamptz,
  superseded_by_publication_id uuid references public.deductions_publications(id) on delete set null,
  candidate_count              integer not null default 0,
  employee_count               integer not null default 0,
  category_totals              jsonb not null default '{}'::jsonb,
  notes                        text,
  created_at                   timestamptz not null default now(),
  constraint deductions_publications_month_range check (month >= 1 and month <= 12),
  constraint deductions_publications_year_range check (year >= 2000 and year <= 2100),
  constraint deductions_publications_status_check check (status in ('published', 'superseded')),
  constraint deductions_publications_published_by_not_blank check (btrim(published_by) <> ''),
  constraint deductions_publications_counts_non_negative check (candidate_count >= 0 and employee_count >= 0)
);

comment on table public.deductions_publications is
  'Unified Deductions module: the "press publish" record. At most one status=published row per month_key (enforced by the partial unique index below) — republishing atomically supersedes the previous one via phx_publish_deductions.';

-- At most one ACTIVE publication per month.
create unique index if not exists deductions_publications_active_month_idx
  on public.deductions_publications (month_key)
  where status = 'published';
create index if not exists deductions_publications_month_key_idx
  on public.deductions_publications (month_key);

-- ---------------------------------------------------------------------------
-- deductions_publication_lines — immutable snapshot rows. The ONLY table
-- Automated Payroll or an employee should ever read.
-- ---------------------------------------------------------------------------

create table if not exists public.deductions_publication_lines (
  id                     uuid primary key default gen_random_uuid(),
  publication_id         uuid not null references public.deductions_publications(id) on delete cascade,
  candidate_id           uuid not null references public.deductions_candidates(id),
  decision_id            uuid references public.deductions_decisions(id),
  employee_hr_id         text not null,
  employee_hr_id_compact text not null,
  employee_name          text,
  month_key              text not null,
  category               text not null references public.deductions_categories(category),
  unit                   text not null,
  original_value         numeric(14, 2) not null,
  applied_value          numeric(14, 2) not null,
  applied_amount         numeric(14, 2) not null,
  dates                  jsonb not null default '[]'::jsonb,
  reason                 text,
  hr_note                text,
  created_at             timestamptz not null default now(),
  constraint deductions_publication_lines_employee_hr_id_not_blank check (btrim(employee_hr_id) <> ''),
  constraint deductions_publication_lines_unit_check check (unit in ('days', 'amount')),
  constraint deductions_publication_lines_applied_value_non_negative check (applied_value >= 0),
  constraint deductions_publication_lines_applied_amount_non_negative check (applied_amount >= 0)
);

comment on table public.deductions_publication_lines is
  'Unified Deductions module: immutable per-employee-per-category snapshot rows captured at publish time. Automated Payroll (Phase 5) and the employee portal (Phase 4) read exclusively from here for a status=published publication — never from deductions_candidates/deductions_decisions directly.';

create index if not exists deductions_publication_lines_publication_idx
  on public.deductions_publication_lines (publication_id);
create index if not exists deductions_publication_lines_employee_idx
  on public.deductions_publication_lines (employee_hr_id_compact);
create index if not exists deductions_publication_lines_month_category_idx
  on public.deductions_publication_lines (month_key, category);

-- ---------------------------------------------------------------------------
-- deductions_audit — dedicated audit trail for this module (mirrors
-- automated_payroll_audit's shape rather than the shared writeAuditLog table,
-- a better fit for a financial workflow with its own review surface).
-- ---------------------------------------------------------------------------

create table if not exists public.deductions_audit (
  id             uuid primary key default gen_random_uuid(),
  publication_id uuid references public.deductions_publications(id) on delete cascade,
  candidate_id   uuid references public.deductions_candidates(id) on delete cascade,
  actor_hr_id    text,
  action         text not null,
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.deductions_audit is
  'Unified Deductions module: append-only audit trail (publish/supersede/decision events).';

create index if not exists deductions_audit_publication_idx
  on public.deductions_audit (publication_id);
create index if not exists deductions_audit_candidate_idx
  on public.deductions_audit (candidate_id);

-- ---------------------------------------------------------------------------
-- phx_publish_deductions — atomic supersede-and-snapshot. SECURITY DEFINER,
-- service_role execute only (never authenticated — the Super-Admin gate is
-- enforced in application code before this is ever called; granting this
-- broadly would let any authenticated caller bypass that gate directly via
-- RPC, since SECURITY DEFINER runs with the function owner's privileges).
-- ---------------------------------------------------------------------------

create or replace function public.phx_publish_deductions(
  p_month_key text,
  p_month integer,
  p_year integer,
  p_published_by text,
  p_candidate_count integer,
  p_employee_count integer,
  p_category_totals jsonb,
  p_notes text,
  p_lines jsonb,
  p_candidate_ids uuid[]
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_previous_id    uuid;
  v_publication_id uuid := gen_random_uuid();
  v_result         jsonb;
begin
  select id into v_previous_id
  from deductions_publications
  where month_key = p_month_key and status = 'published'
  for update;

  -- Free the (month_key) WHERE status='published' unique-index slot before
  -- inserting the new row. superseded_by_publication_id is set in a second
  -- update further down, once the new row actually exists — its FK can't
  -- reference a not-yet-inserted row within the same statement.
  if v_previous_id is not null then
    update deductions_publications
    set status = 'superseded', superseded_at = now()
    where id = v_previous_id;
  end if;

  insert into deductions_publications (
    id, month, year, published_by, status,
    candidate_count, employee_count, category_totals, notes
  ) values (
    v_publication_id, p_month, p_year, p_published_by, 'published',
    p_candidate_count, p_employee_count, coalesce(p_category_totals, '{}'::jsonb),
    nullif(btrim(coalesce(p_notes, '')), '')
  );

  if v_previous_id is not null then
    update deductions_publications
    set superseded_by_publication_id = v_publication_id
    where id = v_previous_id;
  end if;

  insert into deductions_publication_lines (
    publication_id, candidate_id, decision_id, employee_hr_id, employee_hr_id_compact,
    employee_name, month_key, category, unit, original_value, applied_value,
    applied_amount, dates, reason, hr_note
  )
  select
    v_publication_id,
    (line->>'candidate_id')::uuid,
    (line->>'decision_id')::uuid,
    line->>'employee_hr_id',
    line->>'employee_hr_id_compact',
    nullif(line->>'employee_name', ''),
    line->>'month_key',
    line->>'category',
    line->>'unit',
    (line->>'original_value')::numeric,
    (line->>'applied_value')::numeric,
    (line->>'applied_amount')::numeric,
    coalesce(line->'dates', '[]'::jsonb),
    nullif(line->>'reason', ''),
    nullif(line->>'hr_note', '')
  from jsonb_array_elements(p_lines) as line;

  if array_length(p_candidate_ids, 1) > 0 then
    update deductions_candidates
    set locked_at = now()
    where id = any(p_candidate_ids) and locked_at is null;
  end if;

  insert into deductions_audit (publication_id, actor_hr_id, action, detail)
  values (
    v_publication_id, p_published_by, 'published',
    jsonb_build_object(
      'month_key', p_month_key,
      'candidate_count', p_candidate_count,
      'employee_count', p_employee_count,
      'superseded_publication_id', v_previous_id
    )
  );

  select jsonb_build_object(
    'id', id, 'month', month, 'year', year, 'month_key', month_key, 'status', status,
    'published_by', published_by, 'published_at', published_at,
    'candidate_count', candidate_count, 'employee_count', employee_count,
    'category_totals', category_totals, 'notes', notes, 'created_at', created_at
  ) into v_result
  from deductions_publications
  where id = v_publication_id;

  return v_result;
end;
$$;

revoke execute on function public.phx_publish_deductions(text, integer, integer, text, integer, integer, jsonb, text, jsonb, uuid[]) from public;
grant execute on function public.phx_publish_deductions(text, integer, integer, text, integer, integer, jsonb, text, jsonb, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.deductions_publications      enable row level security;
alter table public.deductions_publication_lines enable row level security;
alter table public.deductions_audit              enable row level security;

do $$
declare
  target_table text;
  targets text[] := array[
    'deductions_publications',
    'deductions_audit'
  ];
begin
  foreach target_table in array targets loop
    execute format('drop policy if exists %I on public.%I', target_table || '_admin_select', target_table);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.current_access_can_manage_employees())',
      target_table || '_admin_select', target_table);
    execute format('revoke all on table public.%I from anon', target_table);
    execute format('revoke all on table public.%I from public', target_table);
    -- admin/HR read-only from the client; all writes go through the SECURITY
    -- DEFINER RPC (service_role) or the trusted server-side admin client.
    execute format('grant select on table public.%I to authenticated', target_table);
    execute format('grant all on table public.%I to service_role', target_table);
  end loop;
end $$;

-- deductions_publication_lines: admin/HR read, PLUS a genuine employee-self
-- read (self + hierarchy, via the same function employees_select_access
-- already uses live today) — restricted to the currently-active snapshot
-- only, so an employee can never see a superseded publication's numbers.
drop policy if exists deductions_publication_lines_admin_select on public.deductions_publication_lines;
create policy deductions_publication_lines_admin_select
  on public.deductions_publication_lines for select to authenticated
  using (public.current_access_can_manage_employees());

drop policy if exists deductions_publication_lines_self_read on public.deductions_publication_lines;
create policy deductions_publication_lines_self_read
  on public.deductions_publication_lines for select to authenticated
  using (
    private.phx_can_access_employee(employee_hr_id)
    and exists (
      select 1 from public.deductions_publications p
      where p.id = deductions_publication_lines.publication_id
        and p.status = 'published'
    )
  );

revoke all on table public.deductions_publication_lines from anon;
revoke all on table public.deductions_publication_lines from public;
grant select on table public.deductions_publication_lines to authenticated;
grant all on table public.deductions_publication_lines to service_role;
