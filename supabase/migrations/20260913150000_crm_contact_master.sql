-- The CRM contact master — Phoenix's own record of every CRM contact, and a DATED record of whose
-- list each one is on.
--
-- WHY. Phoenix learns about contacts from three vendor mirrors, and none of them is a registry:
--   · ireports360_contacts is each rep's list AS IT STANDS TODAY. It is authoritative by
--     replacement — a doctor removed from a list simply vanishes, with no trace that he was ever
--     on it or since when. Measured 2026-09-13: 9,757 rows, 70 agents.
--   · ireports360_visits knows 14,981 contacts ever visited, 6,929 of them on nobody's list today.
--   · ireports360_plan_entries adds 2,241 contacts that were planned but never visited or listed.
-- Native visits and native rep plans (the next two phases) both need ONE contact id that outlives a
-- list change, and a list history that says who held a doctor on a given date. This is that record.
--
-- WHAT IS HERE.
--   crm_contacts            one row per CRM contact, keyed on the CRM's own contact id (kept as
--                           the legacy id everywhere — direct_order_pharmacies.crm_contact_id and
--                           employees.crm_id are unchanged). Descriptive fields come from the list
--                           while the contact is on one, else from the latest visit, else the
--                           latest plan (`source` says which). A brick from the customer mapping,
--                           else the region mapping of the contact's latest visit, else `pending` —
--                           the same order master.ts applies to a visit, so a contact and its visits
--                           never disagree about where it is.
--   crm_contact_assignments one row per (contact, agent, list, rep, grade) PERIOD. An open row
--                           (effective_to is null) is on a list today; a closed row is history. A
--                           grade change, or the slot passing to another person, closes one period
--                           and opens the next. A+ is folded into A (audit §11.3).
--
-- WHAT IS DELIBERATELY NOT HERE.
--   · No `kind` column. Whether a speciality is a doctor, a pharmacy or an account is decided by
--     src/lib/crm/contact-taxonomy.ts and nowhere else; a SQL copy of that list is the second
--     authority it exists to prevent. Readers classify `speciality` at read time.
--   · Contact 100000 is the CRM's catch-all, not a doctor. It is refused by a check constraint.
--   · No assignment is inferred from visits. 947 contacts were visited by two or more agents; a
--     visit is not a list.
--
-- HISTORY STARTS AT THE MIRROR'S FIRST SWEEP (2026-08-28). A seeded assignment's effective_from is
-- the day the mirror first saw that row, which is the earliest date Phoenix can honestly assert.
--
-- THE MIRROR STAYS READ-ONLY (owner decision 19). Nothing here writes to an ireports360_* table.
-- public.crm_contact_master_refresh() is called by the contact-list cron after every slice, and
-- this migration calls it once to seed.
--
-- PURELY ADDITIVE, and the app tolerates its absence: until this is applied the direct-order venue
-- picker keeps reading ireports360_contacts, and the cron records the refresh as not provisioned.

begin;

create table if not exists public.crm_contacts (
  contact_crm_id bigint primary key,
  name text,
  name_ar text,
  speciality text,
  phone text,
  address text,
  city text,
  zone text,
  crm_region_id bigint,
  crm_region_name text,
  brick_id text,
  brick_status text not null default 'pending',
  source text not null,
  first_seen_on date not null,
  last_visited_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contacts_real_contact check (contact_crm_id > 0 and contact_crm_id <> 100000),
  constraint crm_contacts_brick_status check (brick_status in ('customer', 'region', 'pending')),
  constraint crm_contacts_brick_matches_status check ((brick_id is not null) = (brick_status in ('customer', 'region'))),
  constraint crm_contacts_source check (source in ('list', 'visit', 'plan'))
);

comment on table public.crm_contacts is
  'Phoenix contact master: one row per CRM contact, keyed on the CRM contact id. Rebuilt from the read-only ireports360 mirrors by crm_contact_master_refresh(); never edit by hand. Speciality kind is classified in src/lib/crm/contact-taxonomy.ts, not here.';

create index if not exists crm_contacts_brick_idx on public.crm_contacts (brick_id) where brick_id is not null;

create table if not exists public.crm_contact_assignments (
  id bigint generated always as identity primary key,
  contact_crm_id bigint not null references public.crm_contacts (contact_crm_id),
  agent_crm_id bigint not null,
  agent_hr_id text,
  list_type text not null,
  grade text,
  effective_from date not null,
  effective_to date,
  last_seen_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contact_assignments_list_type check (list_type in ('PM', 'AM', 'Pharmacy')),
  constraint crm_contact_assignments_period check (effective_to is null or effective_to >= effective_from)
);

comment on table public.crm_contact_assignments is
  'Dated contact-list membership: one row per (contact, agent, list, rep, grade) period. effective_to is null while the contact is on that list today. Written only by crm_contact_master_refresh(); never delete a closed row, it is the only list history Phoenix has.';

-- One OPEN period per (contact, agent, list). The refresh closes before it opens, so a grade change
-- or a slot handover never collides with itself.
create unique index if not exists crm_contact_assignments_open_uidx
  on public.crm_contact_assignments (contact_crm_id, agent_crm_id, list_type)
  where effective_to is null;

create index if not exists crm_contact_assignments_open_agent_hr_idx
  on public.crm_contact_assignments (agent_hr_id)
  where effective_to is null;

create index if not exists crm_contact_assignments_contact_idx
  on public.crm_contact_assignments (contact_crm_id, effective_from);

-- RLS on with no policies and no grants to anon or authenticated, like the rest of the CRM mirror.
-- Every read goes through the service-role client behind the app's own scope checks.
alter table public.crm_contacts enable row level security;
alter table public.crm_contact_assignments enable row level security;
revoke all on table public.crm_contacts from anon, authenticated;
revoke all on table public.crm_contact_assignments from anon, authenticated;
revoke all on sequence public.crm_contact_assignments_id_seq from anon, authenticated;

-- A+ is folded into A (audit §11.3). One definition, used by every statement below.
create or replace function public.crm_contact_fold_grade(p_grade text)
  returns text
  language sql
  immutable
  set search_path to 'public'
as $$
  select case
    when upper(btrim(p_grade)) = 'A+' then 'A'
    else nullif(upper(btrim(p_grade)), '')
  end
$$;

create or replace function public.crm_contact_master_refresh(p_include_activity boolean default false)
  returns jsonb
  language plpgsql
  set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_list_contacts integer := 0;
  v_activity_added integer := 0;
  v_activity_updated integer := 0;
  v_bricks integer := 0;
  v_closed integer := 0;
  v_touched integer := 0;
  v_opened integer := 0;
  v_discarded integer := 0;
  v_regions_from_name integer := 0;
  -- Milliseconds per step, returned with the counts. PostgREST cuts a request at 8 s on production,
  -- so the cron's audit row has to be able to say which step is growing before it reaches that.
  v_step timestamptz := clock_timestamp();
  v_ms jsonb := '{}'::jsonb;
begin
  -- Two overlapping cron ticks must not interleave a close with an open.
  perform pg_advisory_xact_lock(hashtext('public.crm_contact_master_refresh'));

  -- 1. Every contact on a list today. The list is the best description Phoenix has of a contact,
  --    so it wins over activity for as long as the contact is on one.
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
  v_ms := v_ms || jsonb_build_object('list', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);
  v_step := clock_timestamp();

  -- 2. Contacts known from activity. A full pass over visits and plans (~2.5 s on production,
  --    2026-09-13), so the cron asks for it once per daily sweep rather than on every slice.
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
        from public.ireports360_visits v
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
        from public.ireports360_plan_entries p
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

    -- A temp table has no statistics until it is analysed. Cheap insurance for the joins below; on
    -- staging it made no measurable difference (about 1 s either way).
    analyze pg_temp.crm_contact_master_activity;

    insert into public.crm_contacts (
      contact_crm_id, name, speciality, crm_region_id, crm_region_name, source, first_seen_on, last_visited_on
    )
    select a.contact_crm_id, a.name, a.speciality, a.crm_region_id, a.crm_region_name, a.source,
           a.first_seen_on, a.last_visited_on
      from pg_temp.crm_contact_master_activity a
    on conflict (contact_crm_id) do nothing;
    get diagnostics v_activity_added = row_count;

    -- A contact on no list today describes itself through its latest activity.
    update public.crm_contacts c
       set name = coalesce(a.name, c.name),
           speciality = coalesce(a.speciality, c.speciality),
           crm_region_name = coalesce(a.crm_region_name, c.crm_region_name),
           source = a.source,
           updated_at = now()
      from pg_temp.crm_contact_master_activity a
      -- An anti-join against the set of listed ids, not a correlated NOT EXISTS: the mirror's key
      -- leads with agent_crm_id, so a lookup on contact_crm_id alone has no index to use.
      left join (select distinct l.contact_crm_id from public.ireports360_contacts l) listed
        on listed.contact_crm_id = a.contact_crm_id
     where a.contact_crm_id = c.contact_crm_id
       and listed.contact_crm_id is null
       and (c.name, c.speciality, c.crm_region_name, c.source)
             is distinct from
           (coalesce(a.name, c.name), coalesce(a.speciality, c.speciality),
            coalesce(a.crm_region_name, c.crm_region_name), a.source);
    get diagnostics v_activity_updated = row_count;

    -- Every contact: the region id (the list carries only a region NAME) and the visit span.
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

  -- Neither a list row nor a plan row carries a region id, only a region NAME, and the region brick
  -- mapping is keyed on the id. Without this a contact no visit gave a region id stays brick-pending
  -- for good (1,704 listed-but-never-visited doctors on production on 2026-09-13). The id comes from
  -- the region mapping table's own name, and only where that name belongs to exactly one region.
  -- It runs AFTER the activity pass: a visit's region id wins, and the contacts that pass adds are
  -- filled in the same run rather than the next day's (staging, filled before the pass: the second
  -- run moved 771 bricks).
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

  -- 3. Bricks. The customer mapping, else the region mapping, else pending — master.ts's order.
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

  -- 4. Assignments. The mirror is complete for every agent at every tick (a slice replaces only its
  --    own agents, and an agent whose lists come back empty keeps yesterday's rows), so comparing the
  --    whole mirror against the open periods is correct whichever slice just ran.

  -- 4a. Close every open period the list no longer states. It ends on the last day it was seen, and
  --     never on today: a period closed today was not on the list today.
  -- A period that OPENED TODAY and no longer matches never held a whole day. Closing it would have to
  -- end it today (a period cannot end before it starts), and the period that replaces it also starts
  -- today, so a same-day re-run after a CRM change would leave two periods covering one date. It is
  -- discarded instead. Only an OPEN period that began today is ever deleted; closed history never is.
  delete from public.crm_contact_assignments a
   where a.effective_to is null
     and a.effective_from >= v_today
     and not exists (
       select 1
         from public.ireports360_contacts m
        where m.contact_crm_id = a.contact_crm_id
          and m.agent_crm_id = a.agent_crm_id
          and m.list_type = a.list_type
          and (m.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(m.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
          and public.crm_contact_fold_grade(m.contact_grade) is not distinct from a.grade
     );
  get diagnostics v_discarded = row_count;

  -- A rep's HR id RESOLVING (null to a real id) or going unresolved is not a handover: only two
  -- different real ids are. Otherwise the day the identity lookup first answers, every period on
  -- that rep's lists would close and reopen, recording a handover that never happened.
  update public.crm_contact_assignments a
     set effective_to = greatest(a.effective_from, least(a.last_seen_on, v_today - 1)),
         updated_at = now()
   where a.effective_to is null
     and not exists (
       select 1
         from public.ireports360_contacts m
        where m.contact_crm_id = a.contact_crm_id
          and m.agent_crm_id = a.agent_crm_id
          and m.list_type = a.list_type
          and (m.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(m.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
          and public.crm_contact_fold_grade(m.contact_grade) is not distinct from a.grade
     );
  get diagnostics v_closed = row_count;

  -- 4b. Still on the list: move last_seen_on forward (and take the hr id's current spelling).
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
     and s.contact_crm_id = a.contact_crm_id
     and s.agent_crm_id = a.agent_crm_id
     and s.list_type = a.list_type
     and (s.agent_hr_id is null or a.agent_hr_id is null or lower(btrim(s.agent_hr_id)) = lower(btrim(a.agent_hr_id)))
     and s.grade is not distinct from a.grade
     and (a.last_seen_on < s.seen_on or coalesce(s.agent_hr_id, a.agent_hr_id) is distinct from a.agent_hr_id);
  get diagnostics v_touched = row_count;

  -- 4c. Open a period for every list row with none open. It starts the day the mirror first saw the
  --     row, but never before the day after the previous period on the same (contact, agent, list)
  --     ended — a grade change or a slot handover keeps the old row's first_seen_at.
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
    ) s;
  get diagnostics v_opened = row_count;
  v_ms := v_ms || jsonb_build_object('assignments', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);

  return jsonb_build_object(
    'includeActivity', p_include_activity,
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
$$;

comment on function public.crm_contact_master_refresh(boolean) is
  'Rebuilds crm_contacts and crm_contact_assignments from the read-only ireports360 mirrors. Called by the crm-contact-lists cron after every slice; p_include_activity adds the visit/plan pass once per daily sweep. Idempotent.';

-- The service_role grant comes AFTER the revokes: revoking from PUBLIC on a default ACL strips
-- service_role too, and the RPC would then fail in production only.
revoke execute on function public.crm_contact_fold_grade(text) from public, anon, authenticated;
grant execute on function public.crm_contact_fold_grade(text) to service_role;
revoke execute on function public.crm_contact_master_refresh(boolean) from public, anon, authenticated;
grant execute on function public.crm_contact_master_refresh(boolean) to service_role;

-- Seed.
do $$
begin
  perform public.crm_contact_master_refresh(true);
end
$$;

-- Statistics now, not whenever autovacuum gets to it: until then the planner sizes both freshly
-- seeded tables from guesses.
analyze public.crm_contacts;
analyze public.crm_contact_assignments;

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- The app falls back to ireports360_contacts on its own once these are gone. Dropping them DISCARDS
-- the dated list history recorded since this was applied — the mirror cannot rebuild it, because
-- the mirror forgets a removed contact. Export crm_contact_assignments first.
--
-- begin;
--   drop function if exists public.crm_contact_master_refresh(boolean);
--   drop function if exists public.crm_contact_fold_grade(text);
--   drop table if exists public.crm_contact_assignments;
--   drop table if exists public.crm_contacts;
-- commit;
