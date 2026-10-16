-- phoenix_crm_recorded_visit_waits_for_the_administrator
--
-- WHAT THIS CHANGES:
--   * public.phoenix_crm_visit_recordings gains the Administrator's review: review_status ('pending',
--     'approved', 'refused'; default 'pending'), reviewed_by_hr_id, reviewed_at, review_note.
--   * public.phoenix_crm_unplanned_visits gains the status 'admin_pending' and the column
--     after_admin_status (the step it moves to once the Administrator approves). Its events take the
--     actor_stage 'administrator'.
--   * A BEFORE INSERT trigger on public.phoenix_crm_unplanned_visits starts a RECORDED off-plan visit at
--     'admin_pending' instead of at the manager's or SFE's step.
--   * public.phoenix_crm_countable_visits leaves out every visit whose recording the Administrator has
--     not approved, whatever the visit's type.
--   * A new function public.phoenix_crm_review_visit_recording(jsonb): the Administrator approves or
--     refuses one recorded visit.
--   * public.phoenix_crm_report_visits_by_day and public.phoenix_crm_report_plan_vs_actual count such a
--     visit as WAITING, beside the figure, exactly as an off-plan visit waiting for its manager.
-- WHY:
--   Owner, 2026-10-16: "any visit any type which is recorder must go for adminstarator approval first
--   even if in plan". A rep the Super Admin switched on records each visit (20261016103900); from now on
--   each of those visits — planned, out of plan, out of list, a pharmacy — waits for the Administrator
--   (Omar Gawish, B-10) and counts in nothing until he approves it. FIRST means before anybody else: a
--   recorded off-plan visit reaches the district manager and SFE only after his yes, and their two steps
--   then run exactly as before. His refusal ends it; the visit never counts.
--
--   This is the one place the Administrator IS a step (everywhere else he is not — 20261008160000). It
--   is his own rule, and it is bounded by the recording: a visit with no recording row is untouched.
--
--   The decision is kept on the RECORDING row because that is the one row every recorded visit has, of
--   every type; the off-plan row only carries where its own chain stands. A recording deleted before he
--   decides keeps its row (deleted_at), so its visit still waits and is still decided.
--
--   The trigger reads the recording the save CLAIMED a moment earlier in the same request
--   (phoenix_crm_claim_visit_recording runs before phoenix_crm_save_visit), so the save itself is not
--   touched. Its 'raised' event still names the step the chain will start at once he approves.
-- ROLLBACK:
--   Re-run the 20261007111250 view block, the 20260926163000 phoenix_crm_report_visits_by_day block and
--   the 20261006121846 phoenix_crm_report_plan_vs_actual block;
--   drop trigger if exists phoenix_crm_unplanned_waits_for_the_administrator on public.phoenix_crm_unplanned_visits;
--   drop function if exists public.phoenix_crm_unplanned_waits_for_the_administrator();
--   drop function if exists public.phoenix_crm_review_visit_recording(jsonb);
--   then move any 'admin_pending' row to its after_admin_status before restoring the two old CHECKs.
--   The added columns can stay; dropping them discards who approved which recorded visit.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: columns and a status are added, two CHECKs are widened, one view and two read-only
-- functions are replaced. Measured on production before writing it: 1 recording slot issued, 0 claimed,
-- so no saved visit changes how it counts.
--
-- READBACK (reads only):
--   select
--     (select count(*) from information_schema.columns where table_name = 'phoenix_crm_visit_recordings'
--       and column_name in ('review_status', 'reviewed_by_hr_id', 'reviewed_at', 'review_note')) as review_columns,
--     (select pg_get_constraintdef(oid) from pg_constraint where conname = 'phoenix_crm_unplanned_visits_status') as status_check,
--     (select count(*) from pg_trigger where tgname = 'phoenix_crm_unplanned_waits_for_the_administrator') as trigger_count,
--     (select prosecdef from pg_proc where proname = 'phoenix_crm_review_visit_recording') as review_is_definer,
--     position('phoenix_crm_visit_recordings' in pg_get_viewdef('public.phoenix_crm_countable_visits'::regclass)) > 0 as view_reads_review;
--   review_columns 4, status_check naming admin_pending, trigger_count 1, review_is_definer true, view_reads_review true.

begin;
set local lock_timeout = '5s';

-- === 1. The Administrator's review, on the recording =============================================

alter table public.phoenix_crm_visit_recordings
  add column if not exists review_status text not null default 'pending',
  add column if not exists reviewed_by_hr_id text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

alter table public.phoenix_crm_visit_recordings drop constraint if exists phoenix_crm_visit_recordings_review_status;
alter table public.phoenix_crm_visit_recordings
  add constraint phoenix_crm_visit_recordings_review_status check (review_status in ('pending', 'approved', 'refused'));
alter table public.phoenix_crm_visit_recordings drop constraint if exists phoenix_crm_visit_recordings_reviewed;
alter table public.phoenix_crm_visit_recordings
  add constraint phoenix_crm_visit_recordings_reviewed check (
    (review_status = 'pending') = (reviewed_at is null)
    and (reviewed_at is null) = (reviewed_by_hr_id is null)
    and (review_note is null or char_length(review_note) <= 500)
  );

-- His queue: the claimed recordings still waiting for him, oldest first.
create index if not exists phoenix_crm_visit_recordings_review_idx
  on public.phoenix_crm_visit_recordings (claimed_at)
  where visit_id is not null and review_status = 'pending';

-- === 2. The off-plan chain waits for him first ===================================================

alter table public.phoenix_crm_unplanned_visits
  add column if not exists after_admin_status text;

alter table public.phoenix_crm_unplanned_visits drop constraint if exists phoenix_crm_unplanned_visits_status;
alter table public.phoenix_crm_unplanned_visits
  add constraint phoenix_crm_unplanned_visits_status
  check (status in ('admin_pending', 'manager_pending', 'sfe_pending', 'approved', 'refused'));
alter table public.phoenix_crm_unplanned_visits drop constraint if exists phoenix_crm_unplanned_visits_after_admin;
alter table public.phoenix_crm_unplanned_visits
  add constraint phoenix_crm_unplanned_visits_after_admin check (
    (after_admin_status is null or after_admin_status in ('manager_pending', 'sfe_pending'))
    and (status <> 'admin_pending' or after_admin_status is not null)
  );

alter table public.phoenix_crm_unplanned_visit_events drop constraint if exists phoenix_crm_unplanned_visit_events_stage;
alter table public.phoenix_crm_unplanned_visit_events
  add constraint phoenix_crm_unplanned_visit_events_stage
  check (actor_stage is null or actor_stage in ('manager', 'sfe', 'administrator'));

create or replace function public.phoenix_crm_unplanned_waits_for_the_administrator()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.status in ('manager_pending', 'sfe_pending')
    and exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = new.visit_id and r.review_status = 'pending'
    ) then
    new.after_admin_status := new.status;
    new.status := 'admin_pending';
  end if;
  return new;
end;
$$;

revoke execute on function public.phoenix_crm_unplanned_waits_for_the_administrator() from public, anon, authenticated;
grant execute on function public.phoenix_crm_unplanned_waits_for_the_administrator() to service_role;

drop trigger if exists phoenix_crm_unplanned_waits_for_the_administrator on public.phoenix_crm_unplanned_visits;
create trigger phoenix_crm_unplanned_waits_for_the_administrator
  before insert on public.phoenix_crm_unplanned_visits
  for each row execute function public.phoenix_crm_unplanned_waits_for_the_administrator();

-- === 3. A recorded visit counts only once he approves it =========================================
-- Byte-identical to 20261007111250 except for the last predicate. security_invoker stays.

create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select
    v.id, v.seat_id, v.line_code, v.customer_id, v.list_type, v.visit_date, v.captured_at, v.kind,
    v.rep_hr_id, v.manager_hr_id, v.senior_hr_id, v.entered_by_hr_id, v.products, v.comment,
    v.photo_path, v.lat, v.lon, v.accuracy_meters, v.place_id, v.distance_meters, v.location_flag,
    v.device_skew_minutes, v.is_test, v.created_at, v.pharmacy_name, v.product_availability,
    v.voice_note_path, v.voice_note_seconds, v.voice_note_bytes, v.is_unplanned, v.next_step,
    v.next_step_on, v.objection, v.objection_note, v.samples_given, v.dwell_seconds,
    v.form_open_seconds, v.capture_source, v.time_anchor_id, v.offline_seconds, v.synced_at,
    v.photo_lat, v.photo_lon, v.photo_accuracy_meters, v.photo_captured_at, v.unplanned_kind,
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does.
    (c.validated_at is not null or c.list_type = 'Pharmacy') as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id
  from public.phoenix_crm_visits v
  join public.phoenix_crm_customers c on c.id = v.customer_id
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where (not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list')
    -- A recorded visit counts once the Administrator approves it (owner, 2026-10-16).
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    );

comment on view public.phoenix_crm_countable_visits is
  'Visits that count in a KPI, and the second half of that question beside each one. A row is here '
  'when it was on a sent plan, or it is an off-plan visit the manager and the SFE have approved, or '
  'it is an out-of-list visit (which has no approval of its own) — and, for a RECORDED visit, only '
  'once the Administrator has approved its recording (owner, 2026-10-16). `customer_validated` is the '
  'other half: false until the visit''s customer is validated and admitted to the list — except a '
  'PHARMACY, which needs no validation and is always true (owner, 2026-10-03). A KPI counts only the '
  'rows where it is true. The rep''s own "visits saved here, not counting yet" deliberately does not '
  'read it, because it is counting what he saved rather than what counts. The anti-fraud path reads '
  'the raw table and judges everything. `product_manager_hr_id` is the THIRD place a person stands on '
  'a visit, beside manager_hr_id and senior_hr_id — it sits last in the column list only because the '
  'view cannot be recreated, and must be read by name.';

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- === 4. His decision =============================================================================
-- Refuses a visit with no recording, one already decided, and a refusal with no note. On a recorded
-- off-plan visit it also moves the chain: his yes hands it to the step it was going to start at, his
-- no refuses it. Returns where both now stand.

create or replace function public.phoenix_crm_review_visit_recording(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_visit_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_decision text := coalesce(p ->> 'decision', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_rec public.phoenix_crm_visit_recordings%rowtype;
  v_visit public.phoenix_crm_visits%rowtype;
  v_row public.phoenix_crm_unplanned_visits%rowtype;
  v_status text;
  v_unplanned_status text := null;
  v_unplanned_version integer := null;
begin
  if v_visit_id is null or v_actor is null
    or v_decision not in ('approve', 'refuse')
    or (v_note is not null and char_length(v_note) > 500) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_decision = 'refuse' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  select r.* into v_rec from public.phoenix_crm_visit_recordings r where r.visit_id = v_visit_id for update;
  if not found then
    raise exception 'phoenix_crm:recording_review_not_found';
  end if;
  select v.* into v_visit from public.phoenix_crm_visits v where v.id = v_visit_id;
  if not found then
    raise exception 'phoenix_crm:recording_review_not_found';
  end if;
  if v_rec.review_status <> 'pending' then
    raise exception 'phoenix_crm:recording_reviewed';
  end if;

  v_status := case when v_decision = 'approve' then 'approved' else 'refused' end;
  update public.phoenix_crm_visit_recordings r
  set review_status = v_status,
      reviewed_by_hr_id = v_actor,
      reviewed_at = now(),
      review_note = v_note
  where r.path = v_rec.path;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:unplanned:' || v_visit_id::text));
  select u.* into v_row from public.phoenix_crm_unplanned_visits u where u.visit_id = v_visit_id for update;
  if found then
    if v_row.status = 'admin_pending' then
      update public.phoenix_crm_unplanned_visits u
      set status = case when v_decision = 'approve' then u.after_admin_status else 'refused' end,
          decided_at = case when v_decision = 'approve' then null else now() end,
          admin_decided_by_hr_id = v_actor,
          admin_decided_at = now(),
          admin_note = v_note,
          version = u.version + 1,
          updated_at = now()
      where u.visit_id = v_visit_id
      returning u.* into v_row;

      insert into public.phoenix_crm_unplanned_visit_events
        (visit_id, event_type, actor_hr_id, actor_role, actor_stage, from_status, to_status, version, note)
      values
        (v_visit_id, case when v_decision = 'refuse' then 'refused' else 'approved' end,
         v_actor, v_role, 'administrator', 'admin_pending', v_row.status, v_row.version, v_note);
    end if;
    v_unplanned_status := v_row.status;
    v_unplanned_version := v_row.version;
  end if;

  return jsonb_build_object(
    'visit_id', v_visit_id,
    'seat_id', v_visit.seat_id,
    'rep_hr_id', coalesce(v_visit.rep_hr_id, v_rec.issued_to_hr_id),
    'customer_id', v_visit.customer_id,
    'visit_date', v_visit.visit_date,
    'is_test', v_visit.is_test,
    'is_unplanned', v_visit.is_unplanned,
    'unplanned_kind', v_visit.unplanned_kind,
    'review_status', v_status,
    'unplanned_status', v_unplanned_status,
    'unplanned_version', v_unplanned_version
  );
end;
$$;

revoke execute on function public.phoenix_crm_review_visit_recording(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_review_visit_recording(jsonb) to service_role;

-- === 5. The by-day report says the day is waiting =================================================
-- Byte-identical to 20260926163000 except for the `waiting` CTE, which also counts a visit waiting
-- for the Administrator. The column keeps its name: the screen reads it as "waiting for a decision".

create or replace function public.phoenix_crm_report_visits_by_day(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with counted as (
    select
      v.seat_id,
      v.rep_hr_id,
      v.visit_date,
      v.list_type,
      count(*)::integer as visits,
      (count(*) filter (where v.kind = 'double'))::integer as double_visits,
      (count(*) filter (where v.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where v.location_flag = 'far'))::integer as far_visits,
      (count(*) filter (where v.is_test))::integer as test_visits
    -- The countable view, never the base table: an off-plan visit counts in nothing until the manager
    -- and then the SFE have approved it, and a recorded visit until the Administrator has.
    from public.phoenix_crm_countable_visits v
    -- A visit counts only once its customer is validated; then every earlier one counts too.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, v.visit_date, v.list_type
  ),
  -- Beside the count, not inside it: a day whose figure is low because three visits are waiting for a
  -- decision must say so, or the dip reads as a rep who did not work.
  waiting as (
    select v.seat_id, v.rep_hr_id, v.visit_date, v.list_type, count(*)::integer as unplanned_waiting
    from public.phoenix_crm_visits v
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
    left join public.phoenix_crm_visit_recordings r on r.visit_id = v.id
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
      and (
        u.status in ('admin_pending', 'manager_pending', 'sfe_pending')
        or (r.review_status = 'pending' and (u.status is null or u.status <> 'refused'))
      )
    group by v.seat_id, v.rep_hr_id, v.visit_date, v.list_type
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.visit_date, t.list_type, t.rep_hr_id), '[]'::jsonb)
  from (
    select
      coalesce(c.seat_id, w.seat_id) as seat_id,
      coalesce(c.rep_hr_id, w.rep_hr_id) as rep_hr_id,
      coalesce(c.visit_date, w.visit_date) as visit_date,
      coalesce(c.list_type, w.list_type) as list_type,
      coalesce(c.visits, 0) as visits,
      coalesce(c.double_visits, 0) as double_visits,
      coalesce(c.chain_visits, 0) as chain_visits,
      coalesce(c.far_visits, 0) as far_visits,
      coalesce(c.test_visits, 0) as test_visits,
      coalesce(w.unplanned_waiting, 0) as unplanned_waiting
    from counted c
    full join waiting w
      on w.seat_id = c.seat_id
     and w.visit_date = c.visit_date
     and w.list_type = c.list_type
     and w.rep_hr_id is not distinct from c.rep_hr_id
  ) t;
$$;

revoke execute on function public.phoenix_crm_report_visits_by_day(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_visits_by_day(text[], date, date, boolean) to service_role;

-- === 6. The plan report: a recorded visit is waiting, never a kept plan, until he approves ========
-- Byte-identical to 20261006121846 except for the recording's review: read beside the off-plan status,
-- a visit waiting for the Administrator is WAITING (never a kept plan, never a miss), and one he
-- refused stands beside the refused off-plan visits.

create or replace function public.phoenix_crm_report_plan_vs_actual(
  p_seat_ids text[],
  p_from date,
  p_to date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with plan_days as (
    select distinct pl.id as plan_id, i.plan_date
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = any (p_seat_ids)
      and pl.week_start between p_from - 6 and p_to
      and i.plan_date between p_from and p_to
      and (p_include_test or not pl.is_test)
  ),
  -- WAS THIS DAY ON A SENT PLAN? The plan's latest event by the end of that Cairo day — the same
  -- "before the next Cairo midnight" boundary as before, and the same test phoenix_crm_save_visit
  -- applies at the door (v_on_sent_plan) and plan-rules.ts applies on every screen (isPlanDaySent).
  --
  -- A draft is the rep's own to edit, so it is never authority; a week returned WHOLE is back with
  -- him too, so it is not authority either — which is what the old `in (..., 'returned')` got wrong.
  -- The one exception is a ONE-DAY return (owner, 2026-10-02, "Still planned"): that week still
  -- stands on every OTHER day exactly as it stood when the day was returned, until an acknowledged
  -- edit request opens the whole week to him, because a day he can change is never authority.
  --
  -- `cross join lateral … limit 1` rather than a scalar subquery because the branch needs THREE
  -- fields of that one latest event — its status, its details and its own time — and asking for them
  -- in three subqueries would let the three read different events on a tie.
  sent_days as (
    select d.plan_id, d.plan_date
    from plan_days d
    cross join lateral (
      select e.to_status, e.details, e.created_at
      from public.phoenix_crm_plan_events e
      where e.plan_id = d.plan_id
        and e.to_status is not null
        and e.created_at < ((d.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
      order by e.created_at desc, e.id desc
      limit 1
    ) latest
    where latest.to_status in ('submitted', 'approved')
       or (
         latest.to_status = 'returned'
         and nullif(latest.details ->> 'returned_day', '') is not null
         and nullif(latest.details ->> 'returned_day', '')::date <> d.plan_date
         and not exists (
           select 1
           from public.phoenix_crm_plan_edit_requests r
           where r.plan_id = d.plan_id
             and r.hr_acknowledged_at > latest.created_at
             and r.hr_acknowledged_at < ((d.plan_date + 1)::timestamp at time zone 'Africa/Cairo')
         )
       )
  ),
  planned as (
    select pl.seat_id, pl.is_test, i.plan_date, i.customer_id, i.list_type
    from sent_days s
    join public.phoenix_crm_plans pl on pl.id = s.plan_id
    join public.phoenix_crm_plan_items i on i.plan_id = s.plan_id and i.plan_date = s.plan_date
    -- The DENOMINATOR: planning a customer who is not validated yet is never held against the rep.
    join public.phoenix_crm_customers c on c.id = i.customer_id and c.validated_at is not null
    -- 🔴 WHICH SEAT HELD HIM AT THE END OF THAT CAIRO DAY. The newest move at or before the day
    -- decides, so a customer who moved away and later moved back is counted on each seat exactly for
    -- the days he was there — a `max(moved_at)` would have excluded the days after his return. No move
    -- row at all means he never left, which is every customer until one is moved.
    left join lateral (
      select m.to_seat_id
      from public.phoenix_crm_customer_moves m
      where m.customer_id = i.customer_id
        and (m.moved_at at time zone 'Africa/Cairo')::date <= i.plan_date
      order by m.moved_at desc, m.id desc
      limit 1
    ) held_by on true
    -- 🔴 AND NEITHER IS A CUSTOMER WHO HAS LEFT THE LIST. phoenix_crm_save_visit raises
    -- `phoenix_crm:customer_dropped` for him, so a day planned after the drop is a visit the rep is
    -- REFUSED and was then counted as having missed. The day of the drop itself stays in — he was on
    -- the list for part of it — and the Cairo day is read from the instant, because
    -- `status_changed_at::date` would be the UTC one and would move every drop made in the first two
    -- or three hours of a Cairo day into the day before.
    where (
      c.status <> 'dropped'
      or i.plan_date <= ((c.status_changed_at at time zone 'Africa/Cairo')::date)
    )
      -- A day after he was handed to another rep is the same refusal in the other shape: this rep
      -- cannot visit him, so the day is out of HIS denominator and sits in the new rep's.
      and (held_by.to_seat_id is null or held_by.to_seat_id = pl.seat_id)
  ),
  -- The base table on purpose, not the countable view: this report's job is to SHOW the manager the
  -- off-plan work, and a visit that has vanished from it cannot be approved by anyone. What the
  -- decision changes is the two columns beside it.
  visited as (
    select v.seat_id, v.is_test, v.visit_date, v.customer_id, v.list_type, v.is_unplanned, u.status as unplanned_status,
      r.review_status as recording_status
    from public.phoenix_crm_visits v
    -- The NUMERATOR: the same filter, so both sides move together.
    join public.phoenix_crm_customers c on c.id = v.customer_id and c.validated_at is not null
    left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
    -- A recorded visit waits for the Administrator (owner, 2026-10-16).
    left join public.phoenix_crm_visit_recordings r on r.visit_id = v.id
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  ),
  joined as (
    select
      coalesce(pd.seat_id, vd.seat_id) as seat_id,
      coalesce(pd.plan_date, vd.visit_date) as day,
      coalesce(pd.list_type, vd.list_type) as list_type,
      pd.customer_id is not null as is_planned,
      vd.customer_id is not null as is_visited,
      coalesce(vd.is_unplanned, false) as is_unplanned,
      vd.unplanned_status,
      vd.recording_status
    from planned pd
    full join visited vd
      on vd.seat_id = pd.seat_id
     and vd.is_test = pd.is_test
     and vd.visit_date = pd.plan_date
     and vd.customer_id = pd.customer_id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.day, t.list_type), '[]'::jsonb)
  from (
    select
      j.seat_id,
      j.day,
      j.list_type,
      (count(*) filter (where j.is_planned))::integer as planned,
      -- A visit the rep did not plan is not a plan he kept, however the plan was edited afterwards.
      (count(*) filter (where j.is_planned and j.is_visited and not j.is_unplanned and coalesce(j.recording_status, 'approved') = 'approved'))::integer as visited_planned,
      -- Beside it, never silently a miss: he was there, and it is waiting on somebody.
      (count(*) filter (where j.is_planned and j.is_visited and (
        (j.is_unplanned and j.unplanned_status in ('admin_pending', 'manager_pending', 'sfe_pending'))
        or (not j.is_unplanned and j.recording_status = 'pending')
      )))::integer as planned_waiting,
      (count(*) filter (where j.is_planned and not j.is_visited))::integer as missed,
      (count(*) filter (where j.is_visited and not j.is_planned))::integer as unplanned,
      (count(*) filter (where j.is_visited and not j.is_planned and (
        j.unplanned_status in ('admin_pending', 'manager_pending', 'sfe_pending')
        or (j.unplanned_status is null and j.recording_status = 'pending')
      )))::integer as unplanned_waiting,
      (count(*) filter (where j.is_visited and not j.is_planned and (j.unplanned_status = 'refused' or j.recording_status = 'refused')))::integer as unplanned_refused
    from joined j
    group by j.seat_id, j.day, j.list_type
  ) t;
$$;

comment on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) is
  'Plan versus actual per seat, day and list: a day counts only when it stood on a sent plan, a customer counts only while he is validated, on the list and on THAT seat, and an off-plan visit is shown beside the miss rather than inside it.';

revoke execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
