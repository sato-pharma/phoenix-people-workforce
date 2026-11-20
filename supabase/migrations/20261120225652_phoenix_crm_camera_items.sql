-- phoenix_crm_camera_items
--
-- WHAT THIS CHANGES:
--   * a new table, public.phoenix_crm_camera_items: every photo the Phoenix Camera sends (a visit, a validation
--     alone, or a new customer), with what its seal said, why it waits, and the Super Admin's decision;
--   * a new column, public.phoenix_crm_settings.camera_daily_cap (1-20, default 3): how many camera items a rep
--     may have recorded at once in one Phoenix day; from the next one on, they wait for the Super Admin;
--   * a new table, public.phoenix_crm_field_camera_releases: each Phoenix Camera version published for the
--     reps' "Update the app" button (version, size, SHA-256 and where the file is);
--   * a new private storage bucket, 'phoenix-field-camera': the sealed files (items/...) and the app (releases/...);
--   * a new function, public.phoenix_crm_camera_add_customer(jsonb): the Super Admin's approval of a new customer
--     added on the camera, written as a pending 'new' customer under the seat's lock (the seal then validates him).
-- WHY: owner, 20 Nov 2026 — the camera for brick with no network: "Phoenix will not reject anything ... leave the
--   decision to the decision maker"; a cap of 3 a day per rep with a tab to control it; "every camera visit and
--   validation lands there, even if from the first three"; a new customer added or validated the same way, and
--   "when I make an update here, make a button in the app ... it updates itself with the new features built".
-- ROLLBACK:
--   drop function if exists public.phoenix_crm_camera_add_customer(jsonb);
--   drop table if exists public.phoenix_crm_field_camera_releases;  -- SAFE: loses only the release list
--   drop table if exists public.phoenix_crm_camera_items;           -- SAFE: loses the camera page's history
--   alter table public.phoenix_crm_settings drop column if exists camera_daily_cap;
--   delete from storage.buckets where id = 'phoenix-field-camera';  (only once the bucket is empty)
--   (ship the code revert FIRST: the camera sync writes the items table.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: two new empty tables, one column with a default, one bucket, one function.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_camera_items (
  -- The seal's own visit id: a resend of the same item is the same row.
  id uuid primary key,
  intent text not null check (intent in ('visit', 'validate', 'new_customer')),
  seat_id text not null,
  line_code text,
  rep_hr_id text not null,
  customer_id uuid references public.phoenix_crm_customers (id),
  -- What the rep typed for a new customer, signed inside the seal.
  proposed_customer jsonb check (proposed_customer is null or jsonb_typeof(proposed_customer) = 'object'),
  is_test boolean not null default false,
  photo_path text,
  photo_kind text not null default 'place'
    check (photo_kind in ('place', 'door_sign', 'banner', 'prescription', 'business_card')),
  seal_id text,
  seal_holds boolean not null default false,
  seal_problems text[] not null default '{}',
  location_problems text[] not null default '{}',
  seal_report jsonb,
  seal_payload jsonb,
  location_status text check (location_status is null or location_status in ('locked', 'cached', 'late', 'none')),
  lat double precision,
  lon double precision,
  accuracy_meters numeric,
  fix_age_ms bigint,
  taken_at timestamptz,
  time_source text not null check (time_source in ('anchor', 'satellites', 'unconfirmed')),
  taken_day date,
  received_at timestamptz not null default now(),
  visit_draft jsonb check (visit_draft is null or jsonb_typeof(visit_draft) = 'object'),
  outcome text not null check (outcome in ('recorded', 'waiting', 'archived')),
  reasons text[] not null default '{}',
  rule_refusal text,
  visit_id uuid,
  validated_place_id uuid,
  reader jsonb,
  decision text check (decision is null or decision in ('approved', 'rejected')),
  decided_by_hr_id text,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_camera_items_decided check ((decision is null) = (decided_at is null) and (decision is null) = (decided_by_hr_id is null)),
  constraint phoenix_crm_camera_items_position check ((lat is null) = (lon is null)),
  constraint phoenix_crm_camera_items_customer check (intent = 'new_customer' or customer_id is not null),
  constraint phoenix_crm_camera_items_proposed check ((intent = 'new_customer') = (proposed_customer is not null))
);

create unique index if not exists phoenix_crm_camera_items_seal_idx on public.phoenix_crm_camera_items (seal_id) where seal_id is not null;
create index if not exists phoenix_crm_camera_items_outcome_idx on public.phoenix_crm_camera_items (outcome, received_at desc);
create index if not exists phoenix_crm_camera_items_rep_day_idx on public.phoenix_crm_camera_items (rep_hr_id, taken_day);
create index if not exists phoenix_crm_camera_items_name_review_idx on public.phoenix_crm_camera_items (customer_id)
  where outcome = 'waiting' and photo_kind <> 'place';

alter table public.phoenix_crm_camera_items enable row level security;
drop policy if exists phoenix_crm_camera_items_service_role on public.phoenix_crm_camera_items;
create policy phoenix_crm_camera_items_service_role
  on public.phoenix_crm_camera_items for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_camera_items from public, anon, authenticated;
grant all on table public.phoenix_crm_camera_items to service_role;

alter table public.phoenix_crm_settings add column if not exists camera_daily_cap integer not null default 3;
alter table public.phoenix_crm_settings drop constraint if exists phoenix_crm_settings_camera_cap;
alter table public.phoenix_crm_settings add constraint phoenix_crm_settings_camera_cap check (camera_daily_cap >= 1 and camera_daily_cap <= 20);

create table if not exists public.phoenix_crm_field_camera_releases (
  version_code integer primary key check (version_code > 0),
  version_name text not null check (char_length(version_name) between 1 and 20),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  storage_path text not null check (storage_path like 'releases/%'),
  notes text check (notes is null or char_length(notes) <= 500),
  published_by_hr_id text not null,
  published_at timestamptz not null default now()
);

alter table public.phoenix_crm_field_camera_releases enable row level security;
drop policy if exists phoenix_crm_field_camera_releases_service_role on public.phoenix_crm_field_camera_releases;
create policy phoenix_crm_field_camera_releases_service_role
  on public.phoenix_crm_field_camera_releases for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_field_camera_releases from public, anon, authenticated;
grant all on table public.phoenix_crm_field_camera_releases to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('phoenix-field-camera', 'phoenix-field-camera', false, 104857600,
        array['image/jpeg', 'application/vnd.android.package-archive', 'application/octet-stream'])
on conflict (id) do nothing;

-- The Super Admin's approval of a new customer added on the camera: a pending 'new' customer, created in the rep's
-- name under the seat's lock. The seal's photo then validates him (phoenix_crm_validate_with_admin_photo), which
-- makes him active — no district manager and no SFE step (owner, 20 Nov 2026: "your camera page only").
create or replace function public.phoenix_crm_camera_add_customer(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item uuid := nullif(trim(coalesce(p ->> 'item_id', '')), '')::uuid;
  v_actor text := upper(nullif(trim(coalesce(p ->> 'actor_hr_id', '')), ''));
  v_row public.phoenix_crm_camera_items%rowtype;
  v_customer_id uuid;
  v_list text := p ->> 'list_type';
  v_name text := nullif(trim(coalesce(p ->> 'name', '')), '');
begin
  if v_item is null or v_actor is null or v_name is null or v_list not in ('AM', 'PM') then
    raise exception 'phoenix_crm:bad_input';
  end if;
  select i.* into v_row from public.phoenix_crm_camera_items i where i.id = v_item;
  if not found then
    raise exception 'phoenix_crm:camera_item_not_found';
  end if;
  perform pg_advisory_xact_lock(hashtext('phoenix_crm:seat:' || v_row.seat_id));
  select i.* into v_row from public.phoenix_crm_camera_items i where i.id = v_item for update;
  if v_row.intent <> 'new_customer' or v_row.decision is not null or v_row.customer_id is not null then
    raise exception 'phoenix_crm:camera_item_decided';
  end if;

  insert into public.phoenix_crm_customers (
    seat_id, line_code, list_type, name, speciality, customer_type, grade, potential_grade, phone,
    origin, status, created_by_hr_id, is_test
  )
  values (
    v_row.seat_id,
    coalesce(nullif(p ->> 'line_code', ''), v_row.line_code),
    v_list,
    left(v_name, 200),
    nullif(left(coalesce(p ->> 'speciality', ''), 120), ''),
    nullif(left(coalesce(p ->> 'customer_type', ''), 80), ''),
    nullif(p ->> 'grade', ''),
    nullif(p ->> 'potential_grade', ''),
    nullif(p ->> 'phone', ''),
    'new',
    'pending',
    v_row.rep_hr_id,
    v_row.is_test
  )
  returning id into v_customer_id;

  update public.phoenix_crm_camera_items i
  set customer_id = v_customer_id, updated_at = now()
  where i.id = v_item;

  insert into public.phoenix_crm_list_events (seat_id, customer_id, event_type, actor_hr_id, details, is_test)
  values (
    v_row.seat_id, v_customer_id, 'customer_added', v_actor,
    jsonb_build_object('mode', 'field_camera', 'camera_item_id', v_item, 'rep_hr_id', v_row.rep_hr_id),
    v_row.is_test
  );

  return jsonb_build_object('customer_id', v_customer_id);
end;
$$;

revoke execute on function public.phoenix_crm_camera_add_customer(jsonb) from public, anon, authenticated;
grant execute on function public.phoenix_crm_camera_add_customer(jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
