-- Doctor lists follow EACH TEAM'S Phoenix CRM start, not one global cutover date.
--
-- WHY. Delta (1) has been counted from Phoenix CRM since Saturday 3 October (owner, 2026-10-02), and
-- `phoenix_crm_team_starts` carries that per District Manager seat. The doctor LIST never learned about
-- it: both halves of the list machinery still ask the GLOBAL `crm_cutover.cutover_date`, which is NULL
-- on production and which a per-team start never sets. The two halves then fail in OPPOSITE directions,
-- which is why this is one migration and not two:
--
--   crm_contact_list_change_apply()   fails CLOSED.  `if v_cutover is null or v_today < v_cutover then
--                                     raise` — so with the date unset it refuses EVERY change, for
--                                     everyone, with "Doctor lists still come from iReports360 until the
--                                     CRM cutover date." Measured on production 2026-10-04:
--                                     crm_contact_list_changes holds 0 rows and has never held one. A
--                                     Delta (1) manager cannot add, remove or regrade a doctor at all.
--
--   crm_contact_master_refresh()      fails OPEN.  `v_lists_live := coalesce(cairo_today < cutover_date,
--                                     true)` — NULL coalesces to TRUE, so the hourly rebuild still runs
--                                     the vendor passes for a started team. On its own that is latent
--                                     (nothing writes a Phoenix list row today), but the moment the
--                                     refusal above is lifted it becomes the defect the original
--                                     migration's own header warned about: it would "re-open a removed
--                                     doctor the next morning."
--
-- So lifting only the refusal would hand a manager a change the next hourly run silently undoes, and
-- fixing only the rebuild would leave the feature dead. Both, together, or neither.
--
-- WHAT CHANGES.
--   * A rep on a STARTED team owns his own list from his start date. `crm_contact_list_change_apply`
--     accepts his change; the global cutover still works as a second path if it is ever set.
--   * `crm_contact_master_refresh` FREEZES a started rep's assignment rows — it no longer discards,
--     closes, touches or opens them. It does not delete or close anything: his existing rows stay open
--     exactly as they are, so every doctor-list screen keeps showing the same list today and this
--     migration changes no number anywhere. What it stops is the vendor re-deriving a list Phoenix owns.
--   * The refresh's CONTACT identity pass (name, speciality, phone, address, city, zone, region) stays
--     GLOBAL on purpose. That is reference data keyed by `contact_crm_id`, not by rep — a started team's
--     doctors are the same doctors, and freezing their details would strand them at today's spelling.
--     Verified safe on production 2026-10-04: no `crm_contacts` row has `source = 'phoenix'` (sources
--     are list, plan, visit), so the pass's `source = 'list'` write cannot overwrite a Phoenix-born
--     doctor. The `crm_contact_fold_grade`/activity passes are untouched.
--   * The refresh now REPORTS what it froze (`startedRepsFrozen`, `assignmentsFrozen`). A pass that
--     silently does less is the shape that hid the dead sheet token for 59 days — it leaves a trace.
--
-- MEASURED BEFORE (production, 2026-10-04 11:46 Cairo):
--   phoenix_crm_started_team_reps()                     17 people, all counted_from 2026-10-03
--   their open crm_contact_assignments                  1,997 — every one source = 'ireports360',
--                                                       16 agents, 1,997 distinct doctors, 0 Phoenix rows
--   open rows with no agent_hr_id                       0  (so the HR-id key carries; the crm_id leg
--                                                       below is belt-and-braces, as in the TS rule)
--   their Phoenix customers                             ~2,189 across 16 rep seats (91-177 each), which
--                                                       is why `pending` is a VALIDATION state and not
--                                                       list membership — the lists are a real substitute
--   crm_contact_list_changes                            0 rows, 0 applied, 0 for a started rep
--
-- WHAT THIS DOES *NOT* DO. The doctor-list SCREENS still read `crm_contact_assignments`, so they still
-- show the vendor's list for a started team. There is no `crm_contact_assignments_unified` the way there
-- is for visits, and building one touches the KPI coverage and frequency DENOMINATORS — and
-- `kpiRulesFor` still answers `legacy` while the global cutover date is null, so Delta (1)'s October is
-- scored by pre-cutover KPI rules. That is the owner's ruling to make on the KPI screen, not a
-- migration's. This migration makes the list EDITABLE by its owner and keeps the vendor from reverting
-- the edit; it does not re-point any reader.
--
-- The matching TypeScript rule is `startedWindowCovers` in src/lib/crm/phoenix-team-starts.ts, and the
-- one RPC read is src/lib/crm/phoenix-started-reps.ts. This SQL is the same rule in the database.
--
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — crm_refresh_started_reps and
-- crm_contact_master_activity, both inside the body of public.crm_contact_master_refresh, which
-- creates and drops them within its own call. They are SESSION-LOCAL scratch tables; no persistent
-- table is dropped or truncated anywhere here. (`scripts/check-migrations.mjs` matches the statement,
-- not the schema, so it cannot tell pg_temp from public; this annotation is placed in the header
-- rather than beside each statement so the function's stored source stays byte-for-byte what
-- production already holds.)

-- ---------------------------------------------------------------------------------------------------
-- 1. A rep on a started team may change his own list.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.crm_contact_list_change_apply(
  p_change_id uuid,
  p_decided_by text,
  p_note text default null::text
)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_cutover date := (select c.cutover_date from public.crm_cutover c where c.id);
  v_change public.crm_contact_list_changes%rowtype;
  v_rep_crm_id bigint;
  v_contact bigint;
  v_agent_crm_id bigint;
  v_removed integer := 0;
  v_closed integer := 0;
  v_current_grade text;
  v_phoenix_owns boolean;
begin
  select * into v_change from public.crm_contact_list_changes where id = p_change_id for update;
  if not found then
    raise exception 'That change was not found.' using errcode = 'P0001';
  end if;
  if v_change.status <> 'pending' then
    raise exception 'This change has already been decided or withdrawn.' using errcode = 'P0001';
  end if;

  select case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end
    into v_rep_crm_id
    from public.employees e
   where e.hr_id = v_change.rep_hr_id;

  -- THE SWITCH. This rep's list is Phoenix's either because his own team has started (the live rule) or
  -- because the global cutover date has passed (kept so a future global cutover still works). Before
  -- 2026-10-04 only the second existed, and with the date NULL it refused every change ever requested.
  v_phoenix_owns := exists (
    select 1
      from public.phoenix_crm_started_team_reps() s
     where v_today >= s.counted_from
       and (s.counted_until is null or v_today < s.counted_until)
       and (s.hr_key = lower(btrim(v_change.rep_hr_id))
            or (v_rep_crm_id is not null and s.agent_crm_id = v_rep_crm_id))
  ) or (v_cutover is not null and v_today >= v_cutover);

  if not v_phoenix_owns then
    raise exception 'Doctor lists for this rep still come from iReports360 — his team has not started in Phoenix CRM yet.'
      using errcode = 'P0001';
  end if;

  if p_decided_by is distinct from (case when v_change.direct then v_change.requested_by else v_change.manager_hr_id end) then
    raise exception 'Only the manager this change was sent to can approve it.' using errcode = 'P0001';
  end if;

  v_contact := v_change.contact_crm_id;

  if v_change.action = 'add' then
    if v_contact is null then
      v_contact := nextval('public.crm_contacts_phoenix_id_seq');
      insert into public.crm_contacts (contact_crm_id, name, speciality, address, source, first_seen_on)
      values (v_contact, btrim(v_change.new_contact_name), btrim(v_change.new_contact_speciality),
              nullif(btrim(v_change.new_contact_address), ''), 'phoenix', v_today);
    elsif exists (
      select 1
        from public.crm_contact_assignments a
       where a.effective_to is null
         and a.contact_crm_id = v_contact
         and a.list_type = v_change.list_type
         and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
              or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id))
    ) then
      raise exception 'That doctor is already on this list.' using errcode = 'P0001';
    end if;

    v_agent_crm_id := case
      when v_rep_crm_id is not null and not exists (
        select 1
          from public.crm_contact_assignments o
         where o.effective_to is null
           and o.contact_crm_id = v_contact
           and o.agent_crm_id = v_rep_crm_id
           and o.list_type = v_change.list_type
      ) then v_rep_crm_id
    end;

    insert into public.crm_contact_assignments (
      contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
    ) values (
      v_contact, v_agent_crm_id, v_change.rep_hr_id, v_change.list_type, v_change.grade, v_today, v_today, 'phoenix'
    );
  else
    select a.grade, a.agent_crm_id
      into v_current_grade, v_agent_crm_id
      from public.crm_contact_assignments a
     where a.effective_to is null
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id))
     order by a.id
     limit 1
     for update;
    if not found then
      raise exception 'That doctor is not on this list any more.' using errcode = 'P0001';
    end if;
    if v_change.action = 'regrade' and v_current_grade is not distinct from v_change.grade then
      raise exception 'That doctor already has this grade.' using errcode = 'P0001';
    end if;

    delete from public.crm_contact_assignments a
     where a.effective_to is null
       and a.effective_from >= v_today
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id));
    get diagnostics v_removed = row_count;

    update public.crm_contact_assignments a
       set effective_to = v_today - 1,
           updated_at = now()
     where a.effective_to is null
       and a.effective_from < v_today
       and a.contact_crm_id = v_contact
       and a.list_type = v_change.list_type
       and (lower(btrim(a.agent_hr_id)) = lower(btrim(v_change.rep_hr_id))
            or (a.agent_hr_id is null and v_rep_crm_id is not null and a.agent_crm_id = v_rep_crm_id));
    get diagnostics v_closed = row_count;

    if v_change.action = 'regrade' then
      insert into public.crm_contact_assignments (
        contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on, source
      ) values (
        v_contact, coalesce(v_agent_crm_id, v_rep_crm_id), v_change.rep_hr_id, v_change.list_type, v_change.grade,
        v_today, v_today, 'phoenix'
      );
    end if;
  end if;

  update public.crm_contact_list_changes
     set status = 'approved',
         decided_by = p_decided_by,
         decided_at = now(),
         decision_note = nullif(btrim(p_note), ''),
         applied_at = now(),
         applied_contact_crm_id = v_contact,
         updated_at = now()
   where id = p_change_id;

  insert into public.crm_contact_list_change_events (change_id, event, actor_hr_id, detail)
  values (
    p_change_id,
    case when v_change.direct then 'applied_directly' else 'approved' end,
    p_decided_by,
    jsonb_build_object('contactCrmId', v_contact, 'discarded', v_removed, 'closed', v_closed)
  );

  return jsonb_build_object('contactCrmId', v_contact, 'action', v_change.action, 'discarded', v_removed, 'closed', v_closed);
end;
$function$;

-- ---------------------------------------------------------------------------------------------------
-- 2. The hourly rebuild leaves a started team's list alone.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.crm_contact_master_refresh(p_include_activity boolean default false)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  -- From the CRM cutover date Phoenix owns the lists (crm_contact_list_changes) and the vendor copy is
  -- frozen: rebuilding from it would re-open every doctor a manager removed. This global date is NULL on
  -- production and a per-team start never sets it, so it governs only the teams that have NOT started —
  -- the per-rep freeze below is what carries a started team (see this migration's header).
  v_lists_live boolean := coalesce(
    (now() at time zone 'Africa/Cairo')::date < (select c.cutover_date from public.crm_cutover c where c.id),
    true
  );
  v_list_contacts integer := 0;
  v_activity_added integer := 0;
  v_activity_updated integer := 0;
  v_bricks integer := 0;
  v_closed integer := 0;
  v_touched integer := 0;
  v_opened integer := 0;
  v_discarded integer := 0;
  v_regions_from_name integer := 0;
  v_started_reps integer := 0;
  v_assignments_frozen integer := 0;
  v_step timestamptz := clock_timestamp();
  v_ms jsonb := '{}'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('public.crm_contact_master_refresh'));

  -- Everyone whose list Phoenix owns TODAY. Materialised once: the four assignment passes below each
  -- anti-join it, and a set-returning function in four correlated subqueries would be re-planned per row.
  -- Same rule as `startedWindowCovers` in src/lib/crm/phoenix-team-starts.ts — HR id first, the CRM id
  -- only when a row carries no HR id.
  drop table if exists pg_temp.crm_refresh_started_reps;
  create temporary table crm_refresh_started_reps on commit drop as
  select distinct s.hr_key, s.agent_crm_id
    from public.phoenix_crm_started_team_reps() s
   where v_today >= s.counted_from
     and (s.counted_until is null or v_today < s.counted_until);
  get diagnostics v_started_reps = row_count;

  select count(*) into v_assignments_frozen
    from public.crm_contact_assignments a
   where a.effective_to is null
     and exists (
       select 1
         from pg_temp.crm_refresh_started_reps s
        where (nullif(btrim(a.agent_hr_id), '') is not null and s.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and s.agent_crm_id = a.agent_crm_id)
     );

  if v_lists_live then
  -- CONTACT IDENTITY stays global on purpose — keyed by contact_crm_id, not by rep. See the header.
  insert into public.crm_contacts as c (
    contact_crm_id, name, name_ar, speciality, phone, address, city, zone, crm_region_name,
    source, first_seen_on
  )
  select distinct on (m.contact_crm_id)
         m.contact_crm_id,
         nullif(btrim(m.contact_name), ''),
         nullif(btrim(m.contact_name_ar), ''),
         nullif(btrim(m.speciality), ''),
         nullif(btrim(m.phone), ''),
         nullif(btrim(m.address), ''),
         nullif(btrim(m.city), ''),
         nullif(btrim(m.zone), ''),
         nullif(btrim(m.crm_region_name), ''),
         'list',
         least((m.first_seen_at at time zone 'Africa/Cairo')::date, v_today)
    from public.ireports360_contacts m
   where m.contact_crm_id > 0
     and m.contact_crm_id <> 100000
   order by m.contact_crm_id, m.synced_at desc nulls last, m.list_type, m.agent_crm_id
  on conflict (contact_crm_id) do update set
         name = coalesce(excluded.name, c.name),
         name_ar = excluded.name_ar,
         speciality = excluded.speciality,
         phone = excluded.phone,
         address = excluded.address,
         city = excluded.city,
         zone = excluded.zone,
         crm_region_name = excluded.crm_region_name,
         source = 'list',
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.name_ar, c.speciality, c.phone, c.address, c.city, c.zone, c.crm_region_name, c.source)
           is distinct from
         (coalesce(excluded.name, c.name), excluded.name_ar, excluded.speciality, excluded.phone,
          excluded.address, excluded.city, excluded.zone, excluded.crm_region_name, 'list')
      or c.first_seen_on > excluded.first_seen_on;
  get diagnostics v_list_contacts = row_count;
  end if;
  v_ms := v_ms || jsonb_build_object('list', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  if p_include_activity then
    drop table if exists pg_temp.crm_contact_master_activity;
    create temporary table crm_contact_master_activity on commit drop as
    with visit_latest as (
      select distinct on (v.contact_crm_id)
             v.contact_crm_id,
             nullif(btrim(v.contact_name), '') as name,
             nullif(btrim(v.speciality), '') as speciality,
             v.crm_region_id,
             nullif(btrim(v.crm_region_name), '') as crm_region_name,
             (min(v.visit_date) over w)::date as first_on,
             (max(v.visit_date) over w)::date as last_on
        from public.crm_visits_unified v
       where v.contact_crm_id > 0
         and v.contact_crm_id <> 100000
      window w as (partition by v.contact_crm_id)
       order by v.contact_crm_id, v.visit_date desc nulls last, v.crm_visit_id desc nulls last
    ),
    plan_latest as (
      select distinct on (p.contact_crm_id)
             p.contact_crm_id,
             nullif(btrim(p.contact_name), '') as name,
             nullif(btrim(p.speciality), '') as speciality,
             nullif(btrim(p.crm_region_name), '') as crm_region_name,
             (min(p.plan_date) over w)::date as first_on
        from public.crm_plan_entries_unified p
       where p.contact_crm_id > 0
         and p.contact_crm_id <> 100000
      window w as (partition by p.contact_crm_id)
       order by p.contact_crm_id, p.plan_date desc nulls last, p.crm_plan_entry_id desc nulls last
    )
    select coalesce(v.contact_crm_id, p.contact_crm_id) as contact_crm_id,
           case when v.contact_crm_id is not null then 'visit' else 'plan' end as source,
           coalesce(v.name, p.name) as name,
           coalesce(v.speciality, p.speciality) as speciality,
           v.crm_region_id,
           coalesce(v.crm_region_name, p.crm_region_name) as crm_region_name,
           least(v.first_on, p.first_on, (now() at time zone 'Africa/Cairo')::date) as first_seen_on,
           v.last_on as last_visited_on
      from visit_latest v
      full join plan_latest p on p.contact_crm_id = v.contact_crm_id;

    analyze pg_temp.crm_contact_master_activity;

    insert into public.crm_contacts (
      contact_crm_id, name, speciality, crm_region_id, crm_region_name, source, first_seen_on, last_visited_on
    )
    select a.contact_crm_id, a.name, a.speciality, a.crm_region_id, a.crm_region_name, a.source,
           a.first_seen_on, a.last_visited_on
      from pg_temp.crm_contact_master_activity a
    on conflict (contact_crm_id) do nothing;
    get diagnostics v_activity_added = row_count;

    update public.crm_contacts c
       set name = coalesce(a.name, c.name),
           speciality = coalesce(a.speciality, c.speciality),
           crm_region_name = coalesce(a.crm_region_name, c.crm_region_name),
           source = a.source,
           updated_at = now()
      from pg_temp.crm_contact_master_activity a
      left join (select distinct l.contact_crm_id from public.ireports360_contacts l) listed
        on listed.contact_crm_id = a.contact_crm_id
     where a.contact_crm_id = c.contact_crm_id
       and listed.contact_crm_id is null
       and c.source <> 'phoenix'
       and (c.name, c.speciality, c.crm_region_name, c.source)
             is distinct from
           (coalesce(a.name, c.name), coalesce(a.speciality, c.speciality),
            coalesce(a.crm_region_name, c.crm_region_name), a.source);
    get diagnostics v_activity_updated = row_count;

    update public.crm_contacts c
       set crm_region_id = coalesce(a.crm_region_id, c.crm_region_id),
           first_seen_on = least(c.first_seen_on, a.first_seen_on),
           last_visited_on = greatest(c.last_visited_on, a.last_visited_on),
           updated_at = now()
      from pg_temp.crm_contact_master_activity a
     where a.contact_crm_id = c.contact_crm_id
       and (c.crm_region_id, c.first_seen_on, c.last_visited_on)
             is distinct from
           (coalesce(a.crm_region_id, c.crm_region_id), least(c.first_seen_on, a.first_seen_on),
            greatest(c.last_visited_on, a.last_visited_on));
    v_ms := v_ms || jsonb_build_object('activity', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
    v_step := clock_timestamp();
  end if;

  update public.crm_contacts c
     set crm_region_id = r.crm_region_id,
         updated_at = now()
    from (
      select lower(btrim(rr.crm_region_name)) as region_key, min(rr.crm_region_id) as crm_region_id
        from public.ireports360_crm_region_brick_resolutions rr
       where nullif(btrim(rr.crm_region_name), '') is not null
       group by lower(btrim(rr.crm_region_name))
      having count(distinct rr.crm_region_id) = 1
    ) r
   where c.crm_region_id is null
     and lower(btrim(c.crm_region_name)) = r.region_key;
  get diagnostics v_regions_from_name = row_count;

  with resolved as (
    select c.contact_crm_id,
           case
             when cr.status = 'mapped' and cr.brick_id is not null then cr.brick_id
             when rr.status = 'mapped' and rr.brick_id is not null then rr.brick_id
           end as brick_id,
           case
             when cr.status = 'mapped' and cr.brick_id is not null then 'customer'
             when rr.status = 'mapped' and rr.brick_id is not null then 'region'
             else 'pending'
           end as brick_status
      from public.crm_contacts c
      left join public.ireports360_crm_customer_brick_resolutions cr on cr.crm_contact_id = c.contact_crm_id
      left join public.ireports360_crm_region_brick_resolutions rr on rr.crm_region_id = c.crm_region_id
  )
  update public.crm_contacts c
     set brick_id = r.brick_id,
         brick_status = r.brick_status,
         updated_at = now()
    from resolved r
   where r.contact_crm_id = c.contact_crm_id
     and (c.brick_id, c.brick_status) is distinct from (r.brick_id, r.brick_status);
  get diagnostics v_bricks = row_count;
  v_ms := v_ms || jsonb_build_object('bricks', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  if v_lists_live then

  -- THE FOUR ASSIGNMENT PASSES. Each one skips a rep whose own team has started in Phoenix CRM: his
  -- rows are FROZEN, neither closed nor re-opened, so his list stays exactly as it is while Phoenix
  -- owns the edits. Leaving the INSERT unguarded would be the whole bug — a doctor a manager removed
  -- would have no open row, so `not exists (...)` would be true and the vendor would re-open him.

  delete from public.crm_contact_assignments a
   where a.effective_to is null
     and a.effective_from >= v_today
     and a.source = 'ireports360'
     and not exists (
       select 1
         from public.ireports360_contacts m
        where m.contact_crm_id = a.contact_crm_id
          and m.agent_crm_id = a.agent_crm_id
          and m.list_type = a.list_type
          and (m.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(m.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
          and public.crm_contact_fold_grade(m.contact_grade) is not distinct from a.grade
     )
     and not exists (
       select 1
         from pg_temp.crm_refresh_started_reps s
        where (nullif(btrim(a.agent_hr_id), '') is not null and s.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and s.agent_crm_id = a.agent_crm_id)
     );
  get diagnostics v_discarded = row_count;

  update public.crm_contact_assignments a
     set effective_to = greatest(a.effective_from, least(a.last_seen_on, v_today - 1)),
         updated_at = now()
   where a.effective_to is null
     and a.source = 'ireports360'
     and not exists (
       select 1
         from public.ireports360_contacts m
        where m.contact_crm_id = a.contact_crm_id
          and m.agent_crm_id = a.agent_crm_id
          and m.list_type = a.list_type
          and (m.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(m.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
          and public.crm_contact_fold_grade(m.contact_grade) is not distinct from a.grade
     )
     and not exists (
       select 1
         from pg_temp.crm_refresh_started_reps s
        where (nullif(btrim(a.agent_hr_id), '') is not null and s.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and s.agent_crm_id = a.agent_crm_id)
     );
  get diagnostics v_closed = row_count;

  update public.crm_contact_assignments a
     set last_seen_on = greatest(a.last_seen_on, s.seen_on),
         agent_hr_id = coalesce(s.agent_hr_id, a.agent_hr_id),
         updated_at = now()
    from (
      select m.contact_crm_id, m.agent_crm_id, m.list_type, m.agent_hr_id,
             public.crm_contact_fold_grade(m.contact_grade) as grade,
             least((coalesce(m.synced_at, now()) at time zone 'Africa/Cairo')::date, v_today) as seen_on
        from public.ireports360_contacts m
       where m.contact_crm_id > 0
         and m.contact_crm_id <> 100000
    ) s
   where a.effective_to is null
     and a.source = 'ireports360'
     and s.contact_crm_id = a.contact_crm_id
     and s.agent_crm_id = a.agent_crm_id
     and s.list_type = a.list_type
     and (s.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(s.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
     and s.grade is not distinct from a.grade
     and (a.last_seen_on < s.seen_on or coalesce(s.agent_hr_id, a.agent_hr_id) is distinct from a.agent_hr_id)
     and not exists (
       select 1
         from pg_temp.crm_refresh_started_reps f
        where (nullif(btrim(a.agent_hr_id), '') is not null and f.hr_key = lower(btrim(a.agent_hr_id)))
           or (nullif(btrim(a.agent_hr_id), '') is null and a.agent_crm_id is not null
               and f.agent_crm_id = a.agent_crm_id)
     );
  get diagnostics v_touched = row_count;

  insert into public.crm_contact_assignments (
    contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on
  )
  select s.contact_crm_id, s.agent_crm_id, s.agent_hr_id, s.list_type, s.grade,
         s.starts_on,
         greatest(s.seen_on, s.starts_on)
    from (
      select m.contact_crm_id, m.agent_crm_id, m.agent_hr_id, m.list_type,
             public.crm_contact_fold_grade(m.contact_grade) as grade,
             least((coalesce(m.synced_at, now()) at time zone 'Africa/Cairo')::date, v_today) as seen_on,
             least(
               v_today,
               greatest(
                 coalesce((m.first_seen_at at time zone 'Africa/Cairo')::date, v_today),
                 coalesce(prev.last_to + 1, (m.first_seen_at at time zone 'Africa/Cairo')::date, v_today)
               )
             ) as starts_on
        from public.ireports360_contacts m
        left join lateral (
          select max(p.effective_to) as last_to
            from public.crm_contact_assignments p
           where p.contact_crm_id = m.contact_crm_id
             and p.agent_crm_id = m.agent_crm_id
             and p.list_type = m.list_type
             and p.effective_to is not null
        ) prev on true
       where m.contact_crm_id > 0
         and m.contact_crm_id <> 100000
         and not exists (
           select 1
             from public.crm_contact_assignments o
            where o.effective_to is null
              and o.contact_crm_id = m.contact_crm_id
              and o.agent_crm_id = m.agent_crm_id
              and o.list_type = m.list_type
         )
         and not exists (
           select 1
             from pg_temp.crm_refresh_started_reps f
            where (nullif(btrim(m.agent_hr_id), '') is not null and f.hr_key = lower(btrim(m.agent_hr_id)))
               or (nullif(btrim(m.agent_hr_id), '') is null and m.agent_crm_id is not null
                   and f.agent_crm_id = m.agent_crm_id)
         )
    ) s;
  get diagnostics v_opened = row_count;
  end if;
  v_ms := v_ms || jsonb_build_object('assignments', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);

  return jsonb_build_object(
    'includeActivity', p_include_activity,
    'listsLive', v_lists_live,
    'startedRepsFrozen', v_started_reps,
    'assignmentsFrozen', v_assignments_frozen,
    'listContactsChanged', v_list_contacts,
    'activityContactsAdded', v_activity_added,
    'activityContactsUpdated', v_activity_updated,
    'bricksChanged', v_bricks,
    'regionsFromName', v_regions_from_name,
    'assignmentsDiscarded', v_discarded,
    'assignmentsClosed', v_closed,
    'assignmentsTouched', v_touched,
    'assignmentsOpened', v_opened,
    'contactsTotal', (select count(*) from public.crm_contacts),
    'openAssignments', (select count(*) from public.crm_contact_assignments where effective_to is null),
    'ms', v_ms
  );
end;
$function$;

comment on function public.crm_contact_master_refresh(boolean) is
  'Rebuilds crm_contacts and crm_contact_assignments from the iReports360 scrape. Contact identity is '
  'global; the four assignment passes SKIP a rep whose own team has started in Phoenix CRM '
  '(phoenix_crm_started_team_reps), freezing his list so Phoenix owns its edits. Reports what it froze.';

comment on function public.crm_contact_list_change_apply(uuid, text, text) is
  'Applies one pending doctor-list change. Accepts it when the rep''s own team has started in Phoenix '
  'CRM, or when the global crm_cutover.cutover_date has passed. Before 2026-10-04 only the second path '
  'existed and the date was NULL, so every change was refused.';
