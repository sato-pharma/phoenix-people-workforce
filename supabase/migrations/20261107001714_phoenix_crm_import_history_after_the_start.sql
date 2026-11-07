-- WHAT: public.phoenix_crm_import_ireports360_history gains p_after_start (default false). False is the
--   20261101111500 body exactly: the archive's history before each team's start. True copies, instead, the
--   iReports360 visits a CURRENT rep made from his team's start to the day before iReports360 was retired
--   (crm_cutover.vendor_sync_retired_at, 6 Nov 2026), on days he made no Phoenix entry. Every other rule of the
--   copy is the same, line for line: the seat held that day, the partner by that day's seat, his own customer
--   first, the catch-all left out, one seat per write, a visit already in Phoenix never overwritten, an old
--   visit never written twice. The old two-argument function is dropped so a call by name finds one function.
-- WHY (owner, 6 Nov 2026): "ANY SINGLE SOURCE OF FIELD WORK IS NOW THE PHOENIX CRM"; asked what to do with the
--   old-app visits made after a team's start, he chose "Keep + show in Phoenix". Read live before writing this:
--   3,611 such visits, 42 people, 450 person-days, all dated before 6 Nov.
-- WHAT DOES NOT MOVE: no count anywhere. A copied visit carries imported_from_ireports360_at, which
--   phoenix_crm_countable_visits skips at its root (20261031160000) and the trigger
--   phoenix_crm_rep_entry_days_on_visit skips too (20261101101900), so crm_visits_unified keeps serving those
--   days from iReports360 exactly as today. This migration writes no row; the copy is the runner's --apply,
--   announced to the owner first (scripts/phoenix-crm-import-ireports360-history.ts --after-start).
-- ROLLBACK: drop function public.phoenix_crm_import_ireports360_history(text, boolean, boolean); then re-run the
--   20261101111500 file. Rows a run wrote are removed by the marks: docs/phoenix-crm-ireports360-history-import.md.
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — the import's own scratch tables.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

drop function if exists public.phoenix_crm_import_ireports360_history(text, boolean);

create or replace function public.phoenix_crm_import_ireports360_history(
  p_seat text default null,
  p_apply boolean default false,
  p_after_start boolean default false
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
  join st on st.seat_id = c.seat_id
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
  where iv.visit_type in (0, -8)
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
      (not p_after_start and iv.visit_date < st.starts_on)
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
      case when p_after_start
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

revoke execute on function public.phoenix_crm_import_ireports360_history(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_import_ireports360_history(text, boolean, boolean) to service_role;

commit;
