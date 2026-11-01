-- WHAT: The review's fixes to the iReports360 history copy, and to the two functions around it.
--   1. public.phoenix_crm_import_ireports360_history — the 20261029212200 body (md5 e80f79bd027e8d2e6e51fbf88005e4a9)
--      with six changes, none of which touches a row already written; each is a rule for the next run:
--      · a doctor the rep added himself is found through his confirmed identity link, so his history lands on
--        him and not on an Archive copy (the own-id arm could never match: own ids sit in a reserved band);
--      · a partner's kind comes from his app role, the visit form's own list, and with no login from his title.
--        Product, group product and training managers (and the marketing manager on CNS) file as
--        'product_manager'; district, regional and national managers as 'double'; anyone else is no partner;
--      · the catch-all contact 100000 is treated as no contact, like 0, so it files on a numbered holder and
--        never becomes an Archive "doctor";
--      · an Archive customer whose speciality is pharmacy is list 'Pharmacy', whatever the assignment or the
--        AM/PM majority says;
--      · rows group by rep too: on a seat with two occupants the earlier visit to a customer that day is
--        written, and the later one stays unmapped, so the List's old-system line keeps counting it;
--      · a visit is kept only if he held THIS seat that day, or held no seat at all and it is a campaign visit.
--   2. public.phoenix_crm_rep_entry_days_on_visit (20261023091035, md5 9c9b19c5285cb6bd1676401218ab650b) skips a
--      copied visit: dated before its team's start, it can never be an entry day.
--   3. public.phoenix_crm_edit_visit_detail refuses a copied visit (phoenix_crm:visit_is_history). Built on the
--      body read off production (md5 0d1f0ab13e759d9ec0448c302b733681), which equals 20261015110300's.
-- WHY: Code review of #6676, 2026-10-31; the owner asked for its findings to be applied, 2026-11-01. Rows the
--   first run already wrote are NOT repaired here: that is a bulk production change and needs its own word.
--   Account: docs/phoenix-crm-ireports360-history-import.md.
-- ROLLBACK: re-create each function from the file named above. Nothing else changes.
-- SAFE: every DROP TABLE in this file is a `pg_temp.` one — the import's own scratch tables.

-- 1. The copy --------------------------------------------------------------------------------------------

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

  -- The partner is judged by app role, as the visit form offers people (visit-ask-rules.ts): an active
  -- login first, never a test persona.
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
    -- 0 is no contact, and 100000 is the vendor's catch-all, which names nobody either.
    nullif(nullif(iv.contact_crm_id, 0), 100000) as contact_crm_id,
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
    cust.id as customer_id,
    cust.list_type as customer_list_type,
    exists (
      select 1 from public.phoenix_crm_imported_visit_sources s where s.crm_visit_id = iv.crm_visit_id
    ) as already_imported
  from cur c
  join st on st.seat_id = c.seat_id
  join public.ireports360_visits iv on lower(iv.agent_hr_id) = c.hr
  left join lateral (
    select
      pe.hr_id,
      -- Anyone the visit form would not offer as a companion (a peer rep, say) is not a partner at all.
      case
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
      and nullif(nullif(iv.contact_crm_id, 0), 100000) is not null
      and (
        cu.reference_contact_crm_id = iv.contact_crm_id
        or cu.id in (select l.customer_id from phx_import_links l where l.contact_crm_id = iv.contact_crm_id)
      )
    order by (cu.reference_contact_crm_id is not distinct from iv.contact_crm_id) desc, cu.created_at, cu.id
    limit 1
  ) cust on true
  where iv.visit_type in (0, -8)
    and iv.visit_date >= date '2026-01-01'
    and iv.visit_date < st.starts_on
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
  -- old-system line instead of vanishing under the other rep's name.
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
      'mapped', v_mapped
    )
  );
end;
$function$;

revoke execute on function public.phoenix_crm_import_ireports360_history(text, boolean) from public, anon, authenticated;
grant execute on function public.phoenix_crm_import_ireports360_history(text, boolean) to service_role;

-- 2. The entry-days trigger ------------------------------------------------------------------------------
-- It fires per row and cannot carry a WHEN clause (it is AFTER INSERT OR UPDATE OR DELETE), so the skip is here.

create or replace function public.phoenix_crm_rep_entry_days_on_visit()
 returns trigger
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if old.imported_from_ireports360_at is null then
      perform public.phoenix_crm_rep_entry_days_touch(old.rep_hr_id, old.visit_date);
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    if new.imported_from_ireports360_at is null then
      perform public.phoenix_crm_rep_entry_days_touch(new.rep_hr_id, new.visit_date);
    end if;
  end if;
  return null;
end
$function$;

revoke execute on function public.phoenix_crm_rep_entry_days_on_visit() from public, anon, authenticated;
grant execute on function public.phoenix_crm_rep_entry_days_on_visit() to service_role;

-- 3. The rep's write-up ----------------------------------------------------------------------------------

create or replace function public.phoenix_crm_edit_visit_detail(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid := nullif(p ->> 'visit_id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  -- The long account written afterwards. Empty clears it; the before-image keeps what it said.
  v_detail text := nullif(trim(coalesce(p ->> 'detail_comment', '')), '');
  -- The outcome. Read here and validated below rather than trusted: the only thing the caller may do
  -- with a value it does not recognise is drop it (visit-outcome.ts), and the same holds here.
  v_next_step text := nullif(btrim(p ->> 'next_step'), '');
  v_next_step_on date := nullif(p ->> 'next_step_on', '')::date;
  v_objection text := nullif(btrim(p ->> 'objection'), '');
  v_objection_note text := nullif(regexp_replace(trim(coalesce(p ->> 'objection_note', '')), '\s+', ' ', 'g'), '');
  v_samples jsonb := p -> 'samples_given';
  v_availability jsonb := p -> 'product_availability';
  -- ADD-ONLY (owner, 2026-10-15). Null on the wire whenever he is not adding one.
  v_pharmacy text := nullif(trim(coalesce(p ->> 'pharmacy_name', '')), '');
  v_new_pharmacy text;
  v_visit public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_is_pharmacy boolean;
  -- The pharmacies a NEWLY added name points at, filed as visits of their own, exactly as
  -- phoenix_crm_save_visit files them on the day the rep logs the visit.
  v_links jsonb;
  v_entry jsonb;
  v_entry_name text;
  v_entry_id uuid;
  v_entry_new boolean;
  v_link public.phoenix_crm_customers%rowtype;
  v_link_visit uuid;
  v_link_created boolean;
  v_filed jsonb := '[]'::jsonb;
begin
  if v_id is null or v_seat is null or v_actor is null
    or (v_detail is not null and char_length(v_detail) > 2000)
    or (v_pharmacy is not null and char_length(v_pharmacy) > 120) then
    raise exception 'phoenix_crm:bad_input';
  end if;

  -- The same per-territory lock the rep's own save takes, so a save and an edit cannot interleave.
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select v.* into v_visit
  from public.phoenix_crm_visits v
  where v.id = v_id
    and v.seat_id = v_seat
    and v.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:visit_not_found';
  end if;

  -- HIS OWN VISIT, AND ONLY HIS. A visit a manager entered for himself carries no rep at all; one the
  -- Super Admin entered for a visit the rep missed logging carries the REP, so it is the rep's to
  -- complete — he made the visit, the Super Admin only recorded it.
  if v_visit.rep_hr_id is null or v_visit.rep_hr_id <> v_actor then
    raise exception 'phoenix_crm:visit_not_yours';
  end if;

  -- The pharmacy visit a doctor's visit filed is part of that submission, never a second piece of
  -- work, so its detail belongs to the visit it came from.
  if v_visit.linked_from_visit_id is not null then
    raise exception 'phoenix_crm:visit_is_linked';
  end if;

  -- A visit copied from the old system is history (20261029212200). A pharmacy named on it would file a
  -- linked visit dated before his start and carrying no import mark, which every reader counts as real.
  if v_visit.imported_from_ireports360_at is not null then
    raise exception 'phoenix_crm:visit_is_history';
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_visit.customer_id;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  v_is_pharmacy := v_customer.list_type = 'Pharmacy';

  -- ADD-ONLY. At a pharmacy the pharmacy IS the customer and the column is its name, so there is
  -- nothing to add; on a visit that already names one, changing it would delete the visit that name
  -- filed.
  if v_pharmacy is not null and (v_is_pharmacy or v_visit.pharmacy_name is not null) then
    raise exception 'phoenix_crm:pharmacy_name_fixed';
  end if;
  v_new_pharmacy := coalesce(v_visit.pharmacy_name, v_pharmacy);

  -- An unknown value is DROPPED, never raised — a phone one release behind must not cost a rep the
  -- detail he just typed. The dependants go with their parent, so the row can never say "by 30 Sept"
  -- under "Nothing to follow", or carry a note under "No objection".
  if v_next_step is not null and v_next_step not in ('follow_up', 'send_data', 'arrange_double', 'invite_event', 'pharmacy_stock', 'none') then
    v_next_step := null;
  end if;
  if v_next_step is null or v_next_step = 'none' then
    v_next_step_on := null;
  end if;
  if v_objection is not null and v_objection not in ('price', 'efficacy', 'safety', 'competitor', 'formulary', 'no_time', 'none') then
    v_objection := null;
  end if;
  if v_objection is null or v_objection = 'none' then
    v_objection_note := null;
  else
    v_objection_note := left(v_objection_note, 300);
  end if;

  -- A bag that is not a bag LEAVES WHAT THE VISIT HAS — deliberately NOT save_visit's '{}', which is
  -- that function's default for a brand-new row. Here an empty object is a real instruction ("I left
  -- nothing after all"), so a malformed one must not be read as that instruction and wipe his answers.
  if v_samples is null or jsonb_typeof(v_samples) <> 'object' or (select count(*) from jsonb_object_keys(v_samples)) > 20 then
    v_samples := v_visit.samples_given;
  end if;
  if v_availability is null or jsonb_typeof(v_availability) <> 'object' then
    v_availability := v_visit.product_availability;
  end if;

  -- Nothing different: no copy, no write, and the caller is told so.
  if v_detail is not distinct from v_visit.detail_comment
    and v_next_step is not distinct from v_visit.next_step
    and v_next_step_on is not distinct from v_visit.next_step_on
    and v_objection is not distinct from v_visit.objection
    and v_objection_note is not distinct from v_visit.objection_note
    and v_samples is not distinct from v_visit.samples_given
    and v_availability is not distinct from v_visit.product_availability
    and v_new_pharmacy is not distinct from v_visit.pharmacy_name then
    return jsonb_build_object('visit_id', v_id, 'changed', false, 'linked_pharmacies', '[]'::jsonb);
  end if;

  -- The copy first, so nothing is overwritten that is not already kept.
  insert into public.phoenix_crm_visit_edits (
    visit_id, seat_id, customer_id, visit_date, edited_by_hr_id, is_test, before_edit, after_edit
  )
  values (
    v_visit.id, v_visit.seat_id, v_visit.customer_id, v_visit.visit_date, v_actor, v_visit.is_test,
    jsonb_build_object(
      'detail_comment', v_visit.detail_comment,
      'next_step', v_visit.next_step,
      'next_step_on', v_visit.next_step_on,
      'objection', v_visit.objection,
      'objection_note', v_visit.objection_note,
      'samples_given', v_visit.samples_given,
      'product_availability', v_visit.product_availability,
      'pharmacy_name', v_visit.pharmacy_name
    ),
    jsonb_build_object(
      'detail_comment', v_detail,
      'next_step', v_next_step,
      'next_step_on', v_next_step_on,
      'objection', v_objection,
      'objection_note', v_objection_note,
      'samples_given', v_samples,
      'product_availability', v_availability,
      'pharmacy_name', v_new_pharmacy,
      -- Which door wrote it. The Super Admin's correction writes no such key, so a reader can tell
      -- the two apart without reading the shape of the blob.
      'edited_by', 'rep_detail'
    )
  );

  update public.phoenix_crm_visits
  set detail_comment = v_detail,
      next_step = v_next_step,
      next_step_on = v_next_step_on,
      objection = v_objection,
      objection_note = v_objection_note,
      samples_given = v_samples,
      product_availability = v_availability,
      pharmacy_name = v_new_pharmacy,
      detail_edited_at = now(),
      detail_edited_by_hr_id = v_actor
  where id = v_id;

  -- THE PHARMACY HE JUST NAMED IS A VISIT TO THAT PHARMACY TOO (owner, 2026-10-03), filed exactly as
  -- phoenix_crm_save_visit files it: on the PARENT's day and at the parent's reading, no photo and no
  -- place of its own, one box able to name several, five at most, a name the caller could not place
  -- skipped and never raised, and a pharmacy already visited that day keeping the visit it has.
  if not v_is_pharmacy and v_visit.pharmacy_name is null and v_pharmacy is not null then
    v_links := case
      when jsonb_typeof(p -> 'linked_pharmacies') = 'array' then p -> 'linked_pharmacies'
      else '[]'::jsonb
    end;

    for v_entry in
      select e.value from jsonb_array_elements(v_links) with ordinality as e(value, n) order by e.n limit 5
    loop
      v_entry_name := nullif(trim(coalesce(v_entry ->> 'name', '')), '');
      v_entry_id := case
        when (v_entry ->> 'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (v_entry ->> 'id')::uuid
      end;
      v_entry_new := coalesce((v_entry ->> 'new') = 'true', false);
      v_link := null;
      v_link_visit := null;
      v_link_created := false;
      continue when v_entry_name is null or char_length(v_entry_name) > 120;

      if v_entry_id is not null then
        select c.* into v_link
        from public.phoenix_crm_customers c
        where c.id = v_entry_id
          and c.seat_id = v_seat
          and c.is_test = v_is_test
          and c.list_type = 'Pharmacy'
          and c.status in ('active', 'pending', 'outside');
      elsif v_entry_new then
        -- The caller decided "new" from a read taken before this call, so the name is checked again
        -- here, under the SAME lock phoenix_crm_add_pharmacy takes: two edits naming one new pharmacy,
        -- or an edit racing Add a pharmacy, file one pharmacy, never two rows for it.
        perform pg_advisory_xact_lock(hashtext('phoenix_crm_add_pharmacy|' || v_seat || '|' || v_is_test::text));
        select c.* into v_link
        from public.phoenix_crm_customers c
        where c.seat_id = v_seat
          and c.is_test = v_is_test
          and c.list_type = 'Pharmacy'
          and c.status in ('active', 'pending', 'outside')
          and lower(btrim(regexp_replace(c.name, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(v_entry_name, '\s+', ' ', 'g')))
        order by (c.status = 'active') desc, c.id
        limit 1;
        if v_link.id is null then
          insert into public.phoenix_crm_customers (
            seat_id, line_code, list_type, name, origin, status, created_by_hr_id, is_test, intake_note
          )
          values (
            v_seat, v_customer.line_code, 'Pharmacy', v_entry_name, 'new', 'pending', v_actor, v_is_test,
            left('Added when the visit to ' || v_customer.name || ' named it.', 300)
          )
          returning * into v_link;
          v_link_created := true;
        end if;
      end if;

      if v_link.id is not null then
        insert into public.phoenix_crm_visits (
          id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
          senior_hr_id, product_manager_hr_id, entered_by_hr_id, products, comment, pharmacy_name, product_availability,
          lat, lon, accuracy_meters, place_id, distance_meters, location_flag, is_test,
          is_unplanned, unplanned_kind, samples_given,
          capture_source, time_anchor_id, offline_seconds, synced_at,
          linked_from_visit_id
        )
        values (
          gen_random_uuid(), v_seat, v_visit.line_code, v_link.id, 'Pharmacy', v_visit.visit_date, v_visit.captured_at,
          'single', v_visit.rep_hr_id,
          case when v_visit.rep_hr_id is null then v_visit.manager_hr_id end,
          null, null, v_actor, v_visit.products, null, v_entry_name, '{}'::jsonb,
          v_visit.lat, v_visit.lon, v_visit.accuracy_meters,
          null, null, 'no_place', v_is_test,
          false, null, '{}'::jsonb,
          v_visit.capture_source, null, null, now(),
          v_id
        )
        on conflict (seat_id, customer_id, visit_date, is_test) do nothing
        returning id into v_link_visit;
        v_filed := v_filed || jsonb_build_array(jsonb_build_object(
          'customer_id', v_link.id, 'name', v_link.name, 'visit_id', v_link_visit, 'created', v_link_created
        ));
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'visit_id', v_id,
    'changed', true,
    'detail_edited_at', now(),
    'linked_pharmacies', v_filed
  );
end;
$function$;

revoke execute on function public.phoenix_crm_edit_visit_detail(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_edit_visit_detail(jsonb) to service_role;
