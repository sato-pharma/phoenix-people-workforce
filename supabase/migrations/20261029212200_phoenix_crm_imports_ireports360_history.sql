-- WHAT: Phoenix CRM receives every current Medical Rep's 2026 iReports360 visit history — 1 January up to
--   the day before his team started on Phoenix — as real visit rows on his current seat, and nothing that
--   judges, alarms or pays reads those rows.
--   1. Three marks: phoenix_crm_visits.imported_from_ireports360_at, phoenix_crm_customers
--      .imported_from_ireports360_at and phoenix_crm_customers.campaign_visit_holder.
--   2. public.phoenix_crm_imported_visit_sources — old crm_visit_id -> the Phoenix visit it became. It is
--      the idempotency key (a second run writes nothing) and how the List's old-system line stops counting
--      a copied visit twice. Two old visits to one doctor on one day become ONE row (Phoenix allows one a
--      day), so several old ids can map to one visit.
--   3. The contact-name trigger skips a campaign-visit holder, so no "Campaign visit N" reaches crm_contacts.
--      A new trigger clears a customer's import mark when it leaves the Archive (restored), so a restored
--      doctor is an ordinary customer again.
--   4. public.phoenix_crm_seats_with_activity (the 06:55 digest) skips imported visits, and
--      public.phx_crm_contact_visit_history (the List's "N visits in iReports360" line) skips old visits
--      already copied.
--      public.phoenix_crm_countable_visits gains imported_from_ireports360_at as its last column.
--   5. public.phoenix_crm_import_ireports360_history(p_seat, p_apply) — the copy itself. Dry run by default;
--      apply needs one seat. Service role only.
--   phoenix_crm_contact_truth_calc is NOT touched: it reads only validated customers, and nothing the
--   import writes is validated.
-- WHY: Owner, 2026-10-29: "I want to grab every rep now current in the company working. I want to grab his
--   visit history and put it in Phoenix CRM and make it as if it is a complete data." Then: "You will treat
--   the regular visit as the planned visit, and the campaign visit as the unplanned visits." Doctors Phoenix
--   does not have: "Add to Archive". Visits made on another seat (Anti-Infective AB5): "donot add visits
--   here or here". Account: docs/phoenix-crm-ireports360-history-import.md.
-- ROLLBACK: first 20261029212300's own (the contact refresh). Then re-create the name-row trigger from
--   20261015135844, phoenix_crm_seats_with_activity from 20261002220047 and phx_crm_contact_visit_history
--   from 20261016180202; the view keeps its appended column (a view cannot lose one). To remove the copied
--   history itself:
--     delete from public.phoenix_crm_visits where imported_from_ireports360_at is not null;
--     delete from public.phoenix_crm_customers c where c.imported_from_ireports360_at is not null
--       and not exists (select 1 from public.phoenix_crm_visits v where v.customer_id = c.id);
--   Production has NO PITR: the copy is removed by its marks, never by a restore.
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — the import's own scratch tables.

-- 1. The marks ------------------------------------------------------------------------------------------

alter table public.phoenix_crm_visits
  add column if not exists imported_from_ireports360_at timestamptz;

comment on column public.phoenix_crm_visits.imported_from_ireports360_at is
  'Set when the row was copied from iReports360 history by phoenix_crm_import_ireports360_history '
  '(the day before the seat''s team started, or earlier). History only: nothing that judges, alarms or '
  'pays reads it. See supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql.';

alter table public.phoenix_crm_customers
  add column if not exists imported_from_ireports360_at timestamptz,
  add column if not exists campaign_visit_holder boolean not null default false;

comment on column public.phoenix_crm_customers.imported_from_ireports360_at is
  'Set when the iReports360 history import created this customer: an Archive doctor (a doctor the rep '
  'visited in the old system that Phoenix did not have) or a campaign-visit holder. Cleared when the '
  'customer leaves the Archive. See 20261029212200_phoenix_crm_imports_ireports360_history.sql.';

comment on column public.phoenix_crm_customers.campaign_visit_holder is
  'A numbered "Campaign visit N" row that files the old system''s campaign visits, which name no doctor. '
  'Never on the List or the Archive screen, never in crm_contacts.';

-- 2. Which old visit became which Phoenix visit ---------------------------------------------------------

create table if not exists public.phoenix_crm_imported_visit_sources (
  crm_visit_id bigint primary key,
  visit_id uuid not null references public.phoenix_crm_visits (id) on delete cascade,
  imported_at timestamptz not null default now()
);

comment on table public.phoenix_crm_imported_visit_sources is
  'iReports360 crm_visit_id -> the phoenix_crm_visits row the history import wrote for it. Several old '
  'ids can map to one visit (two old visits to one doctor on one day are one Phoenix row). Read by the '
  'import (a second run writes nothing) and by phx_crm_contact_visit_history (a copied visit is not '
  'counted twice). See 20261029212200_phoenix_crm_imports_ireports360_history.sql.';

create index if not exists phoenix_crm_imported_visit_sources_visit_idx
  on public.phoenix_crm_imported_visit_sources (visit_id);

alter table public.phoenix_crm_imported_visit_sources enable row level security;
revoke all on table public.phoenix_crm_imported_visit_sources from public, anon, authenticated;

-- 3. The two customer triggers --------------------------------------------------------------------------

-- 20261015135844's trigger, re-created with one more condition: a campaign-visit holder names nobody.
create or replace trigger phoenix_crm_customers_write_contact_name_row
after insert or update of status, name, speciality, phone
on public.phoenix_crm_customers
for each row
when (
  -- 20261015135844's three clauses, verbatim, then the holder: a filing row, not a doctor.
  new.reference_contact_crm_id is null
  and not new.is_test
  and new.status in ('active', 'pending', 'dropped')
  and not new.campaign_visit_holder
)
execute function public.phoenix_crm_customers_write_contact_name_row();

create or replace function public.phoenix_crm_customers_clear_import_mark()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  -- An Archive doctor the rep restores is his customer from then on: every reader counts it again.
  if old.status = 'dropped' and new.status <> 'dropped' and not new.campaign_visit_holder then
    new.imported_from_ireports360_at := null;
  end if;
  return new;
end;
$function$;

create or replace trigger phoenix_crm_customers_clear_import_mark
  before update of status on public.phoenix_crm_customers
  for each row
  when (old.imported_from_ireports360_at is not null)
  execute function public.phoenix_crm_customers_clear_import_mark();

-- 4. The two SQL readers --------------------------------------------------------------------------------
-- Both bodies are the live ones (md5 62e5a73c3ef83a607a07215f242be5da and 54ed24d25c96c7b95f7104fad74886ff)
-- with one condition each. CREATE OR REPLACE keeps every grant.

create or replace function public.phoenix_crm_seats_with_activity(p jsonb)
returns jsonb
language sql
stable security definer
set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(asked.seat_id), '[]'::jsonb)
  from (
    select distinct elem.seat_id
    from jsonb_array_elements_text(coalesce(p -> 'seat_ids', '[]'::jsonb)) as elem(seat_id)
  ) asked
  -- A visit copied from iReports360 history is not activity on Phoenix (20261029212200).
  where exists (select 1 from public.phoenix_crm_visits t where t.seat_id = asked.seat_id and t.is_test = false and t.imported_from_ireports360_at is null)
     or exists (select 1 from public.phoenix_crm_places t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_plans t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_monthly_plans t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_day_activities t where t.seat_id = asked.seat_id and t.is_test = false)
     or exists (select 1 from public.phoenix_crm_list_requests t where t.seat_id = asked.seat_id and t.is_test = false);
$function$;

create or replace function public.phx_crm_contact_visit_history(p_contact_crm_ids bigint[], p_days_since date default null::date)
returns table(contact_crm_id bigint, visits integer, last_visited_on date, days date[])
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    v.contact_crm_id,
    count(*)::integer,
    max(v.visit_date),
    case
      when p_days_since is null then null
      else array_agg(v.visit_date order by v.visit_date desc) filter (where v.visit_date >= p_days_since)
    end
  from public.crm_visits_unified v
  where v.source = 'ireports360'
    and v.contact_crm_id = any (p_contact_crm_ids)
    -- An old visit already copied into Phoenix is counted there, never here as well (20261029212200).
    and not exists (
      select 1 from public.phoenix_crm_imported_visit_sources s where s.crm_visit_id = v.crm_visit_id
    )
  group by v.contact_crm_id
  order by v.contact_crm_id;
$function$;

-- The KPI view (20261028024500, byte for byte) with the import mark appended, so the readers that judge
-- (ranks, exceptions) can skip a copied visit by name. CREATE OR REPLACE VIEW keeps its comment.
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
    -- Appended (20261029212200), last for the same reason: set on a visit copied from iReports360
    -- history. A KPI and a report count it — the history is the rep's — but a reader that judges, alarms
    -- or pays skips it by this column.
    v.imported_from_ireports360_at
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
    );

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

-- 5. The copy --------------------------------------------------------------------------------------------
--
-- Scope (owner, 2026-10-29): every ACTIVE employee who sits on a current -REP- seat, the seat's team
-- started on Phoenix; his iReports360 regular (0) and campaign (-8) visits dated 1 January 2026 up to the
-- day before that start. A visit he made while he held ANOTHER -REP- seat and not this one is left out
-- ("donot add visits here or here"). Measured 2026-10-29: 69,127 visits on 58 seats.
--
-- Each copied row: capture_source 'admin' (the only shape with no GPS and no products), location_flag
-- 'no_place', products '{}', the old note in comment, the old time as captured_at (iReports360 writes
-- Cairo wall-clock time labelled UTC; a missing time or one on another day reads 12:00 Cairo), the rep as
-- rep_hr_id and entered_by_hr_id. Regular = planned; campaign = unplanned, 'out_of_list' (it names no
-- doctor). A partner who is a product manager -> kind 'product_manager'; any other partner -> 'double'.
--
-- Where it lands: the seat's own customer for that doctor (reference id first, then own id); else a new
-- Archive doctor (dropped, 'imported_history'); a campaign visit, which names nobody, on a numbered
-- "Campaign visit N" holder — the Nth campaign visit of that day and list on holder N.
create or replace function public.phoenix_crm_import_ireports360_history(
  p_seat text default null,
  p_apply boolean default false
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

  -- One run at a time, so two runs never race for the same holder numbers.
  perform pg_advisory_xact_lock(hashtext('public.phoenix_crm_import_ireports360_history'));

  drop table if exists pg_temp.phx_import_src;
  drop table if exists pg_temp.phx_import_archive;
  drop table if exists pg_temp.phx_import_slots;
  drop table if exists pg_temp.phx_import_holders;
  drop table if exists pg_temp.phx_import_keyed;
  drop table if exists pg_temp.phx_import_rows;
  drop table if exists pg_temp.phx_import_written;

  -- Every old visit in scope, already-copied ones included (they are counted, never written again).
  create temp table phx_import_src on commit drop as
  with cur as (
    select o.seat_id, o.line_code, lower(o.occupant_canonical_hr_id) as hr, e.hr_id as rep_hr_id
    from public.au_v_seat_occupancy_all o
    join public.employees e on lower(e.hr_id) = lower(o.occupant_canonical_hr_id)
    where o.effective_to is null
      and o.node_type = 'person'
      and o.seat_id like '%-REP-%'
      and e.employment_status = 'active'
      and (v_seat is null or o.seat_id = v_seat)
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
    nullif(iv.contact_crm_id, 0) as contact_crm_id,
    nullif(btrim(iv.contact_name), '') as contact_name,
    nullif(btrim(iv.speciality), '') as speciality,
    nullif(btrim(iv.comment), '') as comment,
    case when upper(btrim(coalesce(iv.ampm, ''))) = 'AM' then 'AM' else 'PM' end as ampm_list,
    case
      when iv.visit_date_time is not null and (iv.visit_date_time at time zone 'UTC')::date = iv.visit_date
        then (iv.visit_date_time at time zone 'UTC') at time zone 'Africa/Cairo'
      else (iv.visit_date + time '12:00') at time zone 'Africa/Cairo'
    end as captured_at,
    partner.hr_id as partner_hr_id,
    case
      when partner.hr_id is null then 'single'
      when partner.job_title ilike '%product manager%' then 'product_manager'
      else 'double'
    end as kind,
    cust.id as customer_id,
    cust.list_type as customer_list_type,
    exists (
      select 1 from public.phoenix_crm_imported_visit_sources s where s.crm_visit_id = iv.crm_visit_id
    ) as already_imported
  from cur c
  join st on st.seat_id = c.seat_id
  join public.ireports360_visits iv on lower(iv.agent_hr_id) = c.hr
  left join lateral (
    select pe.hr_id, pe.job_title
    from public.employees pe
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
      and nullif(iv.contact_crm_id, 0) is not null
      and (cu.reference_contact_crm_id = iv.contact_crm_id or cu.own_contact_crm_id = iv.contact_crm_id)
    order by (cu.reference_contact_crm_id is not distinct from iv.contact_crm_id) desc, cu.created_at, cu.id
    limit 1
  ) cust on true
  where iv.visit_type in (0, -8)
    and iv.visit_date >= date '2026-01-01'
    and iv.visit_date < st.starts_on
    and not (
      exists (
        select 1 from public.au_v_seat_occupancy_all o
        where lower(o.occupant_canonical_hr_id) = c.hr and o.node_type = 'person'
          and o.seat_id like '%-REP-%' and o.seat_id <> c.seat_id
          and o.effective_from <= iv.visit_date and (o.effective_to is null or o.effective_to >= iv.visit_date)
      )
      and not exists (
        select 1 from public.au_v_seat_occupancy_all o
        where lower(o.occupant_canonical_hr_id) = c.hr and o.node_type = 'person'
          and o.seat_id = c.seat_id
          and o.effective_from <= iv.visit_date and (o.effective_to is null or o.effective_to >= iv.visit_date)
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
    coalesce(own_list.list_type, any_list.list_type, a.majority_list) as list_type
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
      'Visited in the old system before this team started on Phoenix; added to the Archive with that history.',
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

  -- Two old visits to one customer on one day are one Phoenix row: the earlier time, planned if either was,
  -- the first partner, both notes.
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
    min(k.rep_hr_id) as rep_hr_id,
    (array_agg(k.partner_hr_id order by k.captured_at, k.crm_visit_id)
      filter (where k.partner_hr_id is not null))[1] as partner_hr_id,
    (array_agg(k.kind order by k.captured_at, k.crm_visit_id)
      filter (where k.partner_hr_id is not null))[1] as partner_kind,
    left(string_agg(k.comment, ' · ' order by k.captured_at, k.crm_visit_id), 1000) as comment,
    array_agg(k.crm_visit_id order by k.crm_visit_id) as crm_visit_ids,
    count(*)::integer as sources,
    false as conflict
  from phx_import_keyed k
  group by k.seat_id, k.grp, k.visit_date;

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
      'mapped', v_mapped
    )
  );
end;
$function$;

comment on function public.phoenix_crm_import_ireports360_history(text, boolean) is
  'Copies current reps'' 2026 iReports360 regular and campaign visits, before their team''s Phoenix start, '
  'into phoenix_crm_visits as history (imported_from_ireports360_at). Dry run unless p_apply; apply needs '
  'one seat. A second run writes nothing. Service role only. See '
  'docs/phoenix-crm-ireports360-history-import.md and '
  'supabase/migrations/20261029212200_phoenix_crm_imports_ireports360_history.sql.';

revoke execute on function public.phoenix_crm_import_ireports360_history(text, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_import_ireports360_history(text, boolean) to service_role;
