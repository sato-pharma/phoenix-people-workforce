-- phoenix_crm_activity_and_plan_edit_expiry
--
-- WHAT THIS CHANGES: two new read/close functions, no schema change and no data change.
--
--   1. phoenix_crm_seats_with_activity(p jsonb)
--      "Which of these territories has EVER carried real Phoenix CRM work?" — asked of the six
--      tables that answer it (visits, places, weekly plans, monthly plans, day activities, list
--      requests), one `exists` each, in ONE round trip.
--
--      WHY: `seatsWithRealActivity` (src/lib/phoenix-crm/server/daily-digest.ts) asked the same
--      question by SELECTING seat_id from all six tables and collecting the distinct values. That
--      read is unbounded, and PostgREST stops at `max_rows = 1000` (supabase/config.toml) with no
--      error and no marker — the array just stops. The gate it feeds decides whether a territory
--      joins the 06:55 digest and the "your coming week is not sent" reminder, so past the cap a
--      territory would silently DROP OUT of both: the one failure shape that looks exactly like a
--      quiet morning. Measured on production 2026-10-02, the day before Delta (1) starts: 13 plan
--      rows and 12 day-activity rows, 0 visits — so nothing is being dropped TODAY. At the ~600
--      visits a working day the module is sized for, `phoenix_crm_visits` crosses 1,000 rows inside
--      two field days, which is why this lands now rather than after.
--
--      An `exists` per seat per table stops at the first matching row, and the caller still chunks
--      at 200 seats, so the RESULT can never approach the cap either.
--
--   2. phoenix_crm_expire_plan_edit_requests(p jsonb)
--      Closes every request to edit a sent week whose week has passed (`week_start + 5 < today` in
--      Cairo) — by calling phoenix_crm_decide_plan_edit_request for each one, so the existing
--      expiry branch stays the ONLY writer of `status = 'expired'`.
--
--      WHY: that branch is reachable only when somebody DECIDES a request, and nobody decides one
--      whose week is over — it has already dropped out of every queue (`loadPlanEditRows` filters
--      `week_start >= today - 5`). So the row sat on `manager_pending` for ever: invisible to its
--      reviewer, while the rep's own panel still said it was waiting, and the `plan_edit_expired`
--      notice never went. Production holds 1 waiting request today (week starting 2026-10-03), not
--      yet past its week, so this pass closes NOTHING on its first run.
--
--      🔴 THE SELECTION IS MADE IN SQL, IN THE SAME TRANSACTION, ON PURPOSE. The decide function
--      applies the stage's decision whenever the week has NOT passed, so a caller that chose the
--      rows itself — against its own clock, a day out across midnight — would APPROVE a live
--      request as the system, or at the HR step REOPEN a week nobody asked to reopen. Selecting
--      with the same `now() at time zone 'Africa/Cairo'` the function reads (one transaction, one
--      transaction timestamp) makes the expiry branch the only branch that can be taken.
--
-- WHY: both are defects found by the 2026-10-02 Phoenix CRM audit, before Delta (1) goes live on
--   Saturday 3 October. Neither has misreported anything yet; both would within days.
--
-- ROLLBACK:
--   drop function public.phoenix_crm_expire_plan_edit_requests(jsonb);
--   drop function public.phoenix_crm_seats_with_activity(jsonb);
--   Nothing else to undo — no table, column, grant or row is touched, and `seatsWithRealActivity`
--   falls back to nothing: the caller must be reverted with it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- ── 1. Which territories have ever carried real work ────────────────────────────────────────────
-- Real rows only (`is_test = false`): a Super Admin's try-out, or a test login's — which carries the
-- mirrored rep's own HR id — must never switch a real manager's 06:55 message on for a territory
-- nobody has really touched.

create or replace function public.phoenix_crm_seats_with_activity(p jsonb)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(jsonb_agg(asked.seat_id), '[]'::jsonb)
  from (
    select distinct elem.seat_id
    from jsonb_array_elements_text(coalesce(p -> 'seat_ids', '[]'::jsonb)) as elem(seat_id)
  ) asked
  where exists (select 1 from public.phoenix_crm_visits t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_places t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_plans t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_monthly_plans t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_day_activities t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_list_requests t where t.seat_id = asked.seat_id and t.is_test = false);
$$;

revoke execute on function public.phoenix_crm_seats_with_activity(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_seats_with_activity(jsonb) to service_role;

-- ── 2. The daily expiry of a request to edit a week that has passed ─────────────────────────────
-- It writes nothing itself. Each stale request is handed to phoenix_crm_decide_plan_edit_request
-- with the stage the ROW is on and that row's own version, and that function's expiry branch closes
-- it and writes the `expired` event. A row whose version moved under us (somebody decided it in the
-- same moment) raises `version_conflict`; it is counted and skipped, and tomorrow's pass takes it.
--
-- `actor_hr_id` is the system marker, never a person: nobody decided this. It reaches only the
-- event row's `actor_hr_id`, which no screen resolves to a name — the expiry branch writes no
-- `*_decided_by_hr_id` column at all.

create or replace function public.phoenix_crm_expire_plan_edit_requests(p jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_row record;
  v_result jsonb;
  v_closed jsonb := '[]'::jsonb;
  v_stale integer := 0;
  v_failed integer := 0;
begin
  if v_actor is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  for v_row in
    select r.id, r.seat_id, r.week_start, r.rep_hr_id, r.status, r.version, r.is_test
    from public.phoenix_crm_plan_edit_requests r
    where r.status in ('manager_pending', 'sfe_pending', 'hr_pending')
      and r.week_start + 5 < v_today
    order by r.created_at
  loop
    v_stale := v_stale + 1;
    begin
      v_result := public.phoenix_crm_decide_plan_edit_request(jsonb_build_object(
        'request_id', v_row.id,
        'stage', case v_row.status when 'manager_pending' then 'manager' when 'sfe_pending' then 'sfe' else 'hr' end,
        'decision', case when v_row.status = 'hr_pending' then 'acknowledge' else 'approve' end,
        'actor_hr_id', v_actor,
        'actor_role', 'System',
        'note', null,
        'expected_version', v_row.version,
        'is_test', v_row.is_test
      ));
    exception
      when others then
        v_failed := v_failed + 1;
        continue;
    end;
    -- Belt and braces: the function cannot reach any other status for a week that has passed, and a
    -- row that somehow did is NOT reported as closed — the notice would then name the wrong step.
    if v_result ->> 'status' = 'expired' then
      v_closed := v_closed || jsonb_build_array(jsonb_build_object(
        'request_id', v_result ->> 'request_id',
        'plan_id', v_result ->> 'plan_id',
        'seat_id', v_row.seat_id,
        'week_start', v_row.week_start,
        'rep_hr_id', v_row.rep_hr_id,
        'from_status', v_row.status,
        'version', (v_result ->> 'version')::integer,
        'is_test', v_row.is_test
      ));
    else
      v_failed := v_failed + 1;
    end if;
  end loop;

  return jsonb_build_object('cairo_today', v_today, 'stale', v_stale, 'failed', v_failed, 'closed', v_closed);
end;
$$;

revoke execute on function public.phoenix_crm_expire_plan_edit_requests(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_expire_plan_edit_requests(jsonb) to service_role;

-- PostgREST caches the schema, and an RPC it has not seen answers PGRST202 — which this repo's own
-- error reader files as "the mirror is not provisioned" and degrades to empty. Both functions are
-- called through PostgREST, so both need this.
notify pgrst, 'reload schema';

commit;
