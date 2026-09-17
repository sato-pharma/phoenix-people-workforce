-- Phoenix CRM — the field force's own customer list, weekly plan, visits and reports.
--
-- Owner, 2026-09-16 ("proceed building"): a clean new module, built from scratch for heavy daily use,
-- with its own native reports — never wired into the old CRM (iReports360) or into the 2026-09-13
-- pilot's crm_native_* tables, which this migration does not touch.
--
--   * The list belongs to the TERRITORY (the REP seat), so the next rep inherits the customers, their
--     places, timings and visit history. iReports360's list is a REFERENCE only.
--   * A customer is validated only with a live photo (the clinic sign or door), the location captured
--     on the spot, and at least one timing. Timings belong to a place; a doctor in two places has two.
--   * A new customer's grade: the rep proposes, the district manager approves. A drop needs a reason
--     and the district manager's approval. The list is ready (weekly plans start) when every reference
--     customer is validated or dropped — measured once; a seat stays ready.
--   * The weekly plan: the district manager approves, the SFE Manager can return one, the system
--     never approves. At most 15 PM doctors and 5 AM accounts a plan day (settings, checked by the app).
--   * A visit records a location check, the products discussed, a live photo and a comment. A double
--     visit (rep + district manager) and a chain visit (+ a regional or national manager) count for
--     everyone on them straight away. A visit far from the place still saves, flagged.
--   * The Super Admin's try-out entries are is_test rows, excluded from every report by default.
--
-- Photos never pass through the app: the server issues one upload path per photo
-- (phoenix_crm_photo_uploads), the phone uploads straight to the private bucket, and a save refuses a
-- path the server did not issue to that person for that territory, a path already used, a slot older
-- than 12 hours, or an object that never arrived. The capture time is the server's issue time.
--
-- Access is application-scoped: every table is service-role only (RLS on, nothing granted to anon or
-- authenticated), and every function is SECURITY DEFINER, executable by service_role only. Who may do
-- what (rep, reviewer, SFE, Super Admin test mode, downward scope) is decided in
-- src/lib/phoenix-crm/server/ before any of these functions is called.
--
-- Errors are raised as 'phoenix_crm:<code>' (SQLSTATE P0001); the service maps each code to a
-- sentence the rep can act on.
--
-- Rollback (nothing else reads these objects; photos in the bucket are kept unless deleted by hand):
--   begin;
--   drop function if exists public.phoenix_crm_report_manager_visits(text[], date, date, boolean);
--   drop function if exists public.phoenix_crm_report_coverage(text[], date, boolean);
--   drop function if exists public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean);
--   drop function if exists public.phoenix_crm_report_visits_by_day(text[], date, date, boolean);
--   drop function if exists public.phoenix_crm_save_visit(jsonb);
--   drop function if exists public.phoenix_crm_plan_transition(jsonb);
--   drop function if exists public.phoenix_crm_save_plan(jsonb);
--   drop function if exists public.phoenix_crm_decide_request(jsonb);
--   drop function if exists public.phoenix_crm_withdraw_request(jsonb);
--   drop function if exists public.phoenix_crm_create_request(jsonb);
--   drop function if exists public.phoenix_crm_update_place(jsonb);
--   drop function if exists public.phoenix_crm_add_place(jsonb);
--   drop function if exists public.phoenix_crm_validate_customer(jsonb);
--   drop function if exists public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb);
--   drop function if exists public.phoenix_crm_take_photo(text, text, text, text, boolean);
--   drop function if exists public.phoenix_crm_seat_readiness(text[], boolean);
--   drop function if exists public.phoenix_crm_seat_reference(text[], boolean);
--   drop table if exists public.phoenix_crm_visits, public.phoenix_crm_plan_events,
--     public.phoenix_crm_plan_items, public.phoenix_crm_plans, public.phoenix_crm_list_events,
--     public.phoenix_crm_list_requests, public.phoenix_crm_places, public.phoenix_crm_customers,
--     public.phoenix_crm_photo_uploads, public.phoenix_crm_territory_readiness,
--     public.phoenix_crm_ramadan_overrides, public.phoenix_crm_line_rollout, public.phoenix_crm_settings;
--   drop policy if exists phoenix_crm_photos_service_role on storage.objects;
--   commit;
-- SAFE: the DROP TABLE lines above are the commented rollback only; this migration drops no table.
--
-- Verification after apply:
--   select count(*) from pg_class where relname like 'phoenix_crm_%' and relkind = 'r';          -- 13
--   select proname, prosecdef from pg_proc where proname like 'phoenix_crm_%' order by 1;         -- 17, all t
--   select grantee, privilege_type from information_schema.role_routine_grants
--    where routine_name like 'phoenix_crm_%' and grantee in ('anon','authenticated','PUBLIC');   -- 0 rows
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'phoenix-crm-photos';
--   select * from public.phoenix_crm_settings;                                                    -- 1 row, 15 / 5

begin;

-- ── 1. Settings, line opening dates, Ramadan overrides ───────────────────────────────────────────

create table if not exists public.phoenix_crm_settings (
  id smallint primary key default 1,
  pm_daily_cap integer not null default 15,
  am_daily_cap integer not null default 5,
  far_apart_km numeric(6, 1) not null default 10,
  visit_far_meters integer not null default 300,
  weak_gps_meters integer not null default 100,
  -- PM A 3 · B 2 · C 1, AM A 1 with B and C unscored (DEFAULT_REP_KPI_STANDARDS, owner 2026-09-06).
  grade_targets jsonb not null default '{"PM":{"A":3,"B":2,"C":1},"AM":{"A":1,"B":null,"C":null}}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by_hr_id text,
  constraint phoenix_crm_settings_single_row check (id = 1),
  constraint phoenix_crm_settings_pm_cap check (pm_daily_cap between 1 and 60),
  constraint phoenix_crm_settings_am_cap check (am_daily_cap between 1 and 60),
  constraint phoenix_crm_settings_far_apart check (far_apart_km > 0 and far_apart_km <= 500),
  constraint phoenix_crm_settings_visit_far check (visit_far_meters between 50 and 20000),
  constraint phoenix_crm_settings_weak_gps check (weak_gps_meters between 10 and 5000),
  constraint phoenix_crm_settings_grade_targets_shape check (
    jsonb_typeof(grade_targets) = 'object'
    and jsonb_typeof(grade_targets -> 'PM') = 'object'
    and jsonb_typeof(grade_targets -> 'AM') = 'object'
  )
);

insert into public.phoenix_crm_settings (id) values (1) on conflict (id) do nothing;

-- A line's reps see the module from opens_on (Cairo date). No row, or a null date, = not opened yet.
create table if not exists public.phoenix_crm_line_rollout (
  line_code text primary key,
  opens_on date,
  updated_at timestamptz not null default now(),
  updated_by_hr_id text,
  constraint phoenix_crm_line_rollout_code check (line_code ~ '^[a-z_]{2,40}$')
);

-- The Umm al-Qura dates live in code (calendar.ts); a row here shifts one year for the moon sighting.
create table if not exists public.phoenix_crm_ramadan_overrides (
  hijri_year integer primary key,
  starts_on date not null,
  ends_on date not null,
  updated_at timestamptz not null default now(),
  updated_by_hr_id text,
  constraint phoenix_crm_ramadan_overrides_year check (hijri_year between 1440 and 1500),
  constraint phoenix_crm_ramadan_overrides_span check (ends_on >= starts_on and ends_on - starts_on between 27 and 30)
);

-- ── 2. The territory's customers and their places ────────────────────────────────────────────────

create table if not exists public.phoenix_crm_customers (
  id uuid primary key default gen_random_uuid(),
  -- The territory: an au.seats REP seat. The list stays with it when the rep changes.
  seat_id text not null,
  line_code text not null,
  list_type text not null,
  name text not null,
  speciality text,
  grade text,
  origin text not null,
  reference_contact_crm_id bigint,
  status text not null default 'active',
  -- Null only for a reference customer dropped before it was ever validated.
  validated_at timestamptz,
  validated_by_hr_id text,
  dropped_reason text,
  dropped_note text,
  status_changed_at timestamptz not null default now(),
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_customers_list_type check (list_type in ('AM', 'PM')),
  constraint phoenix_crm_customers_name check (char_length(name) between 1 and 200),
  constraint phoenix_crm_customers_speciality check (speciality is null or char_length(speciality) <= 120),
  constraint phoenix_crm_customers_grade check (grade is null or grade in ('A', 'B', 'C')),
  constraint phoenix_crm_customers_origin check (origin in ('reference', 'new')),
  constraint phoenix_crm_customers_origin_reference check ((origin = 'reference') = (reference_contact_crm_id is not null)),
  constraint phoenix_crm_customers_status check (status in ('active', 'dropped')),
  constraint phoenix_crm_customers_active_is_validated check (status <> 'active' or validated_at is not null),
  constraint phoenix_crm_customers_dropped_has_reason check (status <> 'dropped' or dropped_reason is not null)
);

create unique index if not exists phoenix_crm_customers_reference_uidx
  on public.phoenix_crm_customers (seat_id, reference_contact_crm_id, is_test)
  where reference_contact_crm_id is not null;
create index if not exists phoenix_crm_customers_seat_idx
  on public.phoenix_crm_customers (seat_id, is_test, status, list_type);

create table if not exists public.phoenix_crm_places (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.phoenix_crm_customers (id),
  seat_id text not null,
  label text,
  address text,
  brick_id text,
  brick_name text,
  zone text,
  lat double precision not null,
  lon double precision not null,
  accuracy_meters numeric(8, 1),
  -- [{weekday 0=Sun..6=Sat, startMinute, endMinute|null, season normal|ramadan}] — shape checked by
  -- src/lib/phoenix-crm/timings.ts before every write.
  timings jsonb not null,
  photo_path text not null,
  captured_at timestamptz not null,
  device_skew_minutes integer,
  status text not null default 'active',
  retired_at timestamptz,
  retired_by_hr_id text,
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Egypt's field range, the same bounds as src/lib/crm/checkin-coords.ts.
  constraint phoenix_crm_places_lat check (lat between 21.5 and 32),
  constraint phoenix_crm_places_lon check (lon between 24 and 37.5),
  constraint phoenix_crm_places_accuracy check (accuracy_meters is null or accuracy_meters >= 0),
  constraint phoenix_crm_places_timings check (jsonb_typeof(timings) = 'array' and jsonb_array_length(timings) between 1 and 60),
  constraint phoenix_crm_places_label check (label is null or char_length(label) <= 200),
  constraint phoenix_crm_places_address check (address is null or char_length(address) <= 200),
  constraint phoenix_crm_places_zone check (zone is null or char_length(zone) <= 80),
  constraint phoenix_crm_places_status check (status in ('active', 'retired'))
);

create unique index if not exists phoenix_crm_places_photo_uidx on public.phoenix_crm_places (photo_path);
create index if not exists phoenix_crm_places_customer_idx on public.phoenix_crm_places (customer_id, status);
create index if not exists phoenix_crm_places_seat_idx on public.phoenix_crm_places (seat_id, is_test, status);

-- One row per upload path the server issued. A save consumes it once.
create table if not exists public.phoenix_crm_photo_uploads (
  path text primary key,
  issued_to_hr_id text not null,
  seat_id text not null,
  purpose text not null,
  is_test boolean not null default false,
  issued_at timestamptz not null default now(),
  used_at timestamptz,
  constraint phoenix_crm_photo_uploads_path check (char_length(path) between 10 and 200),
  constraint phoenix_crm_photo_uploads_purpose check (purpose in ('place', 'visit'))
);

create index if not exists phoenix_crm_photo_uploads_person_idx
  on public.phoenix_crm_photo_uploads (issued_to_hr_id, issued_at desc);

-- ── 3. Grade and drop requests, and the list's audit trail ───────────────────────────────────────

create table if not exists public.phoenix_crm_list_requests (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text not null,
  kind text not null,
  -- Null while a drop of a reference customer that was never validated waits; filled on approval.
  customer_id uuid references public.phoenix_crm_customers (id),
  reference_contact_crm_id bigint,
  list_type text not null,
  customer_name text not null,
  current_grade text,
  proposed_grade text,
  drop_reason text,
  note text,
  status text not null default 'pending',
  requested_by_hr_id text not null,
  requested_at timestamptz not null default now(),
  decided_by_hr_id text,
  decided_at timestamptz,
  decision_note text,
  is_test boolean not null default false,
  constraint phoenix_crm_list_requests_kind check (kind in ('grade', 'drop')),
  constraint phoenix_crm_list_requests_subject check (customer_id is not null or reference_contact_crm_id is not null),
  constraint phoenix_crm_list_requests_list_type check (list_type in ('AM', 'PM')),
  constraint phoenix_crm_list_requests_current_grade check (current_grade is null or current_grade in ('A', 'B', 'C')),
  constraint phoenix_crm_list_requests_proposed_grade check (proposed_grade is null or proposed_grade in ('A', 'B', 'C')),
  constraint phoenix_crm_list_requests_drop_reason check (
    drop_reason is null or drop_reason in ('moved', 'retired', 'closed', 'not_target', 'duplicate', 'other')
  ),
  constraint phoenix_crm_list_requests_kind_fields check (
    (kind = 'grade') = (proposed_grade is not null) and (kind = 'drop') = (drop_reason is not null)
  ),
  constraint phoenix_crm_list_requests_other_needs_note check (drop_reason is distinct from 'other' or note is not null),
  constraint phoenix_crm_list_requests_note check (note is null or char_length(note) <= 500),
  constraint phoenix_crm_list_requests_status check (status in ('pending', 'approved', 'refused', 'withdrawn')),
  constraint phoenix_crm_list_requests_decided check ((status = 'pending') = (decided_at is null)),
  constraint phoenix_crm_list_requests_decision_note check (decision_note is null or char_length(decision_note) <= 500)
);

-- One pending request of a kind per customer (or per reference customer not yet validated).
create unique index if not exists phoenix_crm_list_requests_one_pending_uidx
  on public.phoenix_crm_list_requests (
    seat_id, kind, (coalesce(customer_id::text, 'contact:' || reference_contact_crm_id::text)), is_test
  )
  where status = 'pending';
create index if not exists phoenix_crm_list_requests_seat_idx on public.phoenix_crm_list_requests (seat_id, status);
create index if not exists phoenix_crm_list_requests_pending_idx
  on public.phoenix_crm_list_requests (requested_at)
  where status = 'pending';
create index if not exists phoenix_crm_list_requests_customer_idx
  on public.phoenix_crm_list_requests (customer_id)
  where customer_id is not null;

create table if not exists public.phoenix_crm_list_events (
  id bigint generated always as identity primary key,
  seat_id text not null,
  customer_id uuid,
  place_id uuid,
  request_id uuid,
  event_type text not null,
  actor_hr_id text not null,
  details jsonb not null default '{}'::jsonb,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists phoenix_crm_list_events_seat_idx on public.phoenix_crm_list_events (seat_id, created_at desc);
create index if not exists phoenix_crm_list_events_customer_idx
  on public.phoenix_crm_list_events (customer_id, created_at desc)
  where customer_id is not null;

-- Stamped once, the first time every reference customer of the seat is validated or dropped. The
-- seat stays ready: reference customers the nightly scrape adds later show as "to validate" without
-- closing plans again.
create table if not exists public.phoenix_crm_territory_readiness (
  seat_id text primary key,
  ready_at timestamptz not null default now(),
  reference_total integer not null,
  validated integer not null,
  dropped integer not null
);

-- ── 4. Weekly plans ──────────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_plans (
  id uuid primary key default gen_random_uuid(),
  seat_id text not null,
  line_code text not null,
  -- The field week starts on Saturday (Saturday–Wednesday, plus Thursday morning for accounts).
  week_start date not null,
  status text not null default 'draft',
  version integer not null default 1,
  submitted_at timestamptz,
  submitted_by_hr_id text,
  decided_at timestamptz,
  decided_by_hr_id text,
  decided_by_role text,
  decision_note text,
  created_by_hr_id text not null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_plans_saturday check (extract(isodow from week_start) = 6),
  constraint phoenix_crm_plans_status check (status in ('draft', 'submitted', 'approved', 'returned')),
  constraint phoenix_crm_plans_version check (version >= 1),
  constraint phoenix_crm_plans_decision_note check (decision_note is null or char_length(decision_note) <= 500),
  constraint phoenix_crm_plans_seat_week_uniq unique (seat_id, week_start, is_test)
);

create index if not exists phoenix_crm_plans_review_idx on public.phoenix_crm_plans (status, week_start);
create index if not exists phoenix_crm_plans_week_idx on public.phoenix_crm_plans (week_start, is_test);

create table if not exists public.phoenix_crm_plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.phoenix_crm_plans (id),
  plan_date date not null,
  customer_id uuid not null references public.phoenix_crm_customers (id),
  place_id uuid not null references public.phoenix_crm_places (id),
  list_type text not null,
  -- Whether the place receives visits that weekday; off-day placements carry an exception reason.
  receives boolean not null,
  start_minute integer,
  exception_type text,
  exception_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_plan_items_list_type check (list_type in ('AM', 'PM')),
  constraint phoenix_crm_plan_items_start check (start_minute is null or start_minute between 0 and 1439),
  constraint phoenix_crm_plan_items_exception_type check (
    exception_type is null or exception_type in ('another_place', 'by_appointment', 'timings_changed', 'other')
  ),
  constraint phoenix_crm_plan_items_exception check (
    (receives and exception_type is null and exception_note is null) or (not receives and exception_type is not null)
  ),
  constraint phoenix_crm_plan_items_other_needs_note check (exception_type is distinct from 'other' or exception_note is not null),
  constraint phoenix_crm_plan_items_note check (exception_note is null or char_length(exception_note) <= 300),
  constraint phoenix_crm_plan_items_one_a_day unique (plan_id, plan_date, customer_id)
);

create index if not exists phoenix_crm_plan_items_customer_idx on public.phoenix_crm_plan_items (customer_id, plan_date);

create table if not exists public.phoenix_crm_plan_events (
  id bigint generated always as identity primary key,
  plan_id uuid not null references public.phoenix_crm_plans (id),
  event_type text not null,
  actor_hr_id text not null,
  actor_role text,
  from_status text,
  to_status text,
  version integer,
  note text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_plan_events_type check (event_type in ('created', 'saved', 'submitted', 'reopened', 'approved', 'returned'))
);

create index if not exists phoenix_crm_plan_events_plan_idx on public.phoenix_crm_plan_events (plan_id, created_at);

-- ── 5. Visits ────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.phoenix_crm_visits (
  -- Generated on the phone, so a retried save can never enter the visit twice.
  id uuid primary key,
  seat_id text not null,
  line_code text not null,
  customer_id uuid not null references public.phoenix_crm_customers (id),
  list_type text not null,
  -- The Cairo date of captured_at.
  visit_date date not null,
  -- The server's time when it issued the photo's upload path.
  captured_at timestamptz not null,
  kind text not null,
  rep_hr_id text,
  manager_hr_id text,
  senior_hr_id text,
  entered_by_hr_id text not null,
  products text[] not null,
  comment text,
  photo_path text not null,
  lat double precision not null,
  lon double precision not null,
  accuracy_meters numeric(8, 1),
  place_id uuid references public.phoenix_crm_places (id),
  distance_meters integer,
  location_flag text not null,
  device_skew_minutes integer,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint phoenix_crm_visits_list_type check (list_type in ('AM', 'PM')),
  constraint phoenix_crm_visits_kind check (kind in ('single', 'double', 'chain')),
  -- single = one person (the rep, or a manager alone) · double = rep + district manager ·
  -- chain = rep + district manager + a regional or national manager.
  constraint phoenix_crm_visits_participants check (
    (kind = 'single' and senior_hr_id is null and ((rep_hr_id is null) <> (manager_hr_id is null)))
    or (kind = 'double' and rep_hr_id is not null and manager_hr_id is not null and senior_hr_id is null)
    or (kind = 'chain' and rep_hr_id is not null and manager_hr_id is not null and senior_hr_id is not null)
  ),
  constraint phoenix_crm_visits_distinct_people check (
    (rep_hr_id is null or manager_hr_id is null or rep_hr_id <> manager_hr_id)
    and (senior_hr_id is null or (senior_hr_id <> coalesce(rep_hr_id, '') and senior_hr_id <> coalesce(manager_hr_id, '')))
  ),
  constraint phoenix_crm_visits_products check (cardinality(products) between 1 and 12),
  constraint phoenix_crm_visits_comment check (comment is null or char_length(comment) <= 1000),
  constraint phoenix_crm_visits_lat check (lat between 21.5 and 32),
  constraint phoenix_crm_visits_lon check (lon between 24 and 37.5),
  constraint phoenix_crm_visits_accuracy check (accuracy_meters is null or accuracy_meters >= 0),
  constraint phoenix_crm_visits_distance check (distance_meters is null or distance_meters >= 0),
  constraint phoenix_crm_visits_location_flag check (location_flag in ('ok', 'far', 'weak_gps', 'no_place')),
  constraint phoenix_crm_visits_one_a_day unique (seat_id, customer_id, visit_date, is_test)
);

create unique index if not exists phoenix_crm_visits_photo_uidx on public.phoenix_crm_visits (photo_path);
create index if not exists phoenix_crm_visits_seat_day_idx on public.phoenix_crm_visits (seat_id, visit_date);
create index if not exists phoenix_crm_visits_day_idx on public.phoenix_crm_visits (visit_date, is_test);
create index if not exists phoenix_crm_visits_customer_idx on public.phoenix_crm_visits (customer_id, visit_date);
create index if not exists phoenix_crm_visits_manager_idx
  on public.phoenix_crm_visits (manager_hr_id, visit_date)
  where manager_hr_id is not null;
create index if not exists phoenix_crm_visits_senior_idx
  on public.phoenix_crm_visits (senior_hr_id, visit_date)
  where senior_hr_id is not null;

-- ── 6. Service role only ─────────────────────────────────────────────────────────────────────────

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'phoenix_crm_settings', 'phoenix_crm_line_rollout', 'phoenix_crm_ramadan_overrides',
    'phoenix_crm_customers', 'phoenix_crm_places', 'phoenix_crm_photo_uploads',
    'phoenix_crm_list_requests', 'phoenix_crm_list_events', 'phoenix_crm_territory_readiness',
    'phoenix_crm_plans', 'phoenix_crm_plan_items', 'phoenix_crm_plan_events', 'phoenix_crm_visits'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('drop policy if exists %I on public.%I', v_table || '_service_role', v_table);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      v_table || '_service_role', v_table
    );
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant all on table public.%I to service_role', v_table);
  end loop;
end
$$;

-- ── 7. The photo bucket (private, JPEG only, 2 MB) ───────────────────────────────────────────────

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('phoenix-crm-photos', 'phoenix-crm-photos', false, 2097152, array['image/jpeg'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists phoenix_crm_photos_service_role on storage.objects';
    execute $policy$
      create policy phoenix_crm_photos_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'phoenix-crm-photos')
      with check (bucket_id = 'phoenix-crm-photos')
    $policy$;
  end if;
end
$$;

-- ── 8. The reference list and readiness ──────────────────────────────────────────────────────────

-- A seat's iReports360 reference list, one row per AM/PM contact, with where the territory stands on
-- it (p_is_test picks the real list or the Super Admin's try-out list).
--
-- Whose list: the seat's latest occupant who has one — the current occupant first, else the most
-- recent previous occupant who has not moved on to another REP seat since (their list then belongs to
-- that seat). Grounded 2026-09-16: eight resigned reps' lists are the only lists of their now-vacant
-- territories, and one new hire holds a seat whose list is still under the rep who left it.
--
-- State: dropped · validated · drop_pending (a drop of a never-validated customer waits for the
-- district manager) · open. A validated customer with a drop waiting is still validated.
--
-- Stored HR ids are upper case on both sides (crm_contact_assignments.agent_hr_id and
-- au.occupancy_history.occupant_hr_id), so the open-list index is used. Call it for one seat, or
-- through phoenix_crm_seat_readiness for many — a PostgREST read of many seats' rows would be capped.
create or replace function public.phoenix_crm_seat_reference(p_seat_ids text[], p_is_test boolean default false)
returns table (
  seat_id text,
  source_hr_id text,
  source_is_current boolean,
  contact_crm_id bigint,
  list_type text,
  grade text,
  name text,
  speciality text,
  address text,
  city text,
  zone text,
  brick_id text,
  last_visited_on date,
  customer_id uuid,
  state text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  with seats as (
    select distinct s.seat_id
    from unnest(p_seat_ids) as s (seat_id)
    where s.seat_id is not null
  ),
  candidates as (
    select
      o.seat_id,
      upper(trim(o.occupant_hr_id)) as hr_id,
      o.effective_to is null as is_current,
      o.effective_from,
      o.effective_to
    from au.occupancy_history o
    join seats s on s.seat_id = o.seat_id
    where o.node_type = 'person'
      and nullif(trim(o.occupant_hr_id), '') is not null
  ),
  with_list as (
    select c.*
    from candidates c
    where exists (
        select 1
        from public.crm_contact_assignments a
        where a.effective_to is null
          and a.agent_hr_id = c.hr_id
          and a.list_type in ('AM', 'PM')
          and a.contact_crm_id <> 100000
      )
      and (
        c.is_current
        or not exists (
          select 1
          from au.occupancy_history other
          join au.seats other_seat on other_seat.seat_id = other.seat_id
          where other.node_type = 'person'
            and upper(trim(other.occupant_hr_id)) = c.hr_id
            and other.seat_id <> c.seat_id
            and other_seat.seat_tier = 'REP'
            and (other.effective_to is null or other.effective_from > c.effective_from)
        )
      )
  ),
  chosen as (
    select distinct on (w.seat_id) w.seat_id, w.hr_id, w.is_current
    from with_list w
    order by w.seat_id, w.is_current desc, w.effective_to desc nulls first, w.effective_from desc
  )
  select
    ch.seat_id,
    ch.hr_id,
    ch.is_current,
    a.contact_crm_id,
    a.list_type,
    case
      when upper(trim(a.grade)) in ('A', 'B', 'C') then upper(trim(a.grade))
      when upper(trim(a.grade)) = 'A+' then 'A'
      else null
    end,
    coalesce(nullif(trim(contact.name), ''), 'Unnamed customer'),
    nullif(trim(contact.speciality), ''),
    nullif(trim(contact.address), ''),
    nullif(trim(contact.city), ''),
    nullif(trim(contact.zone), ''),
    contact.brick_id,
    contact.last_visited_on,
    customer.id,
    case
      when customer.status = 'dropped' then 'dropped'
      when customer.status = 'active' then 'validated'
      when exists (
        select 1
        from public.phoenix_crm_list_requests q
        where q.seat_id = ch.seat_id
          and q.kind = 'drop'
          and q.status = 'pending'
          and q.is_test = p_is_test
          and q.customer_id is null
          and q.reference_contact_crm_id = a.contact_crm_id
      ) then 'drop_pending'
      else 'open'
    end
  from chosen ch
  join public.crm_contact_assignments a
    on a.effective_to is null
   and a.agent_hr_id = ch.hr_id
   and a.list_type in ('AM', 'PM')
   and a.contact_crm_id <> 100000
  left join public.crm_contacts contact on contact.contact_crm_id = a.contact_crm_id
  left join public.phoenix_crm_customers customer
    on customer.seat_id = ch.seat_id
   and customer.reference_contact_crm_id = a.contact_crm_id
   and customer.is_test = p_is_test;
$$;

-- Readiness counts for many seats in one call (real entries only; the Super Admin's test mode skips
-- the gate). With p_mark_ready, a complete seat is stamped ready — once, and it stays ready.
create or replace function public.phoenix_crm_seat_readiness(p_seat_ids text[], p_mark_ready boolean default false)
returns table (
  seat_id text,
  reference_total integer,
  validated_count integer,
  dropped_count integer,
  drop_pending_count integer,
  open_count integer,
  ready_at timestamptz
)
language sql
volatile
security definer
set search_path to 'public'
as $$
  with seats as (
    select distinct s.seat_id
    from unnest(p_seat_ids) as s (seat_id)
    where s.seat_id is not null
  ),
  refs as (
    select r.seat_id, r.state
    from public.phoenix_crm_seat_reference(p_seat_ids, false) r
  ),
  counts as (
    select
      s.seat_id,
      count(refs.state)::integer as reference_total,
      (count(*) filter (where refs.state = 'validated'))::integer as validated_count,
      (count(*) filter (where refs.state = 'dropped'))::integer as dropped_count,
      (count(*) filter (where refs.state = 'drop_pending'))::integer as drop_pending_count,
      (count(*) filter (where refs.state = 'open'))::integer as open_count
    from seats s
    left join refs on refs.seat_id = s.seat_id
    group by s.seat_id
  ),
  marked as (
    insert into public.phoenix_crm_territory_readiness (seat_id, reference_total, validated, dropped)
    select c.seat_id, c.reference_total, c.validated_count, c.dropped_count
    from counts c
    where p_mark_ready
      and c.open_count = 0
      and c.drop_pending_count = 0
    on conflict (seat_id) do nothing
    returning seat_id, ready_at
  )
  select
    c.seat_id,
    c.reference_total,
    c.validated_count,
    c.dropped_count,
    c.drop_pending_count,
    c.open_count,
    coalesce(t.ready_at, m.ready_at)
  from counts c
  left join public.phoenix_crm_territory_readiness t on t.seat_id = c.seat_id
  left join marked m on m.seat_id = c.seat_id;
$$;

-- ── 9. Photos and places (internal helpers) ──────────────────────────────────────────────────────

-- Consumes an issued upload path and returns the server time it was issued (the capture time).
create or replace function public.phoenix_crm_take_photo(
  p_path text,
  p_hr_id text,
  p_seat_id text,
  p_purpose text,
  p_is_test boolean
)
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_slot public.phoenix_crm_photo_uploads%rowtype;
begin
  select u.* into v_slot
  from public.phoenix_crm_photo_uploads u
  where u.path = p_path
  for update;

  if not found
    or v_slot.issued_to_hr_id <> upper(trim(p_hr_id))
    or v_slot.seat_id <> p_seat_id
    or v_slot.purpose <> p_purpose
    or v_slot.is_test <> p_is_test then
    raise exception 'phoenix_crm:photo_not_issued';
  end if;
  if v_slot.used_at is not null then
    raise exception 'phoenix_crm:photo_used';
  end if;
  if v_slot.issued_at < now() - interval '12 hours' then
    raise exception 'phoenix_crm:photo_expired';
  end if;
  if not exists (
    select 1 from storage.objects o where o.bucket_id = 'phoenix-crm-photos' and o.name = p_path
  ) then
    raise exception 'phoenix_crm:photo_missing';
  end if;

  update public.phoenix_crm_photo_uploads u set used_at = now() where u.path = p_path;
  return v_slot.issued_at;
end;
$$;

create or replace function public.phoenix_crm_insert_place(
  p_customer_id uuid,
  p_seat_id text,
  p_actor_hr_id text,
  p_is_test boolean,
  p_place jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_captured_at timestamptz;
  v_place_id uuid;
begin
  if jsonb_typeof(p_place) is distinct from 'object'
    or jsonb_typeof(p_place -> 'timings') is distinct from 'array'
    or nullif(trim(coalesce(p_place ->> 'photo_path', '')), '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  v_captured_at := public.phoenix_crm_take_photo(p_place ->> 'photo_path', p_actor_hr_id, p_seat_id, 'place', p_is_test);

  insert into public.phoenix_crm_places (
    customer_id, seat_id, label, address, brick_id, brick_name, zone, lat, lon, accuracy_meters,
    timings, photo_path, captured_at, device_skew_minutes, created_by_hr_id, is_test
  )
  values (
    p_customer_id,
    p_seat_id,
    nullif(trim(coalesce(p_place ->> 'label', '')), ''),
    nullif(trim(coalesce(p_place ->> 'address', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_id', '')), ''),
    nullif(trim(coalesce(p_place ->> 'brick_name', '')), ''),
    nullif(trim(coalesce(p_place ->> 'zone', '')), ''),
    (p_place ->> 'lat')::double precision,
    (p_place ->> 'lon')::double precision,
    (p_place ->> 'accuracy_meters')::numeric,
    p_place -> 'timings',
    p_place ->> 'photo_path',
    v_captured_at,
    (p_place ->> 'device_skew_minutes')::integer,
    upper(trim(p_actor_hr_id)),
    p_is_test
  )
  returning id into v_place_id;

  return jsonb_build_object('place_id', v_place_id, 'captured_at', v_captured_at);
end;
$$;

-- ── 10. The list: validate, places, requests ─────────────────────────────────────────────────────

-- Validates a customer in one transaction: the customer (a reference one, a brand-new one, or a
-- dropped one restored), its first place with the live photo, and — for a new customer — the grade
-- request the district manager decides.
--   p: seat_id, line_code, actor_hr_id, is_test, mode ('reference' | 'new' | 'restore'),
--      reference_contact_crm_id (reference) · name, list_type, speciality, proposed_grade,
--      allow_same_name (new) · customer_id (restore) · place {photo_path, lat, lon, accuracy_meters,
--      device_skew_minutes, label, address, brick_id, brick_name, zone, timings}
create or replace function public.phoenix_crm_validate_customer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_mode text := coalesce(p ->> 'mode', '');
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_name text;
  v_list_type text;
  v_grade text;
  v_place jsonb;
  v_request_id uuid;
  v_event text := 'customer_validated';
begin
  if v_seat is null or v_line is null or v_actor is null or jsonb_typeof(p -> 'place') is distinct from 'object' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  if v_mode = 'reference' then
    select r.* into v_ref
    from public.phoenix_crm_seat_reference(array[v_seat], v_is_test) r
    where r.contact_crm_id = (p ->> 'reference_contact_crm_id')::bigint;
    if not found then
      raise exception 'phoenix_crm:not_on_reference_list';
    end if;
    if v_ref.state = 'validated' then
      raise exception 'phoenix_crm:already_validated';
    end if;

    if v_ref.customer_id is not null then
      update public.phoenix_crm_customers c
      set status = 'active',
          validated_at = now(),
          validated_by_hr_id = v_actor,
          dropped_reason = null,
          dropped_note = null,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_ref.customer_id
      returning c.* into v_customer;
      v_event := 'customer_restored';
    else
      insert into public.phoenix_crm_customers (
        seat_id, line_code, list_type, name, speciality, grade, origin, reference_contact_crm_id,
        status, validated_at, validated_by_hr_id, created_by_hr_id, is_test
      )
      values (
        v_seat, v_line, v_ref.list_type, left(v_ref.name, 200), left(v_ref.speciality, 120), v_ref.grade, 'reference', v_ref.contact_crm_id,
        'active', now(), v_actor, v_actor, v_is_test
      )
      returning * into v_customer;
    end if;

    -- Validating a reference customer whose drop was waiting is the rep's answer: the drop is withdrawn.
    with withdrawn as (
      update public.phoenix_crm_list_requests q
      set status = 'withdrawn',
          decided_at = now(),
          decided_by_hr_id = v_actor,
          decision_note = 'Validated instead of dropped'
      where q.seat_id = v_seat
        and q.is_test = v_is_test
        and q.kind = 'drop'
        and q.status = 'pending'
        and q.customer_id is null
        and q.reference_contact_crm_id = v_ref.contact_crm_id
      returning q.id
    )
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'validated'), v_is_test
    from withdrawn w;

  elsif v_mode = 'new' then
    v_name := nullif(regexp_replace(trim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
    v_list_type := coalesce(p ->> 'list_type', '');
    v_grade := coalesce(p ->> 'proposed_grade', '');
    if v_name is null or v_list_type not in ('AM', 'PM') or v_grade not in ('A', 'B', 'C') then
      raise exception 'phoenix_crm:bad_input';
    end if;
    if not coalesce((p ->> 'allow_same_name')::boolean, false) and exists (
      select 1
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status = 'active'
        and c.list_type = v_list_type
        and lower(c.name) = lower(v_name)
    ) then
      raise exception 'phoenix_crm:same_name';
    end if;

    insert into public.phoenix_crm_customers (
      seat_id, line_code, list_type, name, speciality, grade, origin, status, validated_at,
      validated_by_hr_id, created_by_hr_id, is_test
    )
    values (
      v_seat, v_line, v_list_type, v_name, nullif(trim(coalesce(p ->> 'speciality', '')), ''), null, 'new', 'active', now(),
      v_actor, v_actor, v_is_test
    )
    returning * into v_customer;

    insert into public.phoenix_crm_list_requests (
      seat_id, line_code, kind, customer_id, list_type, customer_name, current_grade, proposed_grade,
      requested_by_hr_id, is_test
    )
    values (v_seat, v_line, 'grade', v_customer.id, v_list_type, v_name, null, v_grade, v_actor, v_is_test)
    returning id into v_request_id;

  elsif v_mode = 'restore' then
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = (p ->> 'customer_id')::uuid
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.status = 'active' then
      raise exception 'phoenix_crm:already_validated';
    end if;
    update public.phoenix_crm_customers c
    set status = 'active',
        validated_at = now(),
        validated_by_hr_id = v_actor,
        dropped_reason = null,
        dropped_note = null,
        status_changed_at = now(),
        updated_at = now()
    where c.id = v_customer.id
    returning c.* into v_customer;
    v_event := 'customer_restored';

  else
    raise exception 'phoenix_crm:bad_input';
  end if;

  v_place := public.phoenix_crm_insert_place(v_customer.id, v_seat, v_actor, v_is_test, p -> 'place');

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, v_event, v_actor,
    jsonb_build_object('mode', v_mode, 'reference_contact_crm_id', v_customer.reference_contact_crm_id),
    v_is_test
  );
  if v_request_id is not null then
    insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_customer.id, v_request_id, 'request_created', v_actor,
      jsonb_build_object('kind', 'grade', 'proposed_grade', v_grade), v_is_test
    );
  end if;

  return jsonb_build_object(
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'place_id', v_place ->> 'place_id',
    'captured_at', v_place ->> 'captured_at',
    'restored', v_event = 'customer_restored',
    'grade_request_id', v_request_id
  );
end;
$$;

-- Another place for a validated customer (a doctor who also receives elsewhere): its own photo,
-- location and timings. At most five active places a customer.
--   p: seat_id, actor_hr_id, is_test, customer_id, place {...as in validate}
create or replace function public.phoenix_crm_add_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer public.phoenix_crm_customers%rowtype;
  v_place jsonb;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'customer_id', '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = (p ->> 'customer_id')::uuid
    and c.seat_id = v_seat
    and c.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status <> 'active' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if (select count(*) from public.phoenix_crm_places pl where pl.customer_id = v_customer.id and pl.status = 'active') >= 5 then
    raise exception 'phoenix_crm:too_many_places';
  end if;

  v_place := public.phoenix_crm_insert_place(v_customer.id, v_seat, v_actor, v_is_test, p -> 'place');

  insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_customer.id, (v_place ->> 'place_id')::uuid, 'place_added', v_actor, '{}'::jsonb, v_is_test);

  return v_place || jsonb_build_object('customer_id', v_customer.id, 'customer_name', v_customer.name);
end;
$$;

-- Edits a place's timings and details (no new photo needed — every change is kept in the events), or
-- retires a place. A customer keeps at least one active place; leaving the list is a drop request.
--   p: seat_id, actor_hr_id, is_test, place_id, action ('edit' | 'retire'),
--      timings, label, address, zone, brick_id, brick_name (edit)
create or replace function public.phoenix_crm_update_place(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_action text := coalesce(p ->> 'action', '');
  v_place public.phoenix_crm_places%rowtype;
  v_after public.phoenix_crm_places%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'place_id', '') is null or v_action not in ('edit', 'retire') then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select pl.* into v_place
  from public.phoenix_crm_places pl
  where pl.id = (p ->> 'place_id')::uuid
    and pl.seat_id = v_seat
    and pl.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:place_not_found';
  end if;
  if v_place.status <> 'active' then
    raise exception 'phoenix_crm:place_retired';
  end if;

  if v_action = 'edit' then
    if jsonb_typeof(p -> 'timings') is distinct from 'array' or jsonb_array_length(p -> 'timings') = 0 then
      raise exception 'phoenix_crm:bad_input';
    end if;
    update public.phoenix_crm_places pl
    set timings = p -> 'timings',
        label = nullif(trim(coalesce(p ->> 'label', '')), ''),
        address = nullif(trim(coalesce(p ->> 'address', '')), ''),
        zone = nullif(trim(coalesce(p ->> 'zone', '')), ''),
        brick_id = nullif(trim(coalesce(p ->> 'brick_id', '')), ''),
        brick_name = nullif(trim(coalesce(p ->> 'brick_name', '')), ''),
        updated_at = now()
    where pl.id = v_place.id
    returning pl.* into v_after;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (
      v_seat, v_place.customer_id, v_place.id, 'place_updated', v_actor,
      jsonb_build_object(
        'before', jsonb_build_object('timings', v_place.timings, 'label', v_place.label, 'address', v_place.address,
                                     'zone', v_place.zone, 'brick_name', v_place.brick_name),
        'after', jsonb_build_object('timings', v_after.timings, 'label', v_after.label, 'address', v_after.address,
                                    'zone', v_after.zone, 'brick_name', v_after.brick_name)
      ),
      v_is_test
    );
  else
    if not exists (
      select 1
      from public.phoenix_crm_places pl
      where pl.customer_id = v_place.customer_id
        and pl.status = 'active'
        and pl.id <> v_place.id
    ) then
      raise exception 'phoenix_crm:last_place';
    end if;
    update public.phoenix_crm_places pl
    set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
    where pl.id = v_place.id;

    insert into public.phoenix_crm_list_events (seat_id, customer_id, place_id, event_type, actor_hr_id, details, is_test)
    values (v_seat, v_place.customer_id, v_place.id, 'place_retired', v_actor, '{}'::jsonb, v_is_test);
  end if;

  return jsonb_build_object('place_id', v_place.id, 'customer_id', v_place.customer_id);
end;
$$;

-- A grade change (rep proposes) or a drop (reason, and "other" needs a note) for the district manager.
--   p: seat_id, line_code, actor_hr_id, is_test, kind ('grade' | 'drop'),
--      customer_id or reference_contact_crm_id (a reference customer never validated — drop only),
--      proposed_grade (grade) · drop_reason, note (drop)
create or replace function public.phoenix_crm_create_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_kind text := coalesce(p ->> 'kind', '');
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_contact bigint := nullif(p ->> 'reference_contact_crm_id', '')::bigint;
  v_grade text := nullif(p ->> 'proposed_grade', '');
  v_reason text := nullif(p ->> 'drop_reason', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_customer public.phoenix_crm_customers%rowtype;
  v_ref record;
  v_name text;
  v_list_type text;
  v_current_grade text;
  v_id uuid;
begin
  if v_seat is null or v_line is null or v_actor is null or v_kind not in ('grade', 'drop')
    or (v_customer_id is null and v_contact is null) then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'grade' and coalesce(v_grade, '') not in ('A', 'B', 'C') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'drop' and coalesce(v_reason, '') not in ('moved', 'retired', 'closed', 'not_target', 'duplicate', 'other') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_kind = 'drop' and v_reason = 'other' and v_note is null then
    raise exception 'phoenix_crm:note_required';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  if v_customer_id is null then
    select r.* into v_ref
    from public.phoenix_crm_seat_reference(array[v_seat], v_is_test) r
    where r.contact_crm_id = v_contact;
    if not found then
      raise exception 'phoenix_crm:not_on_reference_list';
    end if;
    if v_ref.customer_id is not null then
      v_customer_id := v_ref.customer_id;
    elsif v_kind <> 'drop' then
      raise exception 'phoenix_crm:not_validated';
    else
      v_name := v_ref.name;
      v_list_type := v_ref.list_type;
      v_current_grade := v_ref.grade;
    end if;
  end if;

  if v_customer_id is not null then
    select c.* into v_customer
    from public.phoenix_crm_customers c
    where c.id = v_customer_id
      and c.seat_id = v_seat
      and c.is_test = v_is_test
    for update;
    if not found then
      raise exception 'phoenix_crm:customer_not_found';
    end if;
    if v_customer.status <> 'active' then
      raise exception 'phoenix_crm:customer_dropped';
    end if;
    if v_kind = 'grade' and v_customer.grade is not distinct from v_grade then
      raise exception 'phoenix_crm:same_grade';
    end if;
    v_name := v_customer.name;
    v_list_type := v_customer.list_type;
    v_current_grade := v_customer.grade;
    v_contact := v_customer.reference_contact_crm_id;
  end if;

  if exists (
    select 1
    from public.phoenix_crm_list_requests q
    where q.seat_id = v_seat
      and q.is_test = v_is_test
      and q.kind = v_kind
      and q.status = 'pending'
      and (
        (v_customer_id is not null and q.customer_id = v_customer_id)
        or (v_customer_id is null and q.customer_id is null and q.reference_contact_crm_id = v_contact)
      )
  ) then
    raise exception 'phoenix_crm:already_pending';
  end if;

  insert into public.phoenix_crm_list_requests (
    seat_id, line_code, kind, customer_id, reference_contact_crm_id, list_type, customer_name,
    current_grade, proposed_grade, drop_reason, note, requested_by_hr_id, is_test
  )
  values (
    v_seat, v_line, v_kind, v_customer_id, v_contact, v_list_type, v_name,
    v_current_grade,
    case when v_kind = 'grade' then v_grade end,
    case when v_kind = 'drop' then v_reason end,
    v_note, v_actor, v_is_test
  )
  returning id into v_id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, v_customer_id, v_id, 'request_created', v_actor,
    jsonb_build_object('kind', v_kind, 'proposed_grade', v_grade, 'drop_reason', v_reason, 'reference_contact_crm_id', v_contact),
    v_is_test
  );

  return jsonb_build_object(
    'request_id', v_id,
    'kind', v_kind,
    'customer_id', v_customer_id,
    'customer_name', v_name,
    'list_type', v_list_type
  );
end;
$$;

--   p: seat_id, actor_hr_id, is_test, request_id
create or replace function public.phoenix_crm_withdraw_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_request public.phoenix_crm_list_requests%rowtype;
begin
  if v_seat is null or v_actor is null or nullif(p ->> 'request_id', '') is null then
    raise exception 'phoenix_crm:bad_input';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request
  from public.phoenix_crm_list_requests q
  where q.id = (p ->> 'request_id')::uuid
    and q.seat_id = v_seat
    and q.is_test = v_is_test
  for update;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;

  update public.phoenix_crm_list_requests q
  set status = 'withdrawn', decided_at = now(), decided_by_hr_id = v_actor
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (v_seat, v_request.customer_id, v_request.id, 'request_withdrawn', v_actor, jsonb_build_object('kind', v_request.kind), v_is_test);

  return jsonb_build_object('request_id', v_request.id, 'kind', v_request.kind, 'customer_name', v_request.customer_name);
end;
$$;

-- The district manager's decision. An approved grade sets the customer's grade. An approved drop
-- takes the customer off the list (its places retire and its other waiting requests are withdrawn);
-- a reference customer never validated gets a dropped row so the list counts it as done.
--   p: request_id, actor_hr_id, is_test, decision ('approve' | 'refuse'), note
create or replace function public.phoenix_crm_decide_request(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_decision text := coalesce(p ->> 'decision', '');
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_request_id uuid := nullif(p ->> 'request_id', '')::uuid;
  v_seat text;
  v_request public.phoenix_crm_list_requests%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_status text;
begin
  if v_actor is null or v_request_id is null or v_decision not in ('approve', 'refuse') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select q.seat_id into v_seat from public.phoenix_crm_list_requests q where q.id = v_request_id;
  if not found then
    raise exception 'phoenix_crm:request_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));

  select q.* into v_request from public.phoenix_crm_list_requests q where q.id = v_request_id for update;
  if v_request.is_test <> v_is_test then
    raise exception 'phoenix_crm:request_not_found';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'phoenix_crm:request_decided';
  end if;

  if v_decision = 'approve' then
    v_status := 'approved';

    if v_request.kind = 'grade' then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'active' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set grade = v_request.proposed_grade, updated_at = now()
      where c.id = v_customer.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'grade_changed', v_actor,
        jsonb_build_object('from', v_customer.grade, 'to', v_request.proposed_grade), v_is_test
      );

    elsif v_request.customer_id is not null then
      select c.* into v_customer from public.phoenix_crm_customers c where c.id = v_request.customer_id for update;
      if not found or v_customer.status <> 'active' then
        raise exception 'phoenix_crm:customer_dropped';
      end if;
      update public.phoenix_crm_customers c
      set status = 'dropped',
          dropped_reason = v_request.drop_reason,
          dropped_note = v_request.note,
          status_changed_at = now(),
          updated_at = now()
      where c.id = v_customer.id;

      update public.phoenix_crm_places pl
      set status = 'retired', retired_at = now(), retired_by_hr_id = v_actor, updated_at = now()
      where pl.customer_id = v_customer.id
        and pl.status = 'active';

      with withdrawn as (
        update public.phoenix_crm_list_requests q
        set status = 'withdrawn',
            decided_at = now(),
            decided_by_hr_id = v_actor,
            decision_note = 'The customer left the list'
        where q.customer_id = v_customer.id
          and q.status = 'pending'
          and q.id <> v_request.id
        returning q.id
      )
      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      select v_seat, v_customer.id, w.id, 'request_withdrawn', v_actor, jsonb_build_object('why', 'dropped'), v_is_test
      from withdrawn w;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason), v_is_test
      );

    else
      select c.* into v_customer
      from public.phoenix_crm_customers c
      where c.seat_id = v_seat
        and c.reference_contact_crm_id = v_request.reference_contact_crm_id
        and c.is_test = v_is_test
      for update;
      if found then
        if v_customer.status = 'active' then
          raise exception 'phoenix_crm:already_validated';
        end if;
        raise exception 'phoenix_crm:customer_dropped';
      end if;

      insert into public.phoenix_crm_customers (
        seat_id, line_code, list_type, name, grade, origin, reference_contact_crm_id, status, validated_at,
        dropped_reason, dropped_note, status_changed_at, created_by_hr_id, is_test
      )
      values (
        v_seat, v_request.line_code, v_request.list_type, left(v_request.customer_name, 200), v_request.current_grade, 'reference',
        v_request.reference_contact_crm_id, 'dropped', null, v_request.drop_reason, v_request.note, now(),
        v_request.requested_by_hr_id, v_is_test
      )
      returning * into v_customer;

      update public.phoenix_crm_list_requests q set customer_id = v_customer.id where q.id = v_request.id;

      insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
      values (
        v_seat, v_customer.id, v_request.id, 'customer_dropped', v_actor,
        jsonb_build_object('reason', v_request.drop_reason, 'reference_contact_crm_id', v_request.reference_contact_crm_id),
        v_is_test
      );
    end if;
  else
    v_status := 'refused';
  end if;

  update public.phoenix_crm_list_requests q
  set status = v_status, decided_at = now(), decided_by_hr_id = v_actor, decision_note = v_note
  where q.id = v_request.id;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, request_id, event_type, actor_hr_id, details, is_test)
  values (
    v_seat, coalesce(v_customer.id, v_request.customer_id), v_request.id, 'request_decided', v_actor,
    jsonb_build_object('kind', v_request.kind, 'decision', v_status), v_is_test
  );

  return jsonb_build_object(
    'request_id', v_request.id,
    'seat_id', v_seat,
    'kind', v_request.kind,
    'status', v_status,
    'customer_id', coalesce(v_customer.id, v_request.customer_id),
    'customer_name', v_request.customer_name,
    'list_type', v_request.list_type,
    'proposed_grade', v_request.proposed_grade,
    'drop_reason', v_request.drop_reason,
    'requested_by_hr_id', v_request.requested_by_hr_id
  );
end;
$$;

-- ── 11. Weekly plans ─────────────────────────────────────────────────────────────────────────────

-- Saves the days of a draft or returned plan the rep may still change (today onward, Cairo). Items of
-- other days are kept as they are. The version guards against two phones saving over each other.
--   p: seat_id, line_code, actor_hr_id, is_test, week_start, expected_version (null for a new plan),
--      editable_days [date], items [{plan_date, customer_id, place_id, list_type, receives,
--      start_minute, exception_type, exception_note}] — checked by plan-rules.ts first (caps,
--      Thursday mornings, exception reasons).
create or replace function public.phoenix_crm_save_plan(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_week date := nullif(p ->> 'week_start', '')::date;
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_today date := (now() at time zone 'Africa/Cairo')::date;
  v_days date[];
  v_plan public.phoenix_crm_plans%rowtype;
  v_items jsonb := p -> 'items';
  v_count integer;
begin
  if v_seat is null or v_line is null or v_actor is null or v_week is null
    or extract(isodow from v_week) <> 6
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_typeof(p -> 'editable_days') is distinct from 'array' then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select coalesce(array_agg(distinct d.value::date), '{}'::date[])
  into v_days
  from jsonb_array_elements_text(p -> 'editable_days') d;

  if exists (select 1 from unnest(v_days) d where d < v_today or d < v_week or d > v_week + 5) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan
  from public.phoenix_crm_plans pl
  where pl.seat_id = v_seat
    and pl.week_start = v_week
    and pl.is_test = v_is_test
  for update;

  if not found then
    if coalesce(v_expected, 0) <> 0 then
      raise exception 'phoenix_crm:version_conflict';
    end if;
    insert into public.phoenix_crm_plans (seat_id, line_code, week_start, status, version, created_by_hr_id, is_test)
    values (v_seat, v_line, v_week, 'draft', 1, v_actor, v_is_test)
    returning * into v_plan;

    insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, to_status, version)
    values (v_plan.id, 'created', v_actor, 'draft', 1);
  else
    if v_plan.status not in ('draft', 'returned') then
      raise exception 'phoenix_crm:not_editable';
    end if;
    if v_expected is distinct from v_plan.version then
      raise exception 'phoenix_crm:version_conflict';
    end if;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (plan_date date)
    where x.plan_date is null or not (x.plan_date = any (v_days))
  ) then
    raise exception 'phoenix_crm:day_not_editable';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (customer_id uuid, list_type text)
    where not exists (
      select 1
      from public.phoenix_crm_customers c
      where c.id = x.customer_id
        and c.seat_id = v_seat
        and c.is_test = v_is_test
        and c.status = 'active'
        and c.list_type = x.list_type
    )
  ) then
    raise exception 'phoenix_crm:customer_not_on_list';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_items) as x (customer_id uuid, place_id uuid)
    where not exists (
      select 1
      from public.phoenix_crm_places pl
      where pl.id = x.place_id
        and pl.customer_id = x.customer_id
        and pl.status = 'active'
    )
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  delete from public.phoenix_crm_plan_items i
  where i.plan_id = v_plan.id
    and i.plan_date = any (v_days)
    and not exists (
      select 1
      from jsonb_to_recordset(v_items) as x (plan_date date, customer_id uuid)
      where x.plan_date = i.plan_date
        and x.customer_id = i.customer_id
    );

  insert into public.phoenix_crm_plan_items (
    plan_id, plan_date, customer_id, place_id, list_type, receives, start_minute, exception_type, exception_note
  )
  select distinct on (x.plan_date, x.customer_id)
    v_plan.id,
    x.plan_date,
    x.customer_id,
    x.place_id,
    x.list_type,
    coalesce(x.receives, false),
    x.start_minute,
    nullif(x.exception_type, ''),
    nullif(trim(coalesce(x.exception_note, '')), '')
  from jsonb_to_recordset(v_items) as x (
    plan_date date,
    customer_id uuid,
    place_id uuid,
    list_type text,
    receives boolean,
    start_minute integer,
    exception_type text,
    exception_note text
  )
  order by x.plan_date, x.customer_id
  on conflict (plan_id, plan_date, customer_id) do update
    set place_id = excluded.place_id,
        list_type = excluded.list_type,
        receives = excluded.receives,
        start_minute = excluded.start_minute,
        exception_type = excluded.exception_type,
        exception_note = excluded.exception_note,
        updated_at = now();

  select count(*)::integer into v_count from public.phoenix_crm_plan_items i where i.plan_id = v_plan.id;

  update public.phoenix_crm_plans pl
  set version = pl.version + 1, updated_at = now()
  where pl.id = v_plan.id
  returning pl.* into v_plan;

  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, from_status, to_status, version, details)
  values (
    v_plan.id, 'saved', v_actor, v_plan.status, v_plan.status, v_plan.version,
    jsonb_build_object('items', v_count, 'days', to_jsonb(v_days))
  );

  return jsonb_build_object('plan_id', v_plan.id, 'status', v_plan.status, 'version', v_plan.version, 'item_count', v_count);
end;
$$;

-- submit (rep: draft/returned → submitted) · reopen (rep: submitted/approved → draft) ·
-- approve (reviewer: submitted → approved) · return (reviewer or SFE: submitted/approved → returned,
-- with a note). Nothing here runs without a person's action: the system never approves a plan.
--   p: plan_id, action, actor_hr_id, actor_role, is_test, expected_version, note
create or replace function public.phoenix_crm_plan_transition(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_plan_id uuid := nullif(p ->> 'plan_id', '')::uuid;
  v_action text := coalesce(p ->> 'action', '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_role text := nullif(trim(coalesce(p ->> 'actor_role', '')), '');
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_note text := nullif(regexp_replace(trim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), '');
  v_seat text;
  v_week date;
  v_plan public.phoenix_crm_plans%rowtype;
  v_from text;
  v_event text;
begin
  if v_plan_id is null or v_actor is null or v_action not in ('submit', 'reopen', 'approve', 'return') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select pl.seat_id, pl.week_start into v_seat, v_week from public.phoenix_crm_plans pl where pl.id = v_plan_id;
  if not found then
    raise exception 'phoenix_crm:plan_not_found';
  end if;

  perform pg_advisory_xact_lock(hashtext('phoenix_crm:plan:' || v_seat || ':' || v_week::text));

  select pl.* into v_plan from public.phoenix_crm_plans pl where pl.id = v_plan_id for update;
  if v_plan.is_test <> v_is_test then
    raise exception 'phoenix_crm:plan_not_found';
  end if;
  if v_expected is distinct from v_plan.version then
    raise exception 'phoenix_crm:version_conflict';
  end if;
  v_from := v_plan.status;

  if v_action = 'submit' then
    if v_from not in ('draft', 'returned') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if not exists (select 1 from public.phoenix_crm_plan_items i where i.plan_id = v_plan.id) then
      raise exception 'phoenix_crm:empty_plan';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'submitted',
        submitted_at = now(),
        submitted_by_hr_id = v_actor,
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'submitted';

  elsif v_action = 'reopen' then
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'draft',
        decided_at = null,
        decided_by_hr_id = null,
        decided_by_role = null,
        decision_note = null,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'reopened';

  elsif v_action = 'approve' then
    if v_from <> 'submitted' then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'approved',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'approved';

  else
    if v_from not in ('submitted', 'approved') then
      raise exception 'phoenix_crm:bad_transition';
    end if;
    if v_note is null then
      raise exception 'phoenix_crm:note_required';
    end if;
    update public.phoenix_crm_plans pl
    set status = 'returned',
        decided_at = now(),
        decided_by_hr_id = v_actor,
        decided_by_role = v_role,
        decision_note = v_note,
        version = pl.version + 1,
        updated_at = now()
    where pl.id = v_plan.id
    returning pl.* into v_plan;
    v_event := 'returned';
  end if;

  insert into public.phoenix_crm_plan_events (plan_id, event_type, actor_hr_id, actor_role, from_status, to_status, version, note)
  values (v_plan.id, v_event, v_actor, v_role, v_from, v_plan.status, v_plan.version, v_note);

  return jsonb_build_object(
    'plan_id', v_plan.id,
    'seat_id', v_plan.seat_id,
    'line_code', v_plan.line_code,
    'week_start', v_plan.week_start,
    'status', v_plan.status,
    'from_status', v_from,
    'version', v_plan.version,
    'submitted_by_hr_id', v_plan.submitted_by_hr_id,
    'created_by_hr_id', v_plan.created_by_hr_id,
    'is_test', v_plan.is_test
  );
end;
$$;

-- ── 12. Visits ───────────────────────────────────────────────────────────────────────────────────

-- Saves a visit once. A retry with the same id returns the saved visit. One visit a customer a day
-- per territory. The visit's date and time are the server's, from the photo's upload slot — or, right
-- after validating, from the place's own photo when the same person took it in the last 30 minutes.
--   p: id, seat_id, line_code, actor_hr_id, is_test, customer_id, kind, rep_hr_id, manager_hr_id,
--      senior_hr_id, products [text], comment, photo_path, reuse_place_photo, lat, lon, accuracy_meters,
--      place_id, distance_meters, location_flag, device_skew_minutes
create or replace function public.phoenix_crm_save_visit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_seat text := nullif(trim(coalesce(p ->> 'seat_id', '')), '');
  v_line text := nullif(trim(coalesce(p ->> 'line_code', '')), '');
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_is_test boolean := coalesce((p ->> 'is_test')::boolean, false);
  v_customer_id uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_kind text := coalesce(p ->> 'kind', '');
  v_rep text := upper(nullif(trim(coalesce(p ->> 'rep_hr_id', '')), ''));
  v_manager text := upper(nullif(trim(coalesce(p ->> 'manager_hr_id', '')), ''));
  v_senior text := upper(nullif(trim(coalesce(p ->> 'senior_hr_id', '')), ''));
  v_photo text := nullif(trim(coalesce(p ->> 'photo_path', '')), '');
  v_reuse boolean := coalesce((p ->> 'reuse_place_photo')::boolean, false);
  v_place_id uuid := nullif(p ->> 'place_id', '')::uuid;
  v_flag text := coalesce(p ->> 'location_flag', '');
  v_comment text := nullif(trim(coalesce(p ->> 'comment', '')), '');
  v_products text[];
  v_existing public.phoenix_crm_visits%rowtype;
  v_customer public.phoenix_crm_customers%rowtype;
  v_captured_at timestamptz;
  v_date date;
begin
  if v_id is null or v_seat is null or v_line is null or v_actor is null or v_customer_id is null or v_photo is null
    or v_kind not in ('single', 'double', 'chain')
    or v_flag not in ('ok', 'far', 'weak_gps', 'no_place') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  if not (
    (v_kind = 'single' and v_senior is null and ((v_rep is null) <> (v_manager is null)))
    or (v_kind = 'double' and v_rep is not null and v_manager is not null and v_senior is null)
    or (v_kind = 'chain' and v_rep is not null and v_manager is not null and v_senior is not null)
  ) then
    raise exception 'phoenix_crm:bad_participants';
  end if;

  select array_agg(trim(e.value) order by e.ordinality)
  into v_products
  from jsonb_array_elements_text(coalesce(p -> 'products', '[]'::jsonb)) with ordinality as e (value, ordinality)
  where nullif(trim(e.value), '') is not null;
  if v_products is null or cardinality(v_products) > 12 then
    raise exception 'phoenix_crm:bad_input';
  end if;

  select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  if not found then
    perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_seat));
    -- A retry racing its own first attempt waits on the lock, then finds it here.
    select v.* into v_existing from public.phoenix_crm_visits v where v.id = v_id;
  end if;
  if found then
    if v_existing.seat_id <> v_seat or v_existing.entered_by_hr_id <> v_actor then
      raise exception 'phoenix_crm:id_conflict';
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'visit_date', v_existing.visit_date,
      'captured_at', v_existing.captured_at,
      'customer_id', v_existing.customer_id,
      'duplicate', true
    );
  end if;

  select c.* into v_customer
  from public.phoenix_crm_customers c
  where c.id = v_customer_id
    and c.seat_id = v_seat
    and c.is_test = v_is_test;
  if not found then
    raise exception 'phoenix_crm:customer_not_found';
  end if;
  if v_customer.status <> 'active' then
    raise exception 'phoenix_crm:customer_dropped';
  end if;
  if v_place_id is not null and not exists (
    select 1 from public.phoenix_crm_places pl where pl.id = v_place_id and pl.customer_id = v_customer.id
  ) then
    raise exception 'phoenix_crm:place_changed';
  end if;

  if v_reuse then
    select pl.captured_at into v_captured_at
    from public.phoenix_crm_places pl
    where pl.photo_path = v_photo
      and pl.customer_id = v_customer.id
      and pl.created_by_hr_id = v_actor
      and pl.is_test = v_is_test
      and pl.created_at > now() - interval '30 minutes';
    if not found then
      raise exception 'phoenix_crm:photo_not_issued';
    end if;
    if exists (select 1 from public.phoenix_crm_visits v where v.photo_path = v_photo) then
      raise exception 'phoenix_crm:photo_used';
    end if;
  else
    v_captured_at := public.phoenix_crm_take_photo(v_photo, v_actor, v_seat, 'visit', v_is_test);
  end if;

  v_date := (v_captured_at at time zone 'Africa/Cairo')::date;

  if exists (
    select 1
    from public.phoenix_crm_visits v
    where v.seat_id = v_seat
      and v.customer_id = v_customer.id
      and v.visit_date = v_date
      and v.is_test = v_is_test
  ) then
    raise exception 'phoenix_crm:already_visited';
  end if;

  insert into public.phoenix_crm_visits (
    id, seat_id, line_code, customer_id, list_type, visit_date, captured_at, kind, rep_hr_id, manager_hr_id,
    senior_hr_id, entered_by_hr_id, products, comment, photo_path, lat, lon, accuracy_meters, place_id,
    distance_meters, location_flag, device_skew_minutes, is_test
  )
  values (
    v_id, v_seat, v_line, v_customer.id, v_customer.list_type, v_date, v_captured_at, v_kind, v_rep, v_manager,
    v_senior, v_actor, v_products, v_comment, v_photo,
    (p ->> 'lat')::double precision,
    (p ->> 'lon')::double precision,
    (p ->> 'accuracy_meters')::numeric,
    v_place_id,
    (p ->> 'distance_meters')::integer,
    v_flag,
    (p ->> 'device_skew_minutes')::integer,
    v_is_test
  );

  return jsonb_build_object(
    'id', v_id,
    'visit_date', v_date,
    'captured_at', v_captured_at,
    'customer_id', v_customer.id,
    'customer_name', v_customer.name,
    'list_type', v_customer.list_type,
    'duplicate', false
  );
end;
$$;

-- ── 13. Reports (aggregated here; AM and PM always apart) ────────────────────────────────────────

-- Visits per territory, rep and day, AM and PM apart.
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
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seat_id, t.visit_date, t.list_type, t.rep_hr_id), '[]'::jsonb)
  from (
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
    from public.phoenix_crm_visits v
    where v.seat_id = any (p_seat_ids)
      and v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
    group by v.seat_id, v.rep_hr_id, v.visit_date, v.list_type
  ) t;
$$;

-- Planned customers visited or missed, and visits off the plan, per territory and day. Only plans that
-- reached review (submitted or approved) count as a plan.
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
  with planned as (
    select pl.seat_id, pl.is_test, i.plan_date, i.customer_id, i.list_type
    from public.phoenix_crm_plans pl
    join public.phoenix_crm_plan_items i on i.plan_id = pl.id
    where pl.seat_id = any (p_seat_ids)
      and pl.status in ('submitted', 'approved')
      and pl.week_start between p_from - 6 and p_to
      and i.plan_date between p_from and p_to
      and (p_include_test or not pl.is_test)
  ),
  visited as (
    select v.seat_id, v.is_test, v.visit_date, v.customer_id, v.list_type
    from public.phoenix_crm_visits v
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
      vd.customer_id is not null as is_visited
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
      (count(*) filter (where j.is_planned and j.is_visited))::integer as visited_planned,
      (count(*) filter (where j.is_planned and not j.is_visited))::integer as missed,
      (count(*) filter (where j.is_visited and not j.is_planned))::integer as unplanned
    from joined j
    group by j.seat_id, j.day, j.list_type
  ) t;
$$;

-- Coverage (share of the list visited) and frequency (visits against the grade's monthly number,
-- exactly on it; under and over reported beside it) per territory for one month. A customer counts
-- when it was on the list during the month. Grade targets come from the settings row.
create or replace function public.phoenix_crm_report_coverage(
  p_seat_ids text[],
  p_month_start date,
  p_include_test boolean default false
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as next_month
  ),
  targets as (
    select s.grade_targets from public.phoenix_crm_settings s where s.id = 1
  ),
  listed as (
    select c.id, c.seat_id, c.list_type, c.grade
    from public.phoenix_crm_customers c
    cross join bounds b
    where c.seat_id = any (p_seat_ids)
      and (p_include_test or not c.is_test)
      and c.validated_at is not null
      and c.validated_at < (b.next_month::timestamp at time zone 'Africa/Cairo')
      and (c.status = 'active' or c.status_changed_at >= (b.month_start::timestamp at time zone 'Africa/Cairo'))
  ),
  month_visits as (
    select v.customer_id, count(*)::integer as visits
    from public.phoenix_crm_visits v
    cross join bounds b
    where v.seat_id = any (p_seat_ids)
      and v.visit_date >= b.month_start
      and v.visit_date < b.next_month
      and (p_include_test or not v.is_test)
    group by v.customer_id
  ),
  scored as (
    select
      l.seat_id,
      l.list_type,
      coalesce(mv.visits, 0) as visits,
      case when l.grade is null then null else nullif(t.grade_targets -> l.list_type ->> l.grade, '')::integer end as target
    from listed l
    left join targets t on true
    left join month_visits mv on mv.customer_id = l.id
  )
  select coalesce(jsonb_agg(to_jsonb(r) order by r.seat_id, r.list_type), '[]'::jsonb)
  from (
    select
      s.seat_id,
      s.list_type,
      count(*)::integer as customers,
      (count(*) filter (where s.visits > 0))::integer as covered,
      (count(*) filter (where s.target is not null))::integer as with_target,
      (count(*) filter (where s.target is not null and s.visits = s.target))::integer as on_target,
      (count(*) filter (where s.target is not null and s.visits < s.target))::integer as under,
      (count(*) filter (where s.target is not null and s.visits > s.target))::integer as over,
      coalesce(sum(s.visits), 0)::integer as visits
    from scored s
    group by s.seat_id, s.list_type
  ) r;
$$;

-- Double and chain visits per manager: which territories and reps each manager went out with, and
-- when. p_hr_ids are the managers in the viewer's scope (never wider, never the CEO).
create or replace function public.phoenix_crm_report_manager_visits(
  p_hr_ids text[],
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
  with people as (
    select distinct upper(trim(x.hr_id)) as hr_id
    from unnest(p_hr_ids) as x (hr_id)
    where nullif(trim(x.hr_id), '') is not null
  ),
  joined as (
    select pe.hr_id, 'manager'::text as role_on_visit, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_visits v on v.manager_hr_id = pe.hr_id
    where v.visit_date between p_from and p_to
      and v.kind in ('double', 'chain')
      and (p_include_test or not v.is_test)
    union all
    select pe.hr_id, 'senior'::text, v.visit_date, v.seat_id, v.rep_hr_id, v.kind, v.list_type
    from people pe
    join public.phoenix_crm_visits v on v.senior_hr_id = pe.hr_id
    where v.visit_date between p_from and p_to
      and (p_include_test or not v.is_test)
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.hr_id, t.visit_date, t.seat_id), '[]'::jsonb)
  from (
    select
      j.hr_id,
      j.role_on_visit,
      j.visit_date,
      j.seat_id,
      j.rep_hr_id,
      (count(*) filter (where j.kind = 'double'))::integer as double_visits,
      (count(*) filter (where j.kind = 'chain'))::integer as chain_visits,
      (count(*) filter (where j.list_type = 'AM'))::integer as am_visits,
      (count(*) filter (where j.list_type = 'PM'))::integer as pm_visits
    from joined j
    group by j.hr_id, j.role_on_visit, j.visit_date, j.seat_id, j.rep_hr_id
  ) t;
$$;

-- ── 14. Service role only, for every function ────────────────────────────────────────────────────

revoke execute on function public.phoenix_crm_seat_reference(text[], boolean) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_seat_readiness(text[], boolean) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_take_photo(text, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_validate_customer(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_add_place(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_update_place(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_create_request(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_withdraw_request(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_decide_request(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_save_plan(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_plan_transition(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_save_visit(jsonb) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_report_visits_by_day(text[], date, date, boolean) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_report_coverage(text[], date, boolean) from public, anon, authenticated;
revoke execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) from public, anon, authenticated;

grant execute on function public.phoenix_crm_seat_reference(text[], boolean) to service_role;
grant execute on function public.phoenix_crm_seat_readiness(text[], boolean) to service_role;
grant execute on function public.phoenix_crm_take_photo(text, text, text, text, boolean) to service_role;
grant execute on function public.phoenix_crm_insert_place(uuid, text, text, boolean, jsonb) to service_role;
grant execute on function public.phoenix_crm_validate_customer(jsonb) to service_role;
grant execute on function public.phoenix_crm_add_place(jsonb) to service_role;
grant execute on function public.phoenix_crm_update_place(jsonb) to service_role;
grant execute on function public.phoenix_crm_create_request(jsonb) to service_role;
grant execute on function public.phoenix_crm_withdraw_request(jsonb) to service_role;
grant execute on function public.phoenix_crm_decide_request(jsonb) to service_role;
grant execute on function public.phoenix_crm_save_plan(jsonb) to service_role;
grant execute on function public.phoenix_crm_plan_transition(jsonb) to service_role;
grant execute on function public.phoenix_crm_save_visit(jsonb) to service_role;
grant execute on function public.phoenix_crm_report_visits_by_day(text[], date, date, boolean) to service_role;
grant execute on function public.phoenix_crm_report_plan_vs_actual(text[], date, date, boolean) to service_role;
grant execute on function public.phoenix_crm_report_coverage(text[], date, boolean) to service_role;
grant execute on function public.phoenix_crm_report_manager_visits(text[], date, date, boolean) to service_role;

notify pgrst, 'reload schema';

commit;
