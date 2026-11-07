-- phoenix_crm_old_visits_convert_and_archive
--
-- WHAT THIS CHANGES (schema and functions; it writes no row — the runner does, dry run first):
--   1. phoenix_crm_visits gains four columns, all empty on every row today:
--        ireports360_checkin_id   the old check-in a copied visit was converted with;
--        ireports360_kpi_counted  a copied visit converted AND measured ok against a validated place — the only
--                                 copied visit that ever counts (kept true/false by a trigger, never by hand);
--        archived_at, archive_reason ('campaign' | 'no_checkin_location' | 'far') — a copied visit that is not
--                                 a visit, or a converted one whose check-in lay far from the validated place.
--   2. public.phoenix_crm_ireports360_checkin_matches — the ONE answer to "did this old regular visit have a
--      check-in location": its agent and contact checked in that day (the vendor's wall-clock day, the doors'
--      own `(check_date at time zone 'UTC')::date`), inside Egypt's box. Frozen data, filled once by (4).
--   3. public.phoenix_crm_visit_archive — the visits archive: one row per retired iReports360 visit — every
--      campaign visit, and every regular visit with no check-in location — copied or not; and, kept by a
--      trigger, every converted visit whose check-in lay more than visit_far_meters from the customer's
--      validated place ('far', with the distance). Service role only.
--   4. phoenix_crm_prepare_ireports360_conversion(p_apply) — fills (2) and (3) and archives the copied rows.
--      Dry run by default: it returns the counts and writes nothing.
--   5. phoenix_crm_ireports360_conversion_page / phoenix_crm_apply_ireports360_conversion — the runner reads a
--      page of copied visits with their check-in and the customer's active places, measures them with geo.ts
--      (checkVisitLocation, the one distance rule) and writes lat/lon, place, distance and flag back.
--   6. phoenix_crm_import_ireports360_history gains p_leavers (a person on no current territory keeps the
--      visits he made on the territory he held that day), and EVERY mode now copies only a regular visit with
--      a check-in location: a campaign visit, or a visit with none, is never added again.
--   7. Both countable views append the three new columns; the history view skips an archived visit. The
--      countable view still skips every copied visit — admitting the converted ones is the doors' migration,
--      applied only after the runner, so nothing is ever served twice in between.
--
-- WHY (owner, 7 Nov 2026): convert every old-CRM regular visit into a Phoenix CRM visit, as if submitted on
--   Phoenix — planned, its check-in as its location, measured against the customer's validated place today.
--   "No visits with no location"; campaign visits are retired; both go to an explicit visits archive and count
--   nowhere. A visit to a customer with no validated place is shown, never counted. Leavers are converted too.
--   Money never moves: work evidence and trip evidence keep skipping every copied row.
--   FAR (owner, 7 Nov 2026, the same day): a converted visit whose check-in lay more than visit_far_meters
--   (300 m) from the validated place is archived too, as 'far', with its distance — on the conversion AND on
--   any later restamp (a 'no_place' visit whose customer is validated later and lands far is archived at that
--   moment). Precedence: campaign > no_checkin_location > far. Live Phoenix visits are never touched.
--
-- ROLLBACK: nothing here deletes or rewrites a row. To undo the schema:
--     re-run the 20261107001714 importer statement after
--       drop function public.phoenix_crm_import_ireports360_history(text, boolean, boolean, boolean);
--     re-create the two views of 20261031160000 — a view cannot lose a column, so keep
--       these three columns and remove only the history view's archived filter;
--     drop function public.phoenix_crm_prepare_ireports360_conversion(boolean);
--     drop function public.phoenix_crm_ireports360_conversion_page(uuid, integer);
--     drop function public.phoenix_crm_apply_ireports360_conversion(jsonb);
--     drop trigger phoenix_crm_visits_old_system_far_archive on public.phoenix_crm_visits;
--     drop function public.phoenix_crm_visits_old_system_far_archive();
--     drop trigger phoenix_crm_visits_old_system_kpi on public.phoenix_crm_visits;
--     drop function public.phoenix_crm_visits_old_system_kpi();
--   and, ONLY once the owner agrees the archive's rows may go (they are copies of iReports360 rows, which stay):
--     drop table public.phoenix_crm_visit_archive; drop table public.phoenix_crm_ireports360_checkin_matches;
--   The runner's own writes are undone by its record (docs/phoenix-crm-ireports360-history-import.md,
--   "The conversion").
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — the functions' own scratch tables.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- 1. The marks on a copied visit -------------------------------------------------------------------------

alter table public.phoenix_crm_visits
  add column if not exists ireports360_checkin_id bigint,
  add column if not exists ireports360_kpi_counted boolean not null default false,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text;

alter table public.phoenix_crm_visits
  add constraint phoenix_crm_visits_archive_reason check (
    (archive_reason is null or archive_reason in ('campaign', 'no_checkin_location', 'far'))
    and ((archived_at is null) = (archive_reason is null))
  ),
  -- Only a copied visit is ever converted, counted as converted, or archived.
  add constraint phoenix_crm_visits_old_system_marks check (
    imported_from_ireports360_at is not null
    or (ireports360_checkin_id is null and not ireports360_kpi_counted and archived_at is null)
  ),
  add constraint phoenix_crm_visits_old_system_kpi check (
    not ireports360_kpi_counted or (ireports360_checkin_id is not null and archived_at is null and lat is not null)
  );

comment on column public.phoenix_crm_visits.ireports360_checkin_id is
  'A copied iReports360 visit converted into a Phoenix visit: the old check-in (crm_checkin_id) whose position is its lat/lon (owner, 2026-11-07).';
comment on column public.phoenix_crm_visits.ireports360_kpi_counted is
  'A copied visit that counts in visits and KPIs: converted with a check-in AND measured ok (or weak GPS) against a validated place, and not archived. Set by the trigger phoenix_crm_visits_old_system_kpi only.';
comment on column public.phoenix_crm_visits.archived_at is
  'A copied visit that is not a visit (a campaign visit, or no check-in location), or a converted one whose check-in lay more than visit_far_meters from the validated place (far, kept by the trigger phoenix_crm_visits_old_system_kpi). Owner, 2026-11-07. Never deleted, counted nowhere, shown on no visit screen. Its old visits are in phoenix_crm_visit_archive.';

-- 🔴 ONE RULE FOR "THIS COPIED VISIT COUNTS", KEPT BY THE ROW ITSELF. A copied visit counts once it carries
-- its check-in and a place it was measured against, lands ok (or weak GPS), and is not archived. Whoever
-- writes the place — the conversion runner, or the restamp a later validation runs (visit-locations.ts) — the
-- flag follows, so a customer validated next month brings his converted visits into the count with no second
-- step.
-- 🔴 AND A CONVERTED VISIT THAT LANDS FAR IS ARCHIVED, BY THE SAME ROW (owner, 7 Nov 2026): flag 'far'
-- against a validated place marks it archived 'far', unless it is already archived for another reason
-- (campaign > no_checkin_location > far). The 'far' mark is this trigger's alone: a later measurement that is
-- no longer far lifts it again, and the row counts as above. Its archive rows follow in
-- phoenix_crm_visits_old_system_far_archive (AFTER UPDATE, below the archive table).
create or replace function public.phoenix_crm_visits_old_system_kpi()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  v_far boolean := new.imported_from_ireports360_at is not null
    and new.ireports360_checkin_id is not null
    and new.place_id is not null
    and new.location_flag = 'far';
begin
  if v_far and new.archived_at is null then
    new.archived_at := now();
    new.archive_reason := 'far';
  elsif not v_far and new.archive_reason = 'far' then
    new.archived_at := null;
    new.archive_reason := null;
  end if;

  new.ireports360_kpi_counted := new.imported_from_ireports360_at is not null
    and new.archived_at is null
    and new.ireports360_checkin_id is not null
    and new.lat is not null
    and new.place_id is not null
    and new.location_flag in ('ok', 'weak_gps');
  return new;
end;
$function$;

revoke execute on function public.phoenix_crm_visits_old_system_kpi() from public, anon, authenticated;

drop trigger if exists phoenix_crm_visits_old_system_kpi on public.phoenix_crm_visits;
create trigger phoenix_crm_visits_old_system_kpi
  before insert or update on public.phoenix_crm_visits
  for each row
  when (new.imported_from_ireports360_at is not null or new.ireports360_kpi_counted)
  execute function public.phoenix_crm_visits_old_system_kpi();

-- 2. Which old regular visit had a check-in location ------------------------------------------------------

create table if not exists public.phoenix_crm_ireports360_checkin_matches (
  crm_visit_id bigint primary key,
  crm_checkin_id bigint not null,
  lat double precision not null,
  lon double precision not null,
  check_date timestamptz not null,
  matched_at timestamptz not null default now(),
  constraint phoenix_crm_ireports360_checkin_matches_box check (lat between 21.5 and 32 and lon between 24 and 37.5)
);
create index if not exists phoenix_crm_ireports360_checkin_matches_checkin_idx
  on public.phoenix_crm_ireports360_checkin_matches (crm_checkin_id);

comment on table public.phoenix_crm_ireports360_checkin_matches is
  'Each iReports360 regular visit that had a check-in location: the agent checked in at that contact on the visit''s day (the vendor wall clock), inside Egypt''s box; the check-in nearest the visit''s own time. The one answer the conversion, the importer and the archive read (owner, 2026-11-07).';

alter table public.phoenix_crm_ireports360_checkin_matches enable row level security;
revoke all on table public.phoenix_crm_ireports360_checkin_matches from public, anon, authenticated;
grant select, insert, update, delete on table public.phoenix_crm_ireports360_checkin_matches to service_role;

-- 3. The visits archive -------------------------------------------------------------------------------------

create table if not exists public.phoenix_crm_visit_archive (
  crm_visit_id bigint primary key,
  visit_date date not null,
  agent_crm_id bigint,
  agent_hr_id text,
  agent_name text,
  contact_crm_id bigint,
  customer_name text,
  visit_type integer not null,
  reason text not null,
  visit_id uuid references public.phoenix_crm_visits (id) on delete set null,
  seat_id text,
  line_code text,
  archived_at timestamptz not null default now(),
  -- A far visit only: how far its check-in lay from the validated place, and the two points, as measured.
  distance_meters integer,
  checkin_lat double precision,
  checkin_lon double precision,
  place_id uuid,
  place_lat double precision,
  place_lon double precision,
  constraint phoenix_crm_visit_archive_reason check (reason in ('campaign', 'no_checkin_location', 'far')),
  constraint phoenix_crm_visit_archive_type check (visit_type in (0, -8)),
  -- A campaign visit is archived as a campaign visit whatever else is true of it.
  constraint phoenix_crm_visit_archive_campaign_wins check ((visit_type = -8) = (reason = 'campaign')),
  -- A far visit always carries its distance; no other reason does.
  constraint phoenix_crm_visit_archive_far_measured check ((reason = 'far') = (distance_meters is not null))
);
create index if not exists phoenix_crm_visit_archive_date_idx
  on public.phoenix_crm_visit_archive (visit_date desc, crm_visit_id desc);
create index if not exists phoenix_crm_visit_archive_reason_date_idx
  on public.phoenix_crm_visit_archive (reason, visit_date desc, crm_visit_id desc);
create index if not exists phoenix_crm_visit_archive_agent_date_idx
  on public.phoenix_crm_visit_archive (lower(agent_hr_id), visit_date desc);
create index if not exists phoenix_crm_visit_archive_visit_idx
  on public.phoenix_crm_visit_archive (visit_id) where visit_id is not null;

comment on table public.phoenix_crm_visit_archive is
  'The visits archive (owner, 2026-11-07): every retired iReports360 visit — each campaign visit, and each regular visit with no check-in location — copied into Phoenix or not. Counted in no visit figure and no KPI; read by the admin Visits archive screen only.';

alter table public.phoenix_crm_visit_archive enable row level security;
revoke all on table public.phoenix_crm_visit_archive from public, anon, authenticated;
grant select, insert, update, delete on table public.phoenix_crm_visit_archive to service_role;

comment on column public.phoenix_crm_visit_archive.distance_meters is
  'A far visit (reason far): metres from its check-in to the validated place it was measured against, more than visit_far_meters. Null for every other reason.';

-- The far rows of the archive, kept by the visit row (owner, 7 Nov 2026). When a converted copied visit is
-- archived 'far' (the BEFORE trigger in section 1), each of its regular old visits that had a check-in
-- location gets an archive row 'far' with the distance and the two points; a later far measurement refreshes
-- them. When the mark is lifted (a restamp no longer far), its far rows go — they are this trigger's own
-- copies, and the archive answers what is archived NOW. An old visit already archived for another reason
-- keeps it (campaign > no_checkin_location > far).
create or replace function public.phoenix_crm_visits_old_system_far_archive()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.archive_reason is distinct from 'far' then
    delete from public.phoenix_crm_visit_archive a where a.visit_id = new.id and a.reason = 'far';
    return null;
  end if;

  insert into public.phoenix_crm_visit_archive (
    crm_visit_id, visit_date, agent_crm_id, agent_hr_id, agent_name, contact_crm_id, customer_name,
    visit_type, reason, visit_id, seat_id, line_code, archived_at,
    distance_meters, checkin_lat, checkin_lon, place_id, place_lat, place_lon
  )
  select iv.crm_visit_id, iv.visit_date, iv.agent_crm_id, nullif(btrim(iv.agent_hr_id), ''),
         nullif(btrim(iv.agent_name), ''), nullif(iv.contact_crm_id, 0), left(nullif(btrim(iv.contact_name), ''), 200),
         0, 'far', new.id, new.seat_id, new.line_code, new.archived_at,
         new.distance_meters, new.lat, new.lon, new.place_id, pl.lat, pl.lon
  from public.phoenix_crm_imported_visit_sources s
  join public.ireports360_visits iv on iv.crm_visit_id = s.crm_visit_id and iv.visit_type = 0
  join public.phoenix_crm_ireports360_checkin_matches m on m.crm_visit_id = s.crm_visit_id
  left join public.phoenix_crm_places pl on pl.id = new.place_id
  where s.visit_id = new.id
  order by iv.crm_visit_id
  on conflict (crm_visit_id) do update
    set distance_meters = excluded.distance_meters,
        checkin_lat = excluded.checkin_lat,
        checkin_lon = excluded.checkin_lon,
        place_id = excluded.place_id,
        place_lat = excluded.place_lat,
        place_lon = excluded.place_lon
    where phoenix_crm_visit_archive.reason = 'far';
  return null;
end;
$function$;

revoke execute on function public.phoenix_crm_visits_old_system_far_archive() from public, anon, authenticated;

drop trigger if exists phoenix_crm_visits_old_system_far_archive on public.phoenix_crm_visits;
create trigger phoenix_crm_visits_old_system_far_archive
  after update on public.phoenix_crm_visits
  for each row
  when (
    (old.archive_reason = 'far' or new.archive_reason = 'far')
    and (old.archive_reason, old.distance_meters, old.place_id, old.lat, old.lon)
        is distinct from (new.archive_reason, new.distance_meters, new.place_id, new.lat, new.lon)
  )
  execute function public.phoenix_crm_visits_old_system_far_archive();

-- 4. Prepare: the check-in matches, the archive, the copied rows archived -----------------------------------

create or replace function public.phoenix_crm_prepare_ireports360_conversion(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
  v_matches_written integer := 0;
  v_archive_written integer := 0;
  v_rows_archived integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('public.phoenix_crm_prepare_ireports360_conversion'));

  drop table if exists pg_temp.phx_conv_match;
  drop table if exists pg_temp.phx_conv_archive;
  drop table if exists pg_temp.phx_conv_rows;

  -- Every regular visit's check-in: the agent at that contact, on the visit's day as the doors read a
  -- check-in's day — its wall clock as stored (Cairo, labelled UTC: the vendor convention) — inside Egypt's
  -- box. Of several, the one nearest the visit's own time (both on the same wall clock), then the lowest id.
  -- Measured 7 Nov 2026: 101,829 of 106,231 regular visits match on that day; 96,478 on a Cairo-shifted day.
  create temp table phx_conv_match on commit drop as
  select iv.crm_visit_id, ck.crm_checkin_id, ck.lat, ck.lon, ck.check_date
  from public.ireports360_visits iv
  cross join lateral (
    select c.crm_checkin_id, c.lat, c.lon, c.check_date
    from public.ireports360_checkins c
    where c.agent_crm_id = iv.agent_crm_id
      and c.contact_crm_id = iv.contact_crm_id
      and c.check_date >= iv.visit_date::timestamp at time zone 'UTC'
      and c.check_date < (iv.visit_date + 1)::timestamp at time zone 'UTC'
      and c.lat between 21.5 and 32
      and c.lon between 24 and 37.5
    order by abs(extract(epoch from (c.check_date - coalesce(iv.visit_date_time, c.check_date)))), c.crm_checkin_id
    limit 1
  ) ck
  where iv.visit_type = 0
    and nullif(iv.contact_crm_id, 0) is not null;
  create unique index on phx_conv_match (crm_visit_id);
  analyze phx_conv_match;

  -- The archive: every campaign visit, and every regular visit with no check-in location. A visit already
  -- copied names its Phoenix row and that row's seat; one never copied names the territory its agent held
  -- that day, when he held one.
  create temp table phx_conv_archive on commit drop as
  select
    iv.crm_visit_id,
    iv.visit_date,
    iv.agent_crm_id,
    nullif(btrim(iv.agent_hr_id), '') as agent_hr_id,
    nullif(btrim(iv.agent_name), '') as agent_name,
    nullif(iv.contact_crm_id, 0) as contact_crm_id,
    nullif(btrim(iv.contact_name), '') as customer_name,
    iv.visit_type,
    case when iv.visit_type = -8 then 'campaign' else 'no_checkin_location' end as reason,
    s.visit_id,
    coalesce(pv.seat_id, held.seat_id) as seat_id,
    coalesce(pv.line_code, held.line_code) as line_code,
    -- A check-in on that day and contact that lay outside Egypt's box: counted, never used.
    (iv.visit_type = 0 and exists (
      select 1 from public.ireports360_checkins c
      where c.agent_crm_id = iv.agent_crm_id and c.contact_crm_id = iv.contact_crm_id
        and c.check_date >= iv.visit_date::timestamp at time zone 'UTC'
        and c.check_date < (iv.visit_date + 1)::timestamp at time zone 'UTC'
        and c.lat is not null and c.lon is not null
    )) as checkin_outside_box
  from public.ireports360_visits iv
  left join public.phoenix_crm_imported_visit_sources s on s.crm_visit_id = iv.crm_visit_id
  left join public.phoenix_crm_visits pv on pv.id = s.visit_id
  left join lateral (
    select o.seat_id, o.line_code
    from public.au_v_seat_occupancy_all o
    where pv.id is null
      and lower(o.occupant_canonical_hr_id) = lower(btrim(iv.agent_hr_id))
      and o.node_type = 'person'
      and o.seat_id like '%-REP-%'
      and o.effective_from <= iv.visit_date
      and (o.effective_to is null or o.effective_to >= iv.visit_date)
    order by o.effective_from desc, o.seat_id
    limit 1
  ) held on true
  where iv.visit_type = -8
     or (iv.visit_type = 0 and not exists (select 1 from phx_conv_match m where m.crm_visit_id = iv.crm_visit_id));

  -- A copied Phoenix row that is not a visit: none of its old visits is a regular visit (a campaign visit),
  -- or none of its regular ones had a check-in location. A row merging two old visits stands if either did.
  create temp table phx_conv_rows on commit drop as
  select
    v.id,
    case when bool_or(iv.visit_type = 0) then 'no_checkin_location' else 'campaign' end as reason
  from public.phoenix_crm_visits v
  join public.phoenix_crm_imported_visit_sources s on s.visit_id = v.id
  join public.ireports360_visits iv on iv.crm_visit_id = s.crm_visit_id
  left join phx_conv_match m on m.crm_visit_id = iv.crm_visit_id
  where v.imported_from_ireports360_at is not null
    and v.archived_at is null
  group by v.id
  having not bool_or(iv.visit_type = 0 and m.crm_visit_id is not null);

  if p_apply then
    insert into public.phoenix_crm_ireports360_checkin_matches (crm_visit_id, crm_checkin_id, lat, lon, check_date, matched_at)
    select m.crm_visit_id, m.crm_checkin_id, m.lat, m.lon, m.check_date, v_now
    from phx_conv_match m
    order by m.crm_visit_id
    on conflict (crm_visit_id) do nothing;
    get diagnostics v_matches_written = row_count;

    insert into public.phoenix_crm_visit_archive (
      crm_visit_id, visit_date, agent_crm_id, agent_hr_id, agent_name, contact_crm_id, customer_name,
      visit_type, reason, visit_id, seat_id, line_code, archived_at
    )
    select a.crm_visit_id, a.visit_date, a.agent_crm_id, a.agent_hr_id, a.agent_name, a.contact_crm_id,
           left(a.customer_name, 200), a.visit_type, a.reason, a.visit_id, a.seat_id, a.line_code, v_now
    from phx_conv_archive a
    order by a.crm_visit_id
    on conflict (crm_visit_id) do nothing;
    get diagnostics v_archive_written = row_count;

    -- NEVER a delete (production has no PITR): the row stays, marked, and every reader skips the mark.
    update public.phoenix_crm_visits v
       set archived_at = v_now,
           archive_reason = r.reason
      from phx_conv_rows r
     where v.id = r.id
       and v.archived_at is null;
    get diagnostics v_rows_archived = row_count;
  end if;

  return jsonb_build_object(
    'applied', p_apply,
    'regular_visits', (select count(*) from public.ireports360_visits where visit_type = 0),
    'regular_with_checkin_location', (select count(*) from phx_conv_match),
    'regular_with_checkin_location_no_hr_id', (
      select count(*) from phx_conv_match m join public.ireports360_visits iv on iv.crm_visit_id = m.crm_visit_id
      where nullif(btrim(iv.agent_hr_id), '') is null
    ),
    'archive', jsonb_build_object(
      'campaign_copied', (select count(*) from phx_conv_archive where reason = 'campaign' and visit_id is not null),
      'campaign_never_copied', (select count(*) from phx_conv_archive where reason = 'campaign' and visit_id is null),
      'no_checkin_location_copied', (select count(*) from phx_conv_archive where reason = 'no_checkin_location' and visit_id is not null),
      'no_checkin_location_never_copied', (select count(*) from phx_conv_archive where reason = 'no_checkin_location' and visit_id is null),
      'checkin_outside_box', (select count(*) from phx_conv_archive where checkin_outside_box)
    ),
    'copied_rows_to_archive', jsonb_build_object(
      'campaign', (select count(*) from phx_conv_rows where reason = 'campaign'),
      'no_checkin_location', (select count(*) from phx_conv_rows where reason = 'no_checkin_location')
    ),
    'copied_rows_with_no_source', (
      select count(*) from public.phoenix_crm_visits v
      where v.imported_from_ireports360_at is not null
        and not exists (select 1 from public.phoenix_crm_imported_visit_sources s where s.visit_id = v.id)
    ),
    'written', jsonb_build_object(
      'matches', v_matches_written,
      'archive', v_archive_written,
      'copied_rows_archived', v_rows_archived
    )
  );
end;
$function$;

revoke execute on function public.phoenix_crm_prepare_ireports360_conversion(boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_prepare_ireports360_conversion(boolean) to service_role;

-- 5. The conversion: a page to measure, and the write ------------------------------------------------------

-- A page of copied, not archived visits in id order: each with the check-in it converts with (its first
-- regular old visit that had one) and its customer's ACTIVE places today. The runner measures them with
-- geo.ts's checkVisitLocation, so the distance rule has one home.
create or replace function public.phoenix_crm_ireports360_conversion_page(p_after uuid default null, p_limit integer default 500)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with page as (
    select v.id, v.customer_id, v.lat, v.lon, v.place_id, v.distance_meters, v.location_flag,
           v.ireports360_checkin_id, v.ireports360_kpi_counted
    from public.phoenix_crm_visits v
    where v.imported_from_ireports360_at is not null
      and v.archived_at is null
      and not v.is_test
      and (p_after is null or v.id > p_after)
    order by v.id
    limit least(greatest(coalesce(p_limit, 500), 1), 2000)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'visit_id', p.id,
    'customer_id', p.customer_id,
    'lat', p.lat,
    'lon', p.lon,
    'place_id', p.place_id,
    'distance_meters', p.distance_meters,
    'location_flag', p.location_flag,
    'checkin_id', p.ireports360_checkin_id,
    'kpi_counted', p.ireports360_kpi_counted,
    'match', (
      select jsonb_build_object('checkin_id', m.crm_checkin_id, 'lat', m.lat, 'lon', m.lon)
      from public.phoenix_crm_imported_visit_sources s
      join public.ireports360_visits iv on iv.crm_visit_id = s.crm_visit_id and iv.visit_type = 0
      join public.phoenix_crm_ireports360_checkin_matches m on m.crm_visit_id = s.crm_visit_id
      where s.visit_id = p.id
      order by s.crm_visit_id
      limit 1
    ),
    'places', coalesce((
      select jsonb_agg(jsonb_build_object('id', pl.id, 'lat', pl.lat, 'lon', pl.lon) order by pl.id)
      from public.phoenix_crm_places pl
      where pl.customer_id = p.customer_id and pl.status = 'active' and not pl.is_test
    ), '[]'::jsonb)
  ) order by p.id), '[]'::jsonb)
  from page p
$function$;

revoke execute on function public.phoenix_crm_ireports360_conversion_page(uuid, integer) from public, anon, authenticated;
grant execute on function public.phoenix_crm_ireports360_conversion_page(uuid, integer) to service_role;

-- The write. The position is never taken from the caller: it is the matched check-in's own, and the
-- check-in must be one of THIS visit's old visits. The place must be the customer's own active place. The
-- counted flag is the trigger's. A row already holding exactly this answer is not touched.
create or replace function public.phoenix_crm_apply_ireports360_conversion(p_items jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > 2000 then
    raise exception 'phoenix_crm:conversion_items_invalid'
      using hint = 'An array of at most 2,000 items: {visit_id, checkin_id, place_id, distance_meters, location_flag}.';
  end if;

  with item as (
    select
      (x ->> 'visit_id')::uuid as visit_id,
      (x ->> 'checkin_id')::bigint as checkin_id,
      nullif(x ->> 'place_id', '')::uuid as place_id,
      (x ->> 'distance_meters')::integer as distance_meters,
      x ->> 'location_flag' as location_flag
    from jsonb_array_elements(p_items) x
  ),
  upd as (
    update public.phoenix_crm_visits v
       set lat = m.lat,
           lon = m.lon,
           accuracy_meters = null,
           place_id = i.place_id,
           distance_meters = i.distance_meters,
           location_flag = i.location_flag,
           ireports360_checkin_id = m.crm_checkin_id
      from item i
      join public.phoenix_crm_ireports360_checkin_matches m on m.crm_checkin_id = i.checkin_id
     where v.id = i.visit_id
       and v.imported_from_ireports360_at is not null
       and v.archived_at is null
       and exists (
         select 1 from public.phoenix_crm_imported_visit_sources s
         where s.visit_id = v.id and s.crm_visit_id = m.crm_visit_id
       )
       -- A place answers ok or far; no place answers no_place with no distance.
       and (
         (i.place_id is null and i.location_flag = 'no_place' and i.distance_meters is null)
         or (
           i.place_id is not null and i.location_flag in ('ok', 'far') and i.distance_meters >= 0
           and exists (
             select 1 from public.phoenix_crm_places pl
             where pl.id = i.place_id and pl.customer_id = v.customer_id and pl.status = 'active'
           )
         )
       )
       and (v.lat, v.lon, v.place_id, v.distance_meters, v.location_flag, v.ireports360_checkin_id)
           is distinct from (m.lat, m.lon, i.place_id, i.distance_meters, i.location_flag, m.crm_checkin_id)
    returning 1
  )
  select count(*)::integer into v_count from upd;
  return v_count;
end;
$function$;

revoke execute on function public.phoenix_crm_apply_ireports360_conversion(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_apply_ireports360_conversion(jsonb) to service_role;

-- 6. The importer: leavers, and only a located regular visit ---------------------------------------------------
--
-- The 20261107001714 body, with p_leavers added and the copy narrowed to a regular visit with a check-in
-- location in every mode. Every other line is that body's.

drop function if exists public.phoenix_crm_import_ireports360_history(text, boolean, boolean);

create or replace function public.phoenix_crm_import_ireports360_history(
  p_seat text default null,
  p_apply boolean default false,
  p_after_start boolean default false,
  p_leavers boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_seat text := nullif(btrim(coalesce(p_seat, '')), '');
  v_now timestamptz := now();
  v_archive_written integer := 0;
  v_holders_written integer := 0;
  v_written integer := 0;
  v_mapped integer := 0;
  v_unresolved integer := 0;
  v_seats jsonb;
begin
  if p_apply and v_seat is null then
    raise exception 'phoenix_crm:import_needs_a_seat'
      using hint = 'Apply one seat at a time: scripts/phoenix-crm-import-ireports360-history.ts loops them.';
  end if;

  if p_after_start and p_leavers then
    raise exception 'phoenix_crm:import_one_mode_at_a_time'
      using hint = 'Run --after-start and --leavers separately.';
  end if;

  -- One run at a time, so two runs never race for the same holder numbers.
  perform pg_advisory_xact_lock(hashtext('public.phoenix_crm_import_ireports360_history'));

  drop table if exists pg_temp.phx_import_links;
  drop table if exists pg_temp.phx_import_roles;
  drop table if exists pg_temp.phx_import_src;
  drop table if exists pg_temp.phx_import_archive;
  drop table if exists pg_temp.phx_import_slots;
  drop table if exists pg_temp.phx_import_holders;
  drop table if exists pg_temp.phx_import_keyed;
  drop table if exists pg_temp.phx_import_rows;
  drop table if exists pg_temp.phx_import_written;

  -- A doctor the rep added himself carries a Phoenix-only id from the reserved band and no vendor id, so
  -- only a confirmed identity link can say which old contact he is.
  create temp table phx_import_links on commit drop as
  select v.source_id::bigint as contact_crm_id, p.source_id::uuid as customer_id
  from public.customer_identity_links v
  join public.customer_identity_links p on p.master_id = v.master_id and p.source = 'phoenix_crm'
  where v.source = 'ireports360'
    and v.source_id ~ '^[0-9]{1,18}$'
    and p.source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  -- Asked for every customer of the seat on every old visit, so it is looked up, never scanned.
  create index on phx_import_links (contact_crm_id, customer_id);
  analyze phx_import_links;

  -- With no seat on the visit's day, the partner is judged by app role, as the visit form offers people
  -- (visit-ask-rules.ts): an active login first, never a test persona.
  create temp table phx_import_roles on commit drop as
  select distinct on (lower(u.hr_id)) lower(u.hr_id) as hr, u.role
  from public.app_auth_users u
  where u.hr_id is not null and not u.is_test_persona
  order by lower(u.hr_id), u.is_active desc, u.updated_at desc;

  -- Every old visit in scope, already-copied ones included (they are counted, never written again).
  create temp table phx_import_src on commit drop as
  with cur as (
    select o.seat_id, o.line_code, lower(o.occupant_canonical_hr_id) as hr, e.hr_id as rep_hr_id
    from public.au_v_seat_occupancy_all o
    join public.employees e on lower(e.hr_id) = lower(o.occupant_canonical_hr_id)
    where not p_leavers
      and o.effective_to is null
      and o.node_type = 'person'
      and o.seat_id like '%-REP-%'
      and e.employment_status = 'active'
      and (v_seat is null or o.seat_id = v_seat)
    union
    -- LEAVERS (owner, 7 Nov 2026): a person on NO current territory today — resigned, or moved off the
    -- REP seats — keeps the visits he made on a territory, filed under the seat he held THAT day, any
    -- status. A current rep's day on another seat stays out, as the first run decided.
    select o.seat_id, o.line_code, lower(o.occupant_canonical_hr_id) as hr, e.hr_id as rep_hr_id
    from public.au_v_seat_occupancy_all o
    join public.employees e on lower(e.hr_id) = lower(o.occupant_canonical_hr_id)
    where p_leavers
      and o.node_type = 'person'
      and o.seat_id like '%-REP-%'
      and (v_seat is null or o.seat_id = v_seat)
      and not exists (
        select 1 from public.au_v_seat_occupancy_all now_on
        where lower(now_on.occupant_canonical_hr_id) = lower(o.occupant_canonical_hr_id)
          and now_on.node_type = 'person' and now_on.effective_to is null and now_on.seat_id like '%-REP-%'
      )
  ),
  st as (
    select s.seat_id, min(s.starts_on) as starts_on
    from public.phoenix_crm_started_team_seats() s
    group by s.seat_id
  )
  select
    c.seat_id,
    c.line_code,
    c.rep_hr_id,
    iv.crm_visit_id,
    iv.visit_date,
    iv.visit_type,
    contact.id as contact_crm_id,
    nullif(btrim(iv.contact_name), '') as contact_name,
    nullif(btrim(iv.speciality), '') as speciality,
    nullif(btrim(iv.comment), '') as comment,
    case when upper(btrim(coalesce(iv.ampm, ''))) = 'AM' then 'AM' else 'PM' end as ampm_list,
    case
      when iv.visit_date_time is not null and (iv.visit_date_time at time zone 'UTC')::date = iv.visit_date
        then (iv.visit_date_time at time zone 'UTC') at time zone 'Africa/Cairo'
      else (iv.visit_date + time '12:00') at time zone 'Africa/Cairo'
    end as captured_at,
    case when partner.kind is not null then partner.hr_id end as partner_hr_id,
    coalesce(partner.kind, 'single') as kind,
    -- The old system named somebody and the copy files nobody: the totals count these.
    (nullif(btrim(iv.double_hr_id), '') is not null and lower(btrim(iv.double_hr_id)) <> c.hr and partner.kind is null) as partner_dropped,
    cust.id as customer_id,
    cust.list_type as customer_list_type,
    exists (
      select 1 from public.phoenix_crm_imported_visit_sources s where s.crm_visit_id = iv.crm_visit_id
    ) as already_imported
  from cur c
  -- A leaver's seat is read whether or not its team has started: his days are dated by the seat he held.
  left join st on st.seat_id = c.seat_id
  join public.ireports360_visits iv on lower(iv.agent_hr_id) = c.hr
  -- 0 is no contact: a campaign visit, which goes on a holder.
  cross join lateral (select nullif(iv.contact_crm_id, 0) as id) contact
  left join lateral (
    select
      pe.hr_id,
      -- The visit's own day decides. In a manager's seat that day, an acting one included, he was a manager
      -- whatever he is now; in only other seats, a rep's say, he was no partner, even if promoted since.
      -- Product and training managers hold no seat, so they land on today's role, as does anyone whose seat
      -- history does not reach that far back. Anyone the visit form would not offer is not a partner at all.
      case
        when that_day.in_manager_seat then 'double'
        when that_day.seated then null
        when who.role in ('Product Manager', 'Group Product Manager', 'Training Manager') then 'product_manager'
        when who.role = 'Marketing Manager' and lower(c.line_code) = 'cns' then 'product_manager'
        when who.role in ('District Manager', 'Regional Manager', 'National Sales Manager') then 'double'
      end as kind
    from public.employees pe
    left join phx_import_roles r on r.hr = lower(pe.hr_id)
    -- Somebody who has left may have no login; the title says the same thing in other words.
    cross join lateral (
      select coalesce(r.role, case btrim(pe.job_title)
        when 'District Sales Manager' then 'District Manager'
        when 'Senior District Manager' then 'District Manager'
        when 'Regional Sales Manager' then 'Regional Manager'
        else btrim(pe.job_title)
      end) as role
    ) who
    cross join lateral (
      select
        count(*) > 0 as seated,
        coalesce(bool_or(split_part(o.seat_id, '-', 3) in ('DM', 'ADM', 'RSM', 'NSM')), false) as in_manager_seat
      from public.au_v_seat_occupancy_all o
      where lower(o.occupant_canonical_hr_id) = lower(pe.hr_id) and o.node_type = 'person'
        and o.effective_from <= iv.visit_date and (o.effective_to is null or o.effective_to >= iv.visit_date)
    ) that_day
    where lower(pe.hr_id) = lower(btrim(iv.double_hr_id))
      and lower(pe.hr_id) <> c.hr
    order by pe.hr_id
    limit 1
  ) partner on true
  left join lateral (
    select cu.id, cu.list_type
    from public.phoenix_crm_customers cu
    where cu.seat_id = c.seat_id
      and not cu.is_test
      and contact.id is not null
      and (
        cu.reference_contact_crm_id = contact.id
        or exists (select 1 from phx_import_links l where l.contact_crm_id = contact.id and l.customer_id = cu.id)
      )
    -- His own customer before an Archive copy an earlier run made, even when only a link names him.
    order by (cu.imported_from_ireports360_at is null) desc, (cu.reference_contact_crm_id is not distinct from contact.id) desc, cu.created_at, cu.id
    limit 1
  ) cust on true
  where (p_leavers or st.seat_id is not null)
    -- 🔴 ONLY A REGULAR VISIT WITH A CHECK-IN LOCATION IS A VISIT (owner, 7 Nov 2026). A campaign visit is
    -- retired and never copied; a regular visit with no located check-in is not a visit. "Located" is the
    -- one table phoenix_crm_prepare_ireports360_conversion fills, so this and the archive never disagree.
    and iv.visit_type = 0
    and contact.id is not null
    and exists (select 1 from public.phoenix_crm_ireports360_checkin_matches m where m.crm_visit_id = iv.crm_visit_id)
    -- The vendor's catch-all names nobody and its visits are not campaign visits, so they are not copied:
    -- every check-in, coverage and territory figure leaves it out.
    and iv.contact_crm_id is distinct from 100000
    and iv.visit_date >= date '2026-01-01'
    -- BEFORE THE START: the archive's history, as the first run copied it (29 Oct). AFTER IT (p_after_start;
    -- owner, 6 Nov 2026: "Keep + show in Phoenix"): a day from the team's start to the day before iReports360
    -- was retired on which the rep made NO Phoenix entry. The door already counts that day from iReports360;
    -- the copy only lets Phoenix CRM's own screens show it, and it moves no count, because the countable view
    -- and the entry-days trigger both skip a copied visit. A day he has an entry is Phoenix's, never copied.
    and (
      -- LEAVERS: every 2026 day before iReports360 was retired, except a day he has a Phoenix entry.
      (
        p_leavers
        and iv.visit_date < coalesce((select (k.vendor_sync_retired_at at time zone 'Africa/Cairo')::date from public.crm_cutover k where k.id), '-infinity'::date)
        and not exists (
          select 1 from public.phoenix_crm_rep_entry_days_cache e
          where e.hr_key = c.hr and e.entry_day = iv.visit_date
        )
      )
      or (not p_leavers and not p_after_start and iv.visit_date < st.starts_on)
      or (
        p_after_start
        and iv.visit_date >= st.starts_on
        and iv.visit_date < coalesce((select (k.vendor_sync_retired_at at time zone 'Africa/Cairo')::date from public.crm_cutover k where k.id), '-infinity'::date)
        and not exists (
          select 1 from public.phoenix_crm_rep_entry_days_cache e
          where e.hr_key = c.hr and e.entry_day = iv.visit_date
        )
      )
    )
    -- He held this seat that day; or he held no seat at all that day and it is a campaign visit, which
    -- names no territory's doctor. A day on any other seat, rep or manager, is that seat's history.
    and (
      exists (
        select 1 from public.au_v_seat_occupancy_all o
        where lower(o.occupant_canonical_hr_id) = c.hr and o.node_type = 'person'
          and o.seat_id = c.seat_id
          and o.effective_from <= iv.visit_date and (o.effective_to is null or o.effective_to >= iv.visit_date)
      )
      or (
        iv.visit_type = -8
        and not exists (
          select 1 from public.au_v_seat_occupancy_all o
          where lower(o.occupant_canonical_hr_id) = c.hr and o.node_type = 'person'
            and o.effective_from <= iv.visit_date and (o.effective_to is null or o.effective_to >= iv.visit_date)
        )
      )
    );

  -- Doctors the seat does not have: one Archive doctor each.
  create temp table phx_import_archive on commit drop as
  select
    a.seat_id,
    a.contact_crm_id,
    a.line_code,
    a.rep_hr_id,
    left(coalesce(nullif(btrim(cc.name), ''), a.latest_name, 'Old system doctor ' || a.contact_crm_id), 200) as name,
    left(coalesce(nullif(btrim(cc.speciality), ''), a.latest_speciality), 120) as speciality,
    -- A pharmacy is a pharmacy whatever period the vendor tagged (contact-taxonomy.ts, isPharmacySpeciality).
    case
      when lower(regexp_replace(btrim(coalesce(nullif(btrim(cc.speciality), ''), a.latest_speciality, '')), '\s+', ' ', 'g')) = 'pharmacy' then 'Pharmacy'
      else coalesce(own_list.list_type, any_list.list_type, a.majority_list)
    end as list_type
  from (
    select
      s.seat_id,
      s.contact_crm_id,
      min(s.line_code) as line_code,
      min(s.rep_hr_id) as rep_hr_id,
      (array_agg(s.contact_name order by s.visit_date desc, s.crm_visit_id desc)
        filter (where s.contact_name is not null))[1] as latest_name,
      (array_agg(s.speciality order by s.visit_date desc, s.crm_visit_id desc)
        filter (where s.speciality is not null))[1] as latest_speciality,
      case
        when count(*) filter (where s.ampm_list = 'AM') > count(*) filter (where s.ampm_list = 'PM') then 'AM'
        else 'PM'
      end as majority_list
    from phx_import_src s
    where not s.already_imported and s.contact_crm_id is not null and s.customer_id is null
    group by s.seat_id, s.contact_crm_id
  ) a
  left join public.crm_contacts cc on cc.contact_crm_id = a.contact_crm_id
  left join lateral (
    select ca.list_type
    from public.crm_contact_assignments ca
    where ca.contact_crm_id = a.contact_crm_id
      and lower(ca.agent_hr_id) = lower(a.rep_hr_id)
      and ca.list_type in ('AM', 'PM', 'Pharmacy')
    order by ca.last_seen_on desc, ca.effective_from desc, ca.id desc
    limit 1
  ) own_list on true
  left join lateral (
    select ca.list_type
    from public.crm_contact_assignments ca
    where ca.contact_crm_id = a.contact_crm_id
      and ca.list_type in ('AM', 'PM', 'Pharmacy')
    order by ca.last_seen_on desc, ca.effective_from desc, ca.id desc
    limit 1
  ) any_list on true;

  -- Campaign visits name nobody: the Nth of a day and list goes on holder N, after any slot an earlier run
  -- already filled that day.
  create temp table phx_import_slots on commit drop as
  with used as (
    select v.seat_id, h.list_type, v.visit_date, count(*)::integer as n
    from public.phoenix_crm_visits v
    join public.phoenix_crm_customers h on h.id = v.customer_id and h.campaign_visit_holder
    where not v.is_test
      and (v_seat is null or v.seat_id = v_seat)
    group by v.seat_id, h.list_type, v.visit_date
  )
  select
    s.crm_visit_id,
    s.seat_id,
    s.line_code,
    s.rep_hr_id,
    s.ampm_list as list_type,
    (row_number() over (
      partition by s.seat_id, s.ampm_list, s.visit_date order by s.captured_at, s.crm_visit_id
    ))::integer + coalesce(u.n, 0) as slot
  from phx_import_src s
  left join used u on u.seat_id = s.seat_id and u.list_type = s.ampm_list and u.visit_date = s.visit_date
  where not s.already_imported and s.contact_crm_id is null;

  create temp table phx_import_holders on commit drop as
  select
    need.seat_id,
    need.list_type,
    n.slot,
    'Campaign visit ' || n.slot as name,
    need.line_code,
    need.rep_hr_id,
    h.id as customer_id,
    h.id is null as is_new
  from (
    select seat_id, list_type, max(slot) as top, min(line_code) as line_code, min(rep_hr_id) as rep_hr_id
    from phx_import_slots
    group by seat_id, list_type
  ) need
  cross join lateral generate_series(1, need.top) as n(slot)
  left join lateral (
    select c.id
    from public.phoenix_crm_customers c
    where c.seat_id = need.seat_id
      and c.list_type = need.list_type
      and c.campaign_visit_holder
      and not c.is_test
      and c.name = 'Campaign visit ' || n.slot
    order by c.created_at, c.id
    limit 1
  ) h on true;

  if p_apply then
    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, origin, reference_contact_crm_id,
      status, dropped_reason, dropped_note, created_by_hr_id, imported_from_ireports360_at
    )
    select
      a.seat_id, a.line_code, a.list_type, a.name, a.speciality, 'reference', a.contact_crm_id,
      'dropped', 'imported_history',
      case when p_leavers
        then 'Visited in the old system by a rep who no longer holds this territory; added to the Archive with that history.'
        when p_after_start
        then 'Visited in the old system after this team started on Phoenix, on a day with no Phoenix entry; added to the Archive with that history.'
        else 'Visited in the old system before this team started on Phoenix; added to the Archive with that history.'
      end,
      a.rep_hr_id, v_now
    from phx_import_archive a
    order by a.seat_id, a.contact_crm_id
    on conflict (seat_id, reference_contact_crm_id, is_test) where reference_contact_crm_id is not null do nothing;
    get diagnostics v_archive_written = row_count;

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, origin, status, dropped_reason, dropped_note,
      created_by_hr_id, imported_from_ireports360_at, campaign_visit_holder
    )
    select
      h.seat_id, h.line_code, h.list_type, h.name, 'new', 'dropped', 'imported_history',
      'Holds the old system''s campaign visits, which name no doctor.',
      h.rep_hr_id, v_now, true
    from phx_import_holders h
    where h.is_new
    order by h.seat_id, h.list_type, h.slot;
    get diagnostics v_holders_written = row_count;

    update phx_import_holders h
       set customer_id = c.id
      from public.phoenix_crm_customers c
     where h.customer_id is null
       and c.seat_id = h.seat_id
       and c.list_type = h.list_type
       and c.campaign_visit_holder
       and not c.is_test
       and c.name = h.name;
  end if;

  -- One key per future row: the seat's customer, the Archive doctor still to be made, or holder N.
  create temp table phx_import_keyed on commit drop as
  select
    s.*,
    case
      when s.customer_id is not null then 'c:' || s.customer_id::text
      when s.contact_crm_id is not null then 'a:' || s.contact_crm_id::text
      else 'h:' || sl.list_type || ':' || sl.slot::text
    end as grp,
    case
      when s.customer_id is not null then s.customer_list_type
      when s.contact_crm_id is not null then a.list_type
      else sl.list_type
    end as list_type,
    coalesce(s.customer_id, ac.id, h.customer_id) as target_customer_id
  from phx_import_src s
  left join phx_import_archive a
    on s.customer_id is null and a.seat_id = s.seat_id and a.contact_crm_id = s.contact_crm_id
  left join public.phoenix_crm_customers ac
    on s.customer_id is null and s.contact_crm_id is not null
   and ac.seat_id = s.seat_id and ac.reference_contact_crm_id = s.contact_crm_id and not ac.is_test
  left join phx_import_slots sl on sl.crm_visit_id = s.crm_visit_id
  left join phx_import_holders h on h.seat_id = sl.seat_id and h.list_type = sl.list_type and h.slot = sl.slot
  where not s.already_imported;

  -- Two old visits by one rep to one customer on one day are one Phoenix row: the earlier time, planned if
  -- either was, the first partner, both notes.
  create temp table phx_import_rows on commit drop as
  select
    gen_random_uuid() as id,
    k.seat_id,
    min(k.line_code) as line_code,
    k.grp,
    k.visit_date,
    (array_agg(k.target_customer_id) filter (where k.target_customer_id is not null))[1] as customer_id,
    min(k.list_type) as list_type,
    min(k.captured_at) as captured_at,
    not bool_or(k.visit_type = 0) as is_unplanned,
    k.rep_hr_id,
    (array_agg(k.partner_hr_id order by k.captured_at, k.crm_visit_id)
      filter (where k.partner_hr_id is not null))[1] as partner_hr_id,
    (array_agg(k.kind order by k.captured_at, k.crm_visit_id)
      filter (where k.partner_hr_id is not null))[1] as partner_kind,
    left(string_agg(k.comment, ' · ' order by k.captured_at, k.crm_visit_id), 1000) as comment,
    array_agg(k.crm_visit_id order by k.crm_visit_id) as crm_visit_ids,
    count(*)::integer as sources,
    false as conflict
  from phx_import_keyed k
  group by k.seat_id, k.grp, k.visit_date, k.rep_hr_id;

  -- Two reps on one seat who saw one customer on one day: Phoenix holds one visit a day for a seat and
  -- customer, so the earlier is written. The later one maps to nothing, so it stays on the List's
  -- old-system line instead of vanishing under the other rep's name. That line is read by the customer's
  -- reference id, so a doctor found only through a link has none: conflicts_without_a_line counts those.
  update phx_import_rows r
     set conflict = true
   where exists (
     select 1 from phx_import_rows e
     where e.seat_id = r.seat_id and e.grp = r.grp and e.visit_date = r.visit_date
       and (e.captured_at, e.rep_hr_id) < (r.captured_at, r.rep_hr_id)
   );

  -- A Phoenix visit already on that customer and day stays; the old one is counted and left out.
  update phx_import_rows r
     set conflict = true
   where r.customer_id is not null
     and exists (
       select 1 from public.phoenix_crm_visits v
       where v.seat_id = r.seat_id and v.customer_id = r.customer_id and v.visit_date = r.visit_date
         and not v.is_test
     );

  create temp table phx_import_written (id uuid primary key) on commit drop;

  if p_apply then
    select count(*)::integer into v_unresolved from phx_import_rows r where r.customer_id is null;
    if v_unresolved > 0 then
      raise exception 'phoenix_crm:import_unresolved_customer'
        using hint = v_unresolved || ' rows on ' || v_seat || ' found no customer; nothing was written.';
    end if;

    with ins as (
      insert into public.phoenix_crm_visits (
        id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind,
        rep_hr_id, manager_hr_id, product_manager_hr_id, entered_by_hr_id, products, comment,
        location_flag, is_unplanned, unplanned_kind, capture_source, imported_from_ireports360_at
      )
      select
        r.id, r.seat_id, r.line_code, r.customer_id, r.list_type, r.visit_date, r.captured_at,
        coalesce(r.partner_kind, 'single'),
        r.rep_hr_id,
        case when r.partner_kind = 'double' then r.partner_hr_id end,
        case when r.partner_kind = 'product_manager' then r.partner_hr_id end,
        r.rep_hr_id, '{}', r.comment,
        'no_place', r.is_unplanned,
        case when r.is_unplanned then 'out_of_list' end,
        'admin', v_now
      from phx_import_rows r
      where not r.conflict
      order by r.visit_date, r.captured_at, r.id
      on conflict (seat_id, customer_id, visit_date, is_test) do nothing
      returning id
    )
    insert into phx_import_written (id) select ins.id from ins;
    get diagnostics v_written = row_count;

    insert into public.phoenix_crm_imported_visit_sources (crm_visit_id, visit_id, imported_at)
    select src.crm_visit_id, r.id, v_now
    from phx_import_rows r
    join phx_import_written w on w.id = r.id
    cross join lateral unnest(r.crm_visit_ids) as src(crm_visit_id)
    on conflict (crm_visit_id) do nothing;
    get diagnostics v_mapped = row_count;
  end if;

  select coalesce(jsonb_agg(t.x order by t.seat_id), '[]'::jsonb)
    into v_seats
  from (
    select
      s.seat_id,
      jsonb_build_object(
        'seat_id', s.seat_id,
        'in_scope', s.in_scope,
        'already_imported', s.already_imported,
        'rows_to_write', coalesce(r.rows_to_write, 0),
        'merged_same_day', s.in_scope - s.already_imported - coalesce(r.rows_to_write, 0),
        'archive_doctors', coalesce(a.n, 0),
        'holders', coalesce(h.n, 0),
        'conflicts_skipped', coalesce(r.conflicts, 0),
        'written', coalesce(w.n, 0),
        'mapped', coalesce(w.mapped, 0)
      ) as x
    from (
      select seat_id, count(*)::integer as in_scope, (count(*) filter (where already_imported))::integer as already_imported
      from phx_import_src
      group by seat_id
    ) s
    left join (
      select seat_id, count(*)::integer as rows_to_write, (count(*) filter (where conflict))::integer as conflicts
      from phx_import_rows
      group by seat_id
    ) r on r.seat_id = s.seat_id
    left join (select seat_id, count(*)::integer as n from phx_import_archive group by seat_id) a on a.seat_id = s.seat_id
    left join (select seat_id, count(*)::integer as n from phx_import_holders where is_new group by seat_id) h
      on h.seat_id = s.seat_id
    left join (
      select r2.seat_id, count(*)::integer as n, sum(r2.sources)::integer as mapped
      from phx_import_written w2
      join phx_import_rows r2 on r2.id = w2.id
      group by r2.seat_id
    ) w on w.seat_id = s.seat_id
  ) t;

  return jsonb_build_object(
    'applied', p_apply,
    'seat', v_seat,
    'seats', v_seats,
    'totals', jsonb_build_object(
      'seats', jsonb_array_length(v_seats),
      'in_scope', (select count(*) from phx_import_src),
      'already_imported', (select count(*) from phx_import_src where already_imported),
      'rows_to_write', (select count(*) from phx_import_rows),
      'merged_same_day', (select count(*) from phx_import_keyed) - (select count(*) from phx_import_rows),
      'archive_doctors', case when p_apply then v_archive_written else (select count(*) from phx_import_archive) end,
      'holders', case when p_apply then v_holders_written else (select count(*) from phx_import_holders where is_new) end,
      'conflicts_skipped', (select count(*) from phx_import_rows where conflict)
        + case when p_apply then (select count(*) from phx_import_rows where not conflict) - v_written else 0 end,
      'written', v_written,
      'mapped', v_mapped,
      'partners_dropped', (select count(*) from phx_import_keyed where partner_dropped),
      'conflicts_without_a_line', (
        select count(*)
        from phx_import_rows r
        join public.phoenix_crm_customers cu on cu.id = r.customer_id
        where r.conflict and cu.reference_contact_crm_id is null and not cu.campaign_visit_holder
      )
    )
  );
end;
$function$;

revoke execute on function public.phoenix_crm_import_ireports360_history(text, boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_import_ireports360_history(text, boolean, boolean, boolean) to service_role;

-- 7. The two countable views append the new columns; the history view skips an archived visit ------------
--
-- Each is its 20261031160000 body, byte for byte in its select, with three columns appended (create or
-- replace view only accepts an appended column) and the history view's archived filter added last.

create or replace view public.phoenix_crm_countable_visits_with_history
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
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    v.product_manager_hr_id,
    -- Kept, so a history reader can still tell a copied visit from one entered in Phoenix.
    v.imported_from_ireports360_at,
    -- Appended (owner, 2026-11-07): the converted visit's check-in, and whether it counts in the KPIs. A
    -- history screen shows a converted visit to a customer with no validated place; a figure counts it only
    -- when ireports360_kpi_counted is true.
    v.ireports360_checkin_id,
    v.ireports360_kpi_counted,
    v.archived_at
  from public.phoenix_crm_visits v
  -- LEFT for the same reason as the countable view below: never "fix" it back to inner.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    )
    -- 🔴 AN ARCHIVED VISIT IS NOT A VISIT (owner, 2026-11-07): a campaign visit, or one with no check-in
    -- location. It stays in the table and shows on no history screen.
    and v.archived_at is null;

comment on view public.phoenix_crm_countable_visits_with_history is
  'Every countable Phoenix CRM visit, iReports360 history copied by 20261029212200 included, an archived one (campaign, or no check-in location) never. For the screens that show a rep''s whole year (timeline, Visit Report, Frequency, calendar reports). A copied visit counts in a figure only when ireports360_kpi_counted.';

revoke all on table public.phoenix_crm_countable_visits_with_history from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits_with_history to service_role;

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
    -- A pharmacy needs no validation (owner, 2026-10-03); everyone else still does. Coalesced so the
    -- column stays two-state although the join below is a left one.
    coalesce(c.validated_at is not null or c.list_type = 'Pharmacy', false) as customer_validated,
    -- Last, and not by preference: `create or replace view` only accepts an appended column, and this
    -- view has dependents, so it cannot be dropped to put the column beside manager_hr_id where it
    -- belongs. Read it by NAME — never by position.
    v.product_manager_hr_id,
    -- Appended (20261029212200), last for the same reason.
    v.imported_from_ireports360_at,
    -- Appended (owner, 2026-11-07), the history view's three, so both views keep one column list.
    v.ireports360_checkin_id,
    v.ireports360_kpi_counted,
    v.archived_at
  from public.phoenix_crm_visits v
  -- LEFT, so the planner drops this join for every reader that never asks for customer_validated
  -- (phoenix_crm_rep_entry_days above all). It can never null-extend: customer_id is NOT NULL and
  -- carries the foreign key. Never "fix" it back to inner — that restores a customer lookup per visit.
  left join public.phoenix_crm_customers c on c.id = v.customer_id
  where (
      not v.is_unplanned
      -- 🔴 AN IN, NOT A LEFT JOIN (speed, 2026-10-28). The join probed the off-plan table's primary key
      -- once for EVERY visit any reader walked — about 12 million probes — to read one column. The IN is
      -- one hash of the approved rows per read. Exact: visit_id is that table's primary key, so the list
      -- holds no NULL and at most one row per visit. Never "fix" it back to a join.
      or v.id in (
        select uv.visit_id from public.phoenix_crm_unplanned_visits uv where uv.status = 'approved'
      )
      or v.unplanned_kind = 'out_of_list'
    )
    -- A recorded visit counts once the Administrator approves it (owner, 2026-10-16).
    and not exists (
      select 1 from public.phoenix_crm_visit_recordings r
      where r.visit_id = v.id and r.review_status <> 'approved'
    )
    -- 🔴 A visit copied from iReports360 history is not counted here YET (20261031160000). The doors'
    -- migration that follows the conversion admits the converted, KPI-counted ones; until then nothing moves.
    and v.imported_from_ireports360_at is null
    and v.archived_at is null;

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

notify pgrst, 'reload schema';
commit;

-- READBACK (reads only):
--   select column_name from information_schema.columns where table_name = 'phoenix_crm_visits'
--     and column_name in ('ireports360_checkin_id', 'ireports360_kpi_counted', 'archived_at', 'archive_reason');  -> 4
--   select relname, relrowsecurity from pg_class where relname in ('phoenix_crm_visit_archive', 'phoenix_crm_ireports360_checkin_matches');  -> both true
--   select proname, prosecdef, proacl from pg_proc where proname in ('phoenix_crm_prepare_ireports360_conversion',
--     'phoenix_crm_ireports360_conversion_page', 'phoenix_crm_apply_ireports360_conversion', 'phoenix_crm_import_ireports360_history');
--     -> prosecdef true; proacl names service_role (and the owner) only; one importer, four arguments.
--   select count(*) from public.phoenix_crm_countable_visits;  -> unchanged (10,736 on 7 Nov 2026 before any run)
--   select public.phoenix_crm_prepare_ireports360_conversion(false);  -> the counts; writes nothing.
