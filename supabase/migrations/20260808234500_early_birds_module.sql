-- Early Birds — fortnightly field-discipline recognition.
--
-- Shape follows the deductions module (machine recommends -> a human confirms -> the confirmed
-- result is the only thing anything downstream reads) and the direct-orders module (RLS enabled
-- with NO policies: every read and write goes through the server-side service_role client behind
-- the TypeScript AccessContext gate). That choice is deliberate here — private.phx_can_access_employee's
-- self/team/line arms depend on a GUC nothing currently populates, so an RLS policy written against
-- it would fail closed and read as a bug rather than as security.
--
-- Two structural rules carry most of the safety:
--   * There is NO "current candidate" column. The rep currently being offered to a manager is
--     DERIVED as the lowest-ranked eligible candidate with no decision row. A rejected candidate
--     therefore carries a permanent decision row and can never be offered again, and the offer can
--     never desync from the decisions.
--   * A snapshot is written ONCE, after the fortnight closes. While a period is open the board is a
--     live preview computed in application code and persisted nowhere, so a preview and a committed
--     ranking cannot disagree.

begin;

-- ── Snapshots — one frozen ranking per (district manager, fortnight) ──────────────────────────

create table if not exists public.early_birds_period_snapshots (
  id                        uuid primary key default gen_random_uuid(),
  period_key                text not null,
  period_start              date not null,
  period_end                date not null,
  manager_hr_id             text not null references public.employees(hr_id),
  manager_hr_id_compact     text not null,
  status                    text not null default 'open',
  scoring_version           smallint not null default 1,
  weights                   jsonb not null default '{}'::jsonb,
  rep_count                 integer not null default 0,
  candidate_count           integer not null default 0,
  contested_days            integer not null default 0,
  trigger                   text not null default 'scheduler',
  computed_at               timestamptz not null default now(),
  computed_by               text not null default 'system',
  superseded_at             timestamptz,
  superseded_by_snapshot_id uuid references public.early_birds_period_snapshots(id) on delete set null,
  created_at                timestamptz not null default now(),
  -- Pinned to EARLY_BIRDS_PERIOD_KEY_PATTERN in src/lib/early-birds/period.ts and asserted equal by
  -- tests/early-birds-period.test.ts. If the two drift, a key TypeScript happily mints is rejected
  -- here inside an unattended 03:00 job with nobody watching.
  constraint early_birds_period_snapshots_period_key_format
    check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])-H[12]$'),
  constraint early_birds_period_snapshots_range check (period_end >= period_start),
  constraint early_birds_period_snapshots_status_check
    check (status in ('open', 'decided', 'exhausted', 'superseded')),
  constraint early_birds_period_snapshots_trigger_check
    check (trigger in ('scheduler', 'manual', 'backfill')),
  constraint early_birds_period_snapshots_manager_not_blank check (btrim(manager_hr_id) <> ''),
  constraint early_birds_period_snapshots_counts_non_negative
    check (rep_count >= 0 and candidate_count >= 0 and contested_days >= 0)
);

-- THE idempotency guarantee: at most one LIVE snapshot per district per fortnight. This is what
-- makes a re-run, a restart, or two concurrent Railway replicas safe by construction.
create unique index if not exists early_birds_period_snapshots_live_idx
  on public.early_birds_period_snapshots (manager_hr_id_compact, period_key)
  where superseded_at is null;
create index if not exists early_birds_period_snapshots_period_idx
  on public.early_birds_period_snapshots (period_key);

comment on table public.early_birds_period_snapshots is
  'One frozen Early Birds ranking per district manager per fortnight. Written once after the period closes; never while it is open.';

-- ── Candidates — every rep scored, eligible and not ───────────────────────────────────────────

create table if not exists public.early_birds_candidates (
  id                     uuid primary key default gen_random_uuid(),
  snapshot_id            uuid not null references public.early_birds_period_snapshots(id) on delete cascade,
  period_key             text not null,
  manager_hr_id          text not null,
  employee_hr_id         text not null references public.employees(hr_id),
  employee_hr_id_compact text not null,
  employee_name          text,
  candidate_key          text not null,
  rank                   integer not null,
  candidate_rank         integer,
  eligible               boolean not null default true,
  ineligible_reasons     text[] not null default '{}',
  total_score            numeric(9,6) not null,
  base_score             numeric(9,6) not null,
  quality_weight         numeric(9,6) not null,
  component_scores       jsonb not null default '{}'::jsonb,
  median_start_minutes   integer,
  days_with_submission   integer not null default 0,
  expected_working_days  integer not null default 0,
  total_visits           integer not null default 0,
  regular_visits         integer not null default 0,
  campaign_visits        integer not null default 0,
  gps_eligible_visits    integer not null default 0,
  gps_verified_visits    integer not null default 0,
  gps_share              numeric(9,6),
  daily_wins             integer not null default 0,
  evidence               jsonb not null default '{}'::jsonb,
  created_at             timestamptz not null default now(),
  constraint early_birds_candidates_rank_positive check (rank >= 1),
  -- An ineligible rep is still scored and still shown, but is never offered to a manager.
  constraint early_birds_candidates_eligible_rank_pairing
    check ((eligible and candidate_rank is not null and candidate_rank >= 1)
        or (not eligible and candidate_rank is null)),
  constraint early_birds_candidates_reasons_pairing
    check ((eligible and cardinality(ineligible_reasons) = 0)
        or (not eligible and cardinality(ineligible_reasons) > 0)),
  constraint early_birds_candidates_scores_bounded
    check (total_score between 0 and 1 and base_score between 0 and 1
       and quality_weight > 0 and quality_weight <= 1),
  constraint early_birds_candidates_gps_share_bounded
    check (gps_share is null or gps_share between 0 and 1),
  constraint early_birds_candidates_median_start_bounded
    check (median_start_minutes is null or (median_start_minutes >= 0 and median_start_minutes < 1440)),
  constraint early_birds_candidates_gps_within_eligible
    check (gps_verified_visits <= gps_eligible_visits),
  constraint early_birds_candidates_typed_within_total
    check (regular_visits + campaign_visits <= total_visits),
  constraint early_birds_candidates_counts_non_negative check (
    days_with_submission >= 0 and expected_working_days >= 0 and total_visits >= 0
    and regular_visits >= 0 and campaign_visits >= 0 and gps_eligible_visits >= 0
    and gps_verified_visits >= 0 and daily_wins >= 0)
);

create unique index if not exists early_birds_candidates_snapshot_employee_idx
  on public.early_birds_candidates (snapshot_id, employee_hr_id_compact);
create unique index if not exists early_birds_candidates_snapshot_rank_idx
  on public.early_birds_candidates (snapshot_id, rank);
create unique index if not exists early_birds_candidates_snapshot_candidate_rank_idx
  on public.early_birds_candidates (snapshot_id, candidate_rank) where candidate_rank is not null;
create index if not exists early_birds_candidates_employee_idx
  on public.early_birds_candidates (employee_hr_id_compact);

-- The snapshot is a frozen record of what the manager was shown. Corrections happen by superseding
-- the whole snapshot, never by editing a score in place.
create or replace function public.early_birds_candidates_guard_frozen()
returns trigger
language plpgsql
as $$
begin
  if (new.total_score, new.base_score, new.quality_weight, new.rank, new.candidate_rank, new.eligible)
     is distinct from
     (old.total_score, old.base_score, old.quality_weight, old.rank, old.candidate_rank, old.eligible)
  then
    raise exception 'early_birds_candidates rows are frozen; supersede the snapshot instead of editing candidate %', old.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists early_birds_candidates_guard_frozen_trg on public.early_birds_candidates;
create trigger early_birds_candidates_guard_frozen_trg
  before update on public.early_birds_candidates
  for each row execute function public.early_birds_candidates_guard_frozen();

-- ── Decisions — one per candidate, ever ───────────────────────────────────────────────────────

create table if not exists public.early_birds_decisions (
  id                     uuid primary key default gen_random_uuid(),
  snapshot_id            uuid not null references public.early_birds_period_snapshots(id) on delete cascade,
  candidate_id           uuid not null references public.early_birds_candidates(id) on delete cascade,
  period_key             text not null,
  manager_hr_id          text not null,
  candidate_rank         integer not null,
  decision_status        text not null,
  decision_reason        text not null default '',
  decided_by             text not null references public.employees(hr_id),
  actor_role_at_decision text,
  decided_at             timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  constraint early_birds_decisions_status_check check (decision_status in ('approved', 'rejected')),
  -- A reason is required to REJECT (the manager must say why he skipped this rep) and optional to
  -- approve, where it carries no information.
  constraint early_birds_decisions_reason_required_on_reject
    check (decision_status <> 'rejected' or btrim(decision_reason) <> ''),
  constraint early_birds_decisions_candidate_rank_positive check (candidate_rank >= 1)
);

create unique index if not exists early_birds_decisions_candidate_idx
  on public.early_birds_decisions (candidate_id);
-- A double-click cannot crown two winners.
create unique index if not exists early_birds_decisions_one_approval_idx
  on public.early_birds_decisions (snapshot_id) where decision_status = 'approved';

-- ── Winners — the district star, announced ────────────────────────────────────────────────────

create table if not exists public.early_birds_winners (
  id                     uuid primary key default gen_random_uuid(),
  snapshot_id            uuid not null references public.early_birds_period_snapshots(id) on delete cascade,
  decision_id            uuid not null references public.early_birds_decisions(id),
  candidate_id           uuid not null references public.early_birds_candidates(id),
  period_key             text not null,
  period_start           date not null,
  period_end             date not null,
  manager_hr_id          text not null references public.employees(hr_id),
  manager_hr_id_compact  text not null,
  employee_hr_id         text not null references public.employees(hr_id),
  employee_hr_id_compact text not null,
  -- Announcement fields are COPIED, not joined. The announcement is a historical statement: if the
  -- winner transfers to Alexandria in September, August's announcement must not silently relabel him.
  employee_name          text not null,
  area_name              text,
  region_name            text,
  line_name              text,
  hire_date              date,
  has_photo              boolean not null default false,
  rank_at_approval       integer not null,
  total_score            numeric(9,6) not null,
  component_scores       jsonb not null default '{}'::jsonb,
  headline_stats         jsonb not null default '{}'::jsonb,
  timeline               jsonb not null default '[]'::jsonb,
  -- 'manager' when the DM confirmed, 'auto' when nobody decided within the window.
  confirmation_source    text not null default 'manager',
  announced_at           timestamptz,
  confirmed_by           text references public.employees(hr_id),
  confirmed_at           timestamptz not null default now(),
  revoked_at             timestamptz,
  revoked_by             text references public.employees(hr_id),
  revoke_reason          text,
  created_at             timestamptz not null default now(),
  constraint early_birds_winners_rank_positive check (rank_at_approval >= 1),
  constraint early_birds_winners_source_check check (confirmation_source in ('manager', 'auto')),
  -- An auto-crowned winner has no human confirmer; a manager-confirmed one must have.
  constraint early_birds_winners_confirmer_pairing
    check ((confirmation_source = 'manager' and confirmed_by is not null)
        or (confirmation_source = 'auto')),
  constraint early_birds_winners_revoke_reason_required
    check (revoked_at is null or btrim(coalesce(revoke_reason, '')) <> '')
);

create unique index if not exists early_birds_winners_live_idx
  on public.early_birds_winners (manager_hr_id_compact, period_key) where revoked_at is null;
create unique index if not exists early_birds_winners_snapshot_idx
  on public.early_birds_winners (snapshot_id) where revoked_at is null;
create index if not exists early_birds_winners_period_idx
  on public.early_birds_winners (period_key) where revoked_at is null;
create index if not exists early_birds_winners_employee_idx
  on public.early_birds_winners (employee_hr_id_compact) where revoked_at is null;

-- ── National winner — the highest-scoring approved district star of the fortnight ─────────────

create table if not exists public.early_birds_national_winners (
  id               uuid primary key default gen_random_uuid(),
  period_key       text not null,
  winner_id        uuid not null references public.early_birds_winners(id) on delete cascade,
  employee_hr_id   text not null references public.employees(hr_id),
  total_score      numeric(9,6) not null,
  district_count   integer not null default 0,
  crowned_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  constraint early_birds_national_winners_period_key_format
    check (period_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])-H[12]$'),
  constraint early_birds_national_winners_score_bounded check (total_score between 0 and 1)
);

create unique index if not exists early_birds_national_winners_live_idx
  on public.early_birds_national_winners (period_key) where revoked_at is null;

-- ── Audit — append only ───────────────────────────────────────────────────────────────────────

create table if not exists public.early_birds_audit (
  id           uuid primary key default gen_random_uuid(),
  snapshot_id  uuid references public.early_birds_period_snapshots(id) on delete set null,
  candidate_id uuid references public.early_birds_candidates(id) on delete set null,
  period_key   text,
  actor_hr_id  text,
  action       text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists early_birds_audit_snapshot_idx on public.early_birds_audit (snapshot_id);
create index if not exists early_birds_audit_created_idx on public.early_birds_audit (created_at desc);

-- ── RLS + grants ──────────────────────────────────────────────────────────────────────────────
--
-- RLS on with no policies: service_role only. Note the REVOKE targets anon and authenticated and
-- NOT public — revoking from PUBLIC would strip service_role's own access through the default ACL
-- and silently break every read below.

do $$
declare
  t text;
  targets text[] := array[
    'early_birds_period_snapshots', 'early_birds_candidates', 'early_birds_decisions',
    'early_birds_winners', 'early_birds_national_winners', 'early_birds_audit'
  ];
begin
  foreach t in array targets loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

-- ── RPC: close a fortnight for one district ───────────────────────────────────────────────────

create or replace function public.phx_close_early_birds_period(
  p_period_key            text,
  p_period_start          date,
  p_period_end            date,
  p_manager_hr_id         text,
  p_manager_hr_id_compact text,
  p_scoring_version       smallint,
  p_weights               jsonb,
  p_contested_days        integer,
  p_trigger               text,
  p_computed_by           text,
  p_replace               boolean,
  p_candidates            jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing public.early_birds_period_snapshots;
  v_snapshot public.early_birds_period_snapshots;
  v_decisions int := 0;
  v_winners int := 0;
  v_rep_count int := 0;
  v_candidate_count int := 0;
begin
  -- The serialization point. Two pollers (blue/green overlap, or a manual trigger racing the
  -- scheduler) both land here and one waits.
  select * into v_existing
  from public.early_birds_period_snapshots
  where manager_hr_id_compact = p_manager_hr_id_compact
    and period_key = p_period_key
    and superseded_at is null
  for update;

  if found then
    if not coalesce(p_replace, false) then
      -- A re-run is a genuine no-op, not a caught unique violation.
      return jsonb_build_object('created', false, 'snapshot_id', v_existing.id, 'status', v_existing.status);
    end if;

    select count(*) into v_decisions from public.early_birds_decisions where snapshot_id = v_existing.id;
    select count(*) into v_winners from public.early_birds_winners
      where snapshot_id = v_existing.id and revoked_at is null;

    -- THE load-bearing guard. Without it a recompute could unseat a confirmed winner or resurrect a
    -- rep the manager already rejected.
    if v_decisions > 0 or v_winners > 0 then
      raise exception 'Early Birds % for % already has decisions; supersede is refused', p_period_key, p_manager_hr_id
        using errcode = '23514';
    end if;

    update public.early_birds_period_snapshots
      set superseded_at = now(), status = 'superseded'
      where id = v_existing.id;
  end if;

  insert into public.early_birds_period_snapshots (
    period_key, period_start, period_end, manager_hr_id, manager_hr_id_compact,
    scoring_version, weights, contested_days, trigger, computed_by
  ) values (
    p_period_key, p_period_start, p_period_end, p_manager_hr_id, p_manager_hr_id_compact,
    coalesce(p_scoring_version, 1::smallint), coalesce(p_weights, '{}'::jsonb),
    coalesce(p_contested_days, 0), coalesce(p_trigger, 'scheduler'), coalesce(p_computed_by, 'system')
  )
  returning * into v_snapshot;

  if v_existing.id is not null then
    update public.early_birds_period_snapshots
      set superseded_by_snapshot_id = v_snapshot.id
      where id = v_existing.id;
  end if;

  insert into public.early_birds_candidates (
    snapshot_id, period_key, manager_hr_id, employee_hr_id, employee_hr_id_compact, employee_name,
    candidate_key, rank, candidate_rank, eligible, ineligible_reasons,
    total_score, base_score, quality_weight, component_scores, median_start_minutes,
    days_with_submission, expected_working_days, total_visits, regular_visits, campaign_visits,
    gps_eligible_visits, gps_verified_visits, gps_share, daily_wins, evidence
  )
  select
    v_snapshot.id, p_period_key, p_manager_hr_id,
    row_value->>'employee_hr_id',
    row_value->>'employee_hr_id_compact',
    row_value->>'employee_name',
    row_value->>'candidate_key',
    (row_value->>'rank')::int,
    nullif(row_value->>'candidate_rank', '')::int,
    coalesce((row_value->>'eligible')::boolean, true),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(row_value->'ineligible_reasons')),
      '{}'::text[]
    ),
    (row_value->>'total_score')::numeric,
    (row_value->>'base_score')::numeric,
    (row_value->>'quality_weight')::numeric,
    coalesce(row_value->'component_scores', '{}'::jsonb),
    nullif(row_value->>'median_start_minutes', '')::int,
    coalesce((row_value->>'days_with_submission')::int, 0),
    coalesce((row_value->>'expected_working_days')::int, 0),
    coalesce((row_value->>'total_visits')::int, 0),
    coalesce((row_value->>'regular_visits')::int, 0),
    coalesce((row_value->>'campaign_visits')::int, 0),
    coalesce((row_value->>'gps_eligible_visits')::int, 0),
    coalesce((row_value->>'gps_verified_visits')::int, 0),
    nullif(row_value->>'gps_share', '')::numeric,
    coalesce((row_value->>'daily_wins')::int, 0),
    coalesce(row_value->'evidence', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) as row_value;

  select count(*) into v_rep_count from public.early_birds_candidates where snapshot_id = v_snapshot.id;
  select count(*) into v_candidate_count from public.early_birds_candidates
    where snapshot_id = v_snapshot.id and eligible;

  update public.early_birds_period_snapshots
    set rep_count = v_rep_count,
        candidate_count = v_candidate_count,
        status = case when v_candidate_count = 0 then 'exhausted' else 'open' end
    where id = v_snapshot.id
    returning * into v_snapshot;

  insert into public.early_birds_audit (snapshot_id, period_key, actor_hr_id, action, detail)
  values (v_snapshot.id, p_period_key, p_computed_by, 'period_closed',
          jsonb_build_object('rep_count', v_rep_count, 'candidate_count', v_candidate_count,
                             'trigger', p_trigger, 'replaced', v_existing.id is not null));

  return jsonb_build_object('created', true, 'snapshot_id', v_snapshot.id, 'status', v_snapshot.status,
                            'rep_count', v_rep_count, 'candidate_count', v_candidate_count);
end;
$$;

revoke execute on function public.phx_close_early_birds_period(
  text, date, date, text, text, smallint, jsonb, integer, text, text, boolean, jsonb
) from public, anon, authenticated;
grant execute on function public.phx_close_early_birds_period(
  text, date, date, text, text, smallint, jsonb, integer, text, text, boolean, jsonb
) to service_role;

-- ── RPC: record a decision and advance the chain ──────────────────────────────────────────────

create or replace function public.phx_decide_early_birds_candidate(
  p_snapshot_id   uuid,
  p_candidate_id  uuid,
  p_decision      text,
  p_reason        text,
  p_decided_by    text,
  p_actor_role    text,
  p_announcement  jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_snapshot public.early_birds_period_snapshots;
  v_candidate public.early_birds_candidates;
  v_current_id uuid;
  v_decision_id uuid;
  v_winner_id uuid;
  v_remaining int := 0;
  v_next_status text;
begin
  select * into v_snapshot from public.early_birds_period_snapshots
    where id = p_snapshot_id for update;
  if not found then
    raise exception 'Early Birds snapshot % not found', p_snapshot_id using errcode = 'P0002';
  end if;
  if v_snapshot.status <> 'open' then
    return jsonb_build_object('error', 'snapshot_not_open', 'status', v_snapshot.status);
  end if;

  -- Re-derive the current candidate server-side. A stale tab cannot reject the wrong rep.
  select c.id into v_current_id
  from public.early_birds_candidates c
  left join public.early_birds_decisions d on d.candidate_id = c.id
  where c.snapshot_id = p_snapshot_id and c.eligible and c.candidate_rank is not null and d.id is null
  order by c.candidate_rank asc
  limit 1;

  if v_current_id is null then
    return jsonb_build_object('error', 'no_candidate');
  end if;
  if v_current_id is distinct from p_candidate_id then
    return jsonb_build_object('error', 'stale_candidate', 'current_candidate_id', v_current_id);
  end if;

  select * into v_candidate from public.early_birds_candidates where id = p_candidate_id;

  insert into public.early_birds_decisions (
    snapshot_id, candidate_id, period_key, manager_hr_id, candidate_rank,
    decision_status, decision_reason, decided_by, actor_role_at_decision
  ) values (
    p_snapshot_id, p_candidate_id, v_snapshot.period_key, v_snapshot.manager_hr_id,
    v_candidate.candidate_rank, p_decision, coalesce(p_reason, ''), p_decided_by, p_actor_role
  )
  returning id into v_decision_id;

  if p_decision = 'approved' then
    insert into public.early_birds_winners (
      snapshot_id, decision_id, candidate_id, period_key, period_start, period_end,
      manager_hr_id, manager_hr_id_compact, employee_hr_id, employee_hr_id_compact,
      employee_name, area_name, region_name, line_name, hire_date, has_photo,
      rank_at_approval, total_score, component_scores, headline_stats, timeline,
      confirmation_source, confirmed_by
    ) values (
      p_snapshot_id, v_decision_id, p_candidate_id, v_snapshot.period_key,
      v_snapshot.period_start, v_snapshot.period_end,
      v_snapshot.manager_hr_id, v_snapshot.manager_hr_id_compact,
      v_candidate.employee_hr_id, v_candidate.employee_hr_id_compact,
      coalesce(p_announcement->>'employee_name', v_candidate.employee_name, v_candidate.employee_hr_id),
      p_announcement->>'area_name', p_announcement->>'region_name', p_announcement->>'line_name',
      nullif(p_announcement->>'hire_date', '')::date,
      coalesce((p_announcement->>'has_photo')::boolean, false),
      v_candidate.candidate_rank, v_candidate.total_score,
      v_candidate.component_scores,
      coalesce(p_announcement->'headline_stats', '{}'::jsonb),
      coalesce(p_announcement->'timeline', '[]'::jsonb),
      coalesce(p_announcement->>'confirmation_source', 'manager'),
      case when coalesce(p_announcement->>'confirmation_source', 'manager') = 'auto' then null else p_decided_by end
    )
    returning id into v_winner_id;

    v_next_status := 'decided';
  else
    select count(*) into v_remaining
    from public.early_birds_candidates c
    left join public.early_birds_decisions d on d.candidate_id = c.id
    where c.snapshot_id = p_snapshot_id and c.eligible and c.candidate_rank is not null and d.id is null;

    v_next_status := case when v_remaining > 0 then 'open' else 'exhausted' end;
  end if;

  update public.early_birds_period_snapshots set status = v_next_status where id = p_snapshot_id;

  insert into public.early_birds_audit (snapshot_id, candidate_id, period_key, actor_hr_id, action, detail)
  values (p_snapshot_id, p_candidate_id, v_snapshot.period_key, p_decided_by,
          'candidate_' || p_decision,
          jsonb_build_object('reason', coalesce(p_reason, ''), 'winner_id', v_winner_id,
                             'next_status', v_next_status));

  return jsonb_build_object('ok', true, 'decision_id', v_decision_id, 'winner_id', v_winner_id,
                            'status', v_next_status);
end;
$$;

revoke execute on function public.phx_decide_early_birds_candidate(uuid, uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.phx_decide_early_birds_candidate(uuid, uuid, text, text, text, text, jsonb)
  to service_role;

notify pgrst, 'reload schema';

commit;
