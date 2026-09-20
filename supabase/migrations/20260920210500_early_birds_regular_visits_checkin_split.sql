-- early_birds_regular_visits_checkin_split
--
-- WHAT THIS CHANGES: adds regular_visits_with_checkin and regular_visits_no_checkin, both
-- integer NOT NULL DEFAULT 0, to public.early_birds_candidates (additive, every existing row
-- backfills to 0, no data loss). Redefines phx_close_early_birds_period (same signature) to
-- insert both new fields from the candidate JSON payload; every other clause is unchanged.
-- WHY: the owner, 2026-09-20 (rule 10) — a Regular (visit_type 0) CRM visit with no matching GPS
-- check-in must be identified on its own: never blended into the checked-in Regular count for
-- credit, and never relabelled Campaign. close.ts now sends both fields on every candidate row;
-- without this migration a fresh database built from the repo would still reject or silently drop
-- them, and the pending/history reads in decisions.ts and history.ts would fail on the missing
-- columns.
-- ROLLBACK: drop the two columns and restore the prior function body (same signature) that
-- selects only the original candidate columns, omitting regular_visits_with_checkin and
-- regular_visits_no_checkin from both the insert list and the select list; then
--   alter table public.early_birds_candidates
--     drop column regular_visits_with_checkin,
--     drop column regular_visits_no_checkin;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one only adds two defaulted columns and redefines one function: additive, touches no row.
--
-- Already applied directly (via the Supabase MCP servers, pre-authorized under AGENTS.md §8) to
-- both production (ozucdzovmcqvepbozvqf) and staging (cifwmndunmlxjhyjugxa) ahead of this PR —
-- this file is the reproducible record migration review and a fresh database both need.

begin;

alter table public.early_birds_candidates
  add column regular_visits_with_checkin integer not null default 0,
  add column regular_visits_no_checkin integer not null default 0;

create or replace function public.phx_close_early_birds_period(p_period_key text, p_period_start date, p_period_end date, p_manager_hr_id text, p_manager_hr_id_compact text, p_scoring_version smallint, p_weights jsonb, p_contested_days integer, p_trigger text, p_computed_by text, p_replace boolean, p_candidates jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_existing public.early_birds_period_snapshots;
  v_snapshot public.early_birds_period_snapshots;
  v_decisions int := 0;
  v_winners int := 0;
  v_rep_count int := 0;
  v_candidate_count int := 0;
begin
  select * into v_existing
  from public.early_birds_period_snapshots
  where manager_hr_id_compact = p_manager_hr_id_compact
    and period_key = p_period_key
    and superseded_at is null
  for update;

  if found then
    if not coalesce(p_replace, false) then
      return jsonb_build_object('created', false, 'snapshot_id', v_existing.id, 'status', v_existing.status);
    end if;

    select count(*) into v_decisions from public.early_birds_decisions where snapshot_id = v_existing.id;
    select count(*) into v_winners from public.early_birds_winners
      where snapshot_id = v_existing.id and revoked_at is null;

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
    days_with_submission, expected_working_days, total_visits, regular_visits,
    regular_visits_with_checkin, regular_visits_no_checkin, campaign_visits,
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
    coalesce((row_value->>'regular_visits_with_checkin')::int, 0),
    coalesce((row_value->>'regular_visits_no_checkin')::int, 0),
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
$function$;

commit;
