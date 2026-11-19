-- phoenix_crm_customer_type_apart_from_speciality
--
-- WHAT THIS CHANGES:
--   1. A new column `customer_type` on phoenix_crm_customers and phoenix_crm_manager_customers: WHERE you call
--      on the customer (Clinic, Polyclinic, Hospital, Private Hospital, University Hospital, Educational
--      Hospital, Armed Forces Hospital, Police Hospital, Contract, Health Insurance, Educational Institute,
--      Pharmacy, or an "Other" text). `speciality` keeps only a clinic's or a polyclinic's MEDICAL speciality.
--   2. public.phoenix_crm_split_customer_kind(type, speciality, list_type): the one rule that keeps the two
--      apart, the same rule as splitCustomerKind() in src/lib/phoenix-crm/speciality-list.ts —
--        * a speciality naming a place or an account ("Hospital", "Contract", "Pharmacy", "Polyclinics")
--          becomes the type and the speciality is emptied;
--        * a Pharmacy-list customer is type Pharmacy with no speciality;
--        * no type: a medical speciality, or the PM list, means Clinic; an AM customer with neither keeps
--          no type (the rep is asked for it);
--        * only a Clinic or a Polyclinic keeps a speciality.
--      A BEFORE trigger on both tables runs every insert and every write of these columns through it, so
--      the older database functions that still write one `speciality` box (reference seating, imports,
--      restores) are split the same way as the screens.
--   3. The backfill: every row split by that rule. Three "Other" words that are kinds of customer, never
--      specialities — Distributor, Store, Bank — move to the type.
--   4. public.phoenix_crm_customer_kind_label(speciality, type): what the KPI chain classifies a Phoenix
--      customer by — a clinic's speciality, else its type ("Polyclinic" read as "Polyclinics", the name
--      src/lib/crm/contact-taxonomy.ts knows). phoenix_crm_contact_truth_calc, the contact-name row trigger
--      and the Phoenix halves of crm_visits_unified and crm_plan_entries_unified read it in place of the
--      bare speciality, so a hospital stays a place (HCP) on every board after its speciality is emptied.
--      The one deliberate change: a Pharmacy-list customer that had no speciality now reads "Pharmacy"
--      (972 live on 2026-11-19) — a pharmacy is not a contact (owner, 2026-09-01).
-- WHY: the owner, 2026-11-19: "FIRST WE MUST IDENTIFY AND FIX TO BE 0 NO SPECIALITY … SECOND SEPARATE THE
--   SPECIALITY AND THE TYPE, EXAMPLE HOSPITAL IS NOT SPECIALITY .. CLINIC EXAMPLE PEDIA". He then chose, by
--   multiple choice: only clinics (and polyclinics) need a speciality; the hospital kinds stay one by one;
--   the rep is asked for a missing one on his next Edit or visit.
-- ROLLBACK: the pre-image is phoenix_crm_backup_20261119.kind_before (source, id, list_type, speciality),
--   written by this file before the backfill:
--     update public.phoenix_crm_customers c set speciality = b.speciality
--       from phoenix_crm_backup_20261119.kind_before b where b.source = 'customer' and b.id = c.id;
--     update public.phoenix_crm_manager_customers c set speciality = b.speciality
--       from phoenix_crm_backup_20261119.kind_before b where b.source = 'manager_customer' and b.id = c.id;
--   then drop the two triggers, re-create the two views, truth_calc and the contact-name row function from
--   20261119144643's predecessors, and drop the column.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Announced to the owner in plain words before it was applied (bulk: every Phoenix CRM customer row).

begin;

-- ── 0. The pre-image ─────────────────────────────────────────────────────────────────────────────────
create schema if not exists phoenix_crm_backup_20261119;
revoke all on schema phoenix_crm_backup_20261119 from public, anon, authenticated;

create table if not exists phoenix_crm_backup_20261119.kind_before as
  select 'customer'::text as source, c.id, c.list_type, c.speciality, c.reference_contact_crm_id
    from public.phoenix_crm_customers c
  union all
  select 'manager_customer'::text, m.id, null::text, m.speciality, null::bigint
    from public.phoenix_crm_manager_customers m;

-- ── 1. The column ────────────────────────────────────────────────────────────────────────────────────
alter table public.phoenix_crm_customers add column if not exists customer_type text;
alter table public.phoenix_crm_manager_customers add column if not exists customer_type text;

comment on column public.phoenix_crm_customers.customer_type is
  'Where you call on the customer: Clinic, Polyclinic, a hospital kind, Contract, Health Insurance, Educational Institute, Pharmacy, or an Other text. Only Clinic and Polyclinic carry a speciality (owner, 2026-11-19).';
comment on column public.phoenix_crm_manager_customers.customer_type is
  'Where you call on the customer: Clinic, Polyclinic, a hospital kind, Contract, Health Insurance, Educational Institute, Pharmacy, or an Other text. Only Clinic and Polyclinic carry a speciality (owner, 2026-11-19).';

-- ── 2. The rule ──────────────────────────────────────────────────────────────────────────────────────
create or replace function public.phoenix_crm_split_customer_kind(
  p_type text,
  p_speciality text,
  p_list_type text,
  out customer_type text,
  out speciality text
)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_places constant text[] := array[
    'Hospital', 'Private Hospital', 'University Hospital', 'Educational Hospital', 'Armed Forces Hospital',
    'Police Hospital', 'Contract', 'Health Insurance', 'Educational Institute', 'Pharmacy'
  ];
  v_medical constant text[] := array[
    'Internal Medicine', 'Pediatrics', 'ENT', 'Neurology', 'Chest', 'General Practitioner', 'Urology',
    'General Surgery', 'Psychiatry', 'Neuro Surgery', 'Vascular Surgery', 'Gastroenterologist',
    'Ophthalmologist', 'Neuropedia', 'Cardiology', 'NICU', 'Orthopedic Surgery', 'Tropical Medicine',
    'Dermatologist', 'Nephrology'
  ];
  v_named text;
begin
  customer_type := nullif(btrim(p_type), '');
  speciality := nullif(btrim(p_speciality), '');

  if customer_type is not null then
    if lower(customer_type) in ('polyclinic', 'polyclinics', 'poly clinic', 'poly clinics') then
      v_named := 'Polyclinic';
    elsif lower(customer_type) in ('clinic', 'clinics') then
      v_named := 'Clinic';
    else
      select x into v_named from unnest(v_places) x where lower(x) = lower(customer_type);
    end if;
    customer_type := coalesce(v_named, customer_type);
  end if;

  if speciality is not null then
    v_named := null;
    if lower(speciality) in ('polyclinic', 'polyclinics', 'poly clinic', 'poly clinics') then
      v_named := 'Polyclinic';
    else
      select x into v_named from unnest(v_places) x where lower(x) = lower(speciality);
    end if;
    if v_named is not null then
      if customer_type is null or customer_type = 'Clinic' then
        customer_type := v_named;
      end if;
      speciality := null;
    end if;
  end if;

  if p_list_type = 'Pharmacy' then
    customer_type := 'Pharmacy';
    speciality := null;
    return;
  end if;

  if customer_type is null
     and (p_list_type = 'PM'
          or (speciality is not null and exists (select 1 from unnest(v_medical) m where lower(m) = lower(speciality)))) then
    customer_type := 'Clinic';
  end if;

  if customer_type is not null and customer_type not in ('Clinic', 'Polyclinic') then
    speciality := null;
  end if;
end
$$;

comment on function public.phoenix_crm_split_customer_kind(text, text, text) is
  'Keeps a Phoenix CRM customer''s type and medical speciality apart. Same rule as splitCustomerKind() in src/lib/phoenix-crm/speciality-list.ts (owner, 2026-11-19).';

create or replace function public.phoenix_crm_customer_kind_apart()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_split record;
begin
  select * into v_split
    from public.phoenix_crm_split_customer_kind(
      new.customer_type,
      new.speciality,
      case when tg_table_name = 'phoenix_crm_customers' then to_jsonb(new) ->> 'list_type' end
    );
  new.customer_type := v_split.customer_type;
  new.speciality := v_split.speciality;
  return new;
end
$$;

revoke execute on function public.phoenix_crm_customer_kind_apart() from public, anon, authenticated;

-- ── 3. The label the KPI chain classifies by ─────────────────────────────────────────────────────────
-- The two views below write the same CASE inline rather than call this: a function with a SET clause is
-- never inlined by the planner, and one without it is an advisor finding (.claude/rules/database.md).
create or replace function public.phoenix_crm_customer_kind_label(p_speciality text, p_customer_type text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
           when nullif(btrim(p_customer_type), '') is null or p_customer_type = 'Clinic' then nullif(btrim(p_speciality), '')
           when p_customer_type = 'Polyclinic' then 'Polyclinics'
           else p_customer_type
         end
$$;

comment on function public.phoenix_crm_customer_kind_label(text, text) is
  'What the KPI chain classifies a Phoenix CRM customer by: a clinic''s speciality, else its type (owner, 2026-11-19).';

-- ── 4. The backfill ──────────────────────────────────────────────────────────────────────────────────
-- The per-row truth refresh is held while every row is split and run once below, for the contacts whose
-- label moved; a row-by-row refresh of every customer is what would make this file slow.
alter table public.phoenix_crm_customers disable trigger phoenix_crm_contact_truth_customer;

update public.phoenix_crm_customers c
   set customer_type = s.customer_type,
       speciality = s.speciality
  from (
    select x.id, k.customer_type, k.speciality
      from public.phoenix_crm_customers x
      cross join lateral public.phoenix_crm_split_customer_kind(
        case when x.speciality in ('Distributor', 'Store', 'Bank') then x.speciality else x.customer_type end,
        case when x.speciality in ('Distributor', 'Store', 'Bank') then null else x.speciality end,
        x.list_type
      ) k
  ) s
 where s.id = c.id
   and (c.customer_type, c.speciality) is distinct from (s.customer_type, s.speciality);

update public.phoenix_crm_manager_customers c
   set customer_type = s.customer_type,
       speciality = s.speciality
  from (
    select x.id, k.customer_type, k.speciality
      from public.phoenix_crm_manager_customers x
      cross join lateral public.phoenix_crm_split_customer_kind(
        case when x.speciality in ('Distributor', 'Store', 'Bank') then x.speciality else x.customer_type end,
        case when x.speciality in ('Distributor', 'Store', 'Bank') then null else x.speciality end,
        null
      ) k
  ) s
 where s.id = c.id
   and (c.customer_type, c.speciality) is distinct from (s.customer_type, s.speciality);

alter table public.phoenix_crm_customers enable trigger phoenix_crm_contact_truth_customer;

-- Each trigger is replaced in place (PostgreSQL 14+), never dropped and re-created: a drop leaves the table
-- without it for an instant. Reshaped so on 19 Nov 2026 after the apply; the end state is the same.
create or replace trigger phoenix_crm_customers_kind_apart
  before insert or update of speciality, customer_type, list_type on public.phoenix_crm_customers
  for each row execute function public.phoenix_crm_customer_kind_apart();

create or replace trigger phoenix_crm_manager_customers_kind_apart
  before insert or update of speciality, customer_type on public.phoenix_crm_manager_customers
  for each row execute function public.phoenix_crm_customer_kind_apart();

-- ── 5. The KPI chain reads the label ─────────────────────────────────────────────────────────────────
create or replace function public.phoenix_crm_contact_truth_calc(p_contact_crm_id bigint default null::bigint)
returns table(contact_crm_id bigint, name text, speciality text)
language sql
stable security definer
set search_path to 'public'
as $function$
  select distinct on (c.reference_contact_crm_id)
         c.reference_contact_crm_id as contact_crm_id,
         nullif(btrim(c.name), '') as name,
         public.phoenix_crm_customer_kind_label(c.speciality, c.customer_type) as speciality
    from public.phoenix_crm_customers c
   where c.reference_contact_crm_id is not null
     and c.validated_at is not null
     and not c.is_test
     and c.status = any (array['active', 'pending', 'dropped'])
     and (p_contact_crm_id is null or c.reference_contact_crm_id = p_contact_crm_id)
   order by c.reference_contact_crm_id, (c.status = 'active') desc, c.validated_at desc, c.updated_at desc
$function$;

revoke execute on function public.phoenix_crm_contact_truth_calc(bigint) from public, anon, authenticated;
grant execute on function public.phoenix_crm_contact_truth_calc(bigint) to service_role;

create or replace function public.phoenix_crm_customers_write_contact_name_row()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  insert into public.crm_contacts as c (
    contact_crm_id, name, speciality, phone, source, first_seen_on
  )
  values (
    coalesce(new.reference_contact_crm_id, new.own_contact_crm_id),
    nullif(btrim(new.name), ''),
    public.phoenix_crm_customer_kind_label(new.speciality, new.customer_type),
    nullif(btrim(new.phone), ''),
    'phoenix',
    least((new.created_at at time zone 'Africa/Cairo')::date, (now() at time zone 'Africa/Cairo')::date)
  )
  on conflict (contact_crm_id) do update set
         -- Phoenix's value replaces the one on file; a blank offered keeps what is there.
         name = coalesce(excluded.name, c.name),
         speciality = coalesce(excluded.speciality, c.speciality),
         phone = coalesce(excluded.phone, c.phone),
         first_seen_on = least(c.first_seen_on, excluded.first_seen_on),
         updated_at = now()
   where (c.name, c.speciality, c.phone) is distinct from
         (coalesce(excluded.name, c.name), coalesce(excluded.speciality, c.speciality), coalesce(excluded.phone, c.phone))
      or c.first_seen_on > excluded.first_seen_on;
  return null;
end
$function$;

create or replace trigger phoenix_crm_customers_write_contact_name_row
  after insert or update of status, name, speciality, customer_type, phone
  on public.phoenix_crm_customers
  for each row
  when (new.reference_contact_crm_id is null and not new.is_test and new.status in ('active', 'pending', 'dropped')
        and not new.campaign_visit_holder)
  execute function public.phoenix_crm_customers_write_contact_name_row();

-- The two unified views: only the Phoenix customer's speciality expression changes, to the label's CASE
-- written inline (the same expression as phoenix_crm_customer_kind_label). Each is rebuilt from
-- its own live definition with one exact replacement, and the file stops if that text is not found once.
do $$
declare
  v_view text;
  v_old text;
  v_new text;
  v_def text;
  v_opts text[];
begin
  foreach v_view in array array['crm_visits_unified', 'crm_plan_entries_unified'] loop
    v_def := pg_get_viewdef(('public.' || v_view)::regclass);
    select reloptions into v_opts from pg_class where oid = ('public.' || v_view)::regclass;
    if v_view = 'crm_visits_unified' then
      v_old := E'    customer.speciality,\n    customer.grade AS crm_contact_grade,';
      v_new := E'    CASE WHEN NULLIF(btrim(customer.customer_type), ''''::text) IS NULL OR customer.customer_type = ''Clinic''::text THEN NULLIF(btrim(customer.speciality), ''''::text) WHEN customer.customer_type = ''Polyclinic''::text THEN ''Polyclinics''::text ELSE customer.customer_type END AS speciality,\n    customer.grade AS crm_contact_grade,';
    else
      v_old := E'            c.grade,\n            c.speciality\n           FROM phoenix_crm_customers c';
      v_new := E'            c.grade,\n            CASE WHEN NULLIF(btrim(c.customer_type), ''''::text) IS NULL OR c.customer_type = ''Clinic''::text THEN NULLIF(btrim(c.speciality), ''''::text) WHEN c.customer_type = ''Polyclinic''::text THEN ''Polyclinics''::text ELSE c.customer_type END AS speciality\n           FROM phoenix_crm_customers c';
    end if;
    if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
      raise exception '% does not hold the expected speciality text exactly once', v_view;
    end if;
    execute format('create or replace view public.%I as %s', v_view, replace(v_def, v_old, v_new));
    if v_opts is not null then
      execute format('alter view public.%I set (%s)', v_view, array_to_string(v_opts, ', '));
    end if;
  end loop;
end
$$;

-- ── 6. The contacts whose label moved get their truth refreshed once ────────────────────────────────
select public.phoenix_crm_contact_truth_touch(t.reference_contact_crm_id)
  from (
    select distinct c.reference_contact_crm_id
      from public.phoenix_crm_customers c
      join phoenix_crm_backup_20261119.kind_before b on b.source = 'customer' and b.id = c.id
     where c.reference_contact_crm_id is not null
       and public.phoenix_crm_customer_kind_label(c.speciality, c.customer_type) is distinct from nullif(btrim(b.speciality), '')
  ) t;

commit;
