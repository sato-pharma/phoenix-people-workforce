-- Doctor lists maintained in Phoenix — CRM phase 7.
--
-- WHAT THIS IS. Until the CRM cutover date a rep's doctor lists are scraped from iReports360 into
-- crm_contact_assignments by crm_contact_master_refresh(). Once iReports360 stops, nobody could change a
-- list at all. The owner's rule (2026-09-14): "Rep asks, DM approves, SFE and system admin can edit,
-- add or delete."
--
-- WHAT IS HERE.
--   crm_contact_list_changes         one row per change to one rep's AM or PM list: add a doctor (one
--                                    already known, or a new one), remove one, or change a grade. A
--                                    rep's request goes to his nearest active manager, stored, and only
--                                    that person approves or refuses it. A change the SFE Manager or the
--                                    administrator makes is `direct`: it has no manager and is applied
--                                    at once, decided by the person who made it. A refusal says why.
--   crm_contact_list_change_events   append-only history.
--   crm_contact_list_change_apply()  applies one pending change to crm_contact_assignments in one
--                                    transaction. Service role only. Refuses before the cutover date:
--                                    before it the vendor scrape still owns every list and would
--                                    re-open a removed doctor the next morning.
--   crm_contact_assignments.source   'ireports360' for every row the scrape wrote, 'phoenix' for a row
--                                    a change wrote. A Phoenix row always carries the rep's HR id.
--   crm_contacts.source 'phoenix'    a doctor first added in Phoenix, numbered from 1,000,000,000 so
--                                    it can never collide with a CRM contact id (the CRM's ids are
--                                    under 110,000 on 2026-09-14, and the one integer-typed contact
--                                    id column, the customer brick mapping, holds up to 2,147,483,647).
--   crm_contact_master_refresh()     unchanged except: from the cutover date it no longer rebuilds
--                                    the list or assignment passes from the frozen vendor copy, and it
--                                    never closes, deletes or touches a Phoenix row on any day.
--
-- WHAT IT DOES NOT TOUCH. No visit, plan, KPI, deduction or pay table. Nothing writes an ireports360_*
-- table. No existing assignment changes today: every current row becomes source 'ireports360', and
-- while crm_cutover.cutover_date is null the refresh behaves exactly as before.
--
-- RLS on, nothing granted to anon or authenticated; every read and write goes through the service-role
-- client behind the app's own permission and scope checks.

begin;

-- ── 1. Assignments know who wrote them ────────────────────────────────────────────────────────────

alter table public.crm_contact_assignments
  add column if not exists source text not null default 'ireports360';

alter table public.crm_contact_assignments
  alter column agent_crm_id drop not null;

alter table public.crm_contact_assignments
  drop constraint if exists crm_contact_assignments_source;
alter table public.crm_contact_assignments
  add constraint crm_contact_assignments_source check (source in ('ireports360', 'phoenix'));

-- A vendor row is keyed on the CRM agent; a Phoenix row on the rep's HR id (a rep hired after the
-- cutover has no CRM id at all).
alter table public.crm_contact_assignments
  drop constraint if exists crm_contact_assignments_source_identity;
alter table public.crm_contact_assignments
  add constraint crm_contact_assignments_source_identity check (
    case source
      when 'ireports360' then agent_crm_id is not null
      when 'phoenix' then agent_hr_id is not null and btrim(agent_hr_id) <> ''
      else false
    end
  );

-- One OPEN Phoenix period per (contact, rep, list). The vendor index keeps covering rows with a CRM id.
create unique index if not exists crm_contact_assignments_phoenix_open_uidx
  on public.crm_contact_assignments (contact_crm_id, lower(btrim(agent_hr_id)), list_type)
  where effective_to is null and source = 'phoenix';

comment on column public.crm_contact_assignments.source is
  'ireports360 = written by crm_contact_master_refresh() from the vendor list; phoenix = written by crm_contact_list_change_apply().';

-- ── 2. Doctors first added in Phoenix ─────────────────────────────────────────────────────────────

alter table public.crm_contacts drop constraint if exists crm_contacts_source;
alter table public.crm_contacts
  add constraint crm_contacts_source check (source in ('list', 'visit', 'plan', 'phoenix'));

create sequence if not exists public.crm_contacts_phoenix_id_seq
  as bigint
  start with 1000000000
  minvalue 1000000000
  maxvalue 2000000000
  no cycle;

revoke all on sequence public.crm_contacts_phoenix_id_seq from anon, authenticated;

-- ── 3. The changes ────────────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_contact_list_changes (
  id uuid primary key default gen_random_uuid(),
  rep_hr_id text not null references public.employees (hr_id),
  action text not null,
  list_type text not null,
  contact_crm_id bigint references public.crm_contacts (contact_crm_id),
  new_contact_name text,
  new_contact_speciality text,
  new_contact_address text,
  grade text,
  reason text not null,
  requested_by text not null references public.employees (hr_id),
  manager_hr_id text references public.employees (hr_id),
  direct boolean not null default false,
  status text not null default 'pending',
  decided_by text references public.employees (hr_id),
  decided_at timestamptz,
  decision_note text,
  applied_at timestamptz,
  applied_contact_crm_id bigint,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_contact_list_changes_action check (action in ('add', 'remove', 'regrade')),
  -- A pharmacy is not a contact: AM and PM lists only.
  constraint crm_contact_list_changes_list_type check (list_type in ('AM', 'PM')),
  constraint crm_contact_list_changes_grade check (grade is null or grade in ('A', 'B', 'C')),
  constraint crm_contact_list_changes_reason check (btrim(reason) <> '' and char_length(reason) <= 1000),
  constraint crm_contact_list_changes_status check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  -- What each action carries. An add names a known doctor OR describes a new one, never both.
  constraint crm_contact_list_changes_shape check (
    case action
      when 'add' then grade is not null and (
        (contact_crm_id is not null and new_contact_name is null and new_contact_speciality is null
          and new_contact_address is null)
        or (contact_crm_id is null and new_contact_name is not null and btrim(new_contact_name) <> ''
          and char_length(new_contact_name) <= 200
          and new_contact_speciality is not null and btrim(new_contact_speciality) <> ''
          and (new_contact_address is null or char_length(new_contact_address) <= 500))
      )
      when 'remove' then contact_crm_id is not null and grade is null and new_contact_name is null
        and new_contact_speciality is null and new_contact_address is null
      when 'regrade' then contact_crm_id is not null and grade is not null and new_contact_name is null
        and new_contact_speciality is null and new_contact_address is null
      else false
    end
  ),
  -- A request is the rep's own and goes to a manager who is not the rep. A direct change has no manager.
  constraint crm_contact_list_changes_routing check (
    case when direct
      then manager_hr_id is null
      else manager_hr_id is not null and requested_by = rep_hr_id and manager_hr_id <> rep_hr_id
    end
  ),
  -- Only the stored manager decides a request; a direct change is decided by the person who made it and
  -- is never refused. A refusal says why. Only an approved change was applied.
  constraint crm_contact_list_changes_workflow check (
    case status
      when 'pending' then decided_by is null and decided_at is null and decision_note is null
        and applied_at is null and cancelled_at is null
      when 'approved' then decided_at is not null and applied_at is not null and cancelled_at is null
        and decided_by = case when direct then requested_by else manager_hr_id end
      when 'rejected' then not direct and decided_by = manager_hr_id and decided_at is not null
        and decision_note is not null and btrim(decision_note) <> '' and applied_at is null and cancelled_at is null
      when 'cancelled' then cancelled_at is not null and decided_by is null and applied_at is null
      else false
    end
  )
);

comment on table public.crm_contact_list_changes is
  'A change to one rep''s AM or PM doctor list (CRM phase 7): the rep asks and his stored manager decides, or the SFE Manager or administrator applies it directly. Applied only by crm_contact_list_change_apply(), from the CRM cutover date. Never decided by the system.';

-- One waiting change per rep, doctor and list.
create unique index if not exists crm_contact_list_changes_one_pending
  on public.crm_contact_list_changes (rep_hr_id, contact_crm_id, list_type)
  where status = 'pending' and contact_crm_id is not null;

create index if not exists crm_contact_list_changes_manager_idx
  on public.crm_contact_list_changes (manager_hr_id, status);

create index if not exists crm_contact_list_changes_rep_idx
  on public.crm_contact_list_changes (rep_hr_id, created_at);

create table if not exists public.crm_contact_list_change_events (
  id bigint generated always as identity primary key,
  change_id uuid not null references public.crm_contact_list_changes (id) on delete restrict,
  event text not null,
  actor_hr_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_contact_list_change_events_event check (
    event in ('requested', 'approved', 'rejected', 'cancelled', 'applied_directly')
  )
);

comment on table public.crm_contact_list_change_events is
  'Append-only history of every doctor-list change: requested, approved, rejected, cancelled, applied directly.';

create index if not exists crm_contact_list_change_events_change_idx
  on public.crm_contact_list_change_events (change_id, created_at);

alter table public.crm_contact_list_changes enable row level security;
alter table public.crm_contact_list_change_events enable row level security;

revoke all on table public.crm_contact_list_changes from anon, authenticated;
revoke all on table public.crm_contact_list_change_events from anon, authenticated;
revoke all on sequence public.crm_contact_list_change_events_id_seq from anon, authenticated;

-- ── 4. Applying one change ────────────────────────────────────────────────────────────────────────

create or replace function public.crm_contact_list_change_apply(p_change_id uuid, p_decided_by text, p_note text default null)
  returns jsonb
  language plpgsql
  set search_path to 'public'
as $$
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
begin
  select * into v_change from public.crm_contact_list_changes where id = p_change_id for update;
  if not found then
    raise exception 'That change was not found.' using errcode = 'P0001';
  end if;
  if v_change.status <> 'pending' then
    raise exception 'This change has already been decided or withdrawn.' using errcode = 'P0001';
  end if;
  if v_cutover is null or v_today < v_cutover then
    raise exception 'Doctor lists still come from iReports360 until the CRM cutover date.' using errcode = 'P0001';
  end if;
  if p_decided_by is distinct from (case when v_change.direct then v_change.requested_by else v_change.manager_hr_id end) then
    raise exception 'Only the manager this change was sent to can approve it.' using errcode = 'P0001';
  end if;

  select case when e.crm_id ~ '^[0-9]+$' then e.crm_id::bigint end
    into v_rep_crm_id
    from public.employees e
   where e.hr_id = v_change.rep_hr_id;

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

    -- The rep's CRM id rides along where it is free, so a reader keyed on it still finds the row. A
    -- CRM slot still open under somebody else is left alone, and the row is keyed on the HR id only.
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

    -- A period that began today never held a whole day, so it is discarded rather than closed. Every
    -- other open period ends yesterday: the doctor is not on the list today. Closed history is never
    -- deleted.
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
$$;

comment on function public.crm_contact_list_change_apply(uuid, text, text) is
  'Applies one pending doctor-list change to crm_contact_assignments and marks it approved, in one transaction. The caller passes the decider, who must be the stored manager (or, for a direct change, the person who made it). Refuses before the CRM cutover date.';

revoke execute on function public.crm_contact_list_change_apply(uuid, text, text) from public, anon, authenticated;
grant execute on function public.crm_contact_list_change_apply(uuid, text, text) to service_role;

-- ── 5. The refresh stops owning the lists at the cutover ──────────────────────────────────────────
-- Byte-identical to 20260914000000_crm_unify_vendor_reads.sql except for v_lists_live, the two
-- `if v_lists_live then` blocks, and `a.source = 'ireports360'` on the three statements that change an
-- existing period. Step 4c's own not-exists check already looks at every open row whatever its source.

create or replace function public.crm_contact_master_refresh(p_include_activity boolean default false)
  returns jsonb
  language plpgsql
  set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  -- From the CRM cutover date Phoenix owns the lists (crm_contact_list_changes) and the vendor copy is
  -- frozen: rebuilding from it would re-open every doctor a manager removed.
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
  -- Milliseconds per step, returned with the counts. PostgREST cuts a request at 8 s on production,
  -- so the cron's audit row has to be able to say which step is growing before it reaches that.
  v_step timestamptz := clock_timestamp();
  v_ms jsonb := '{}'::jsonb;
begin
  -- Two overlapping cron ticks must not interleave a close with an open.
  perform pg_advisory_xact_lock(hashtext('public.crm_contact_master_refresh'));

  -- 1. Every contact on a list today. The list is the best description Phoenix has of a contact,
  --    so it wins over activity for as long as the contact is on one.
  if v_lists_live then
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

    -- A contact on no list today describes itself through its latest activity. A doctor added in
    -- Phoenix keeps the description the change gave it.
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
       and c.source <> 'phoenix'
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
  --    whole mirror against the open periods is correct whichever slice just ran. Only vendor periods
  --    are compared: a Phoenix period is never in the mirror, and only a list change may end it.
  if v_lists_live then

  -- 4a. Close every open period the list no longer states. It ends on the last day it was seen, and
  --     never on today: a period closed today was not on the list today.
  -- A period that OPENED TODAY and no longer matches never held a whole day. Closing it would have to
  -- end it today (a period cannot end before it starts), and the period that replaces it also starts
  -- today, so a same-day re-run after a CRM change would leave two periods covering one date. It is
  -- discarded instead. Only an OPEN period that began today is ever deleted; closed history never is.
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
     );
  get diagnostics v_discarded = row_count;

  -- A rep's HR id RESOLVING (null to a real id) or going unresolved is not a handover: only two
  -- different real ids are. Otherwise the day the identity lookup first answers, every period on
  -- that rep's lists would close and reopen, recording a handover that never happened.
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
     and a.source = 'ireports360'
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
  end if;
  v_ms := v_ms || jsonb_build_object('assignments', round(extract(epoch from clock_timestamp() - v_step) * 1000)::int);

  return jsonb_build_object(
    'includeActivity', p_include_activity,
    'listsLive', v_lists_live,
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
  'Rebuilds crm_contacts and crm_contact_assignments. Before the CRM cutover date lists come from the read-only ireports360_contacts mirror; from it Phoenix owns the lists and the list passes stand down. Never changes a Phoenix period. The activity pass reads crm_visits_unified and crm_plan_entries_unified. Idempotent.';

revoke execute on function public.crm_contact_master_refresh(boolean) from public, anon, authenticated;
grant execute on function public.crm_contact_master_refresh(boolean) to service_role;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK. Safe only while no change has been applied (check `select count(*) from
-- public.crm_contact_list_changes` and `select count(*) from public.crm_contact_assignments where
-- source = 'phoenix'` first — production has no PITR). Re-apply the refresh body from
-- 20260914000000_crm_unify_vendor_reads.sql, then:
--   begin;
--   drop function if exists public.crm_contact_list_change_apply(uuid, text, text);
--   drop table if exists public.crm_contact_list_change_events;
--   drop table if exists public.crm_contact_list_changes;
--   drop sequence if exists public.crm_contacts_phoenix_id_seq;
--   alter table public.crm_contacts drop constraint if exists crm_contacts_source;
--   alter table public.crm_contacts add constraint crm_contacts_source check (source in ('list', 'visit', 'plan'));
--   drop index if exists public.crm_contact_assignments_phoenix_open_uidx;
--   alter table public.crm_contact_assignments drop constraint if exists crm_contact_assignments_source_identity;
--   alter table public.crm_contact_assignments drop constraint if exists crm_contact_assignments_source;
--   alter table public.crm_contact_assignments drop column if exists source;
--   alter table public.crm_contact_assignments alter column agent_crm_id set not null;
--   notify pgrst, 'reload schema';
--   commit;
