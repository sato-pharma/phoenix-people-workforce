-- phoenix_crm_manager_visit_place
--
-- WHAT THIS CHANGES: public.phoenix_crm_manager_visits gains where the doctor is — the address he typed
--   or the address, area and brick his captured location resolved to — and whether the doctor was on the
--   list of a VACANT territory. A visit to a vacant territory's doctor must carry a typed address or a
--   captured location (the new CHECK).
-- WHY: owner, 2026-10-19: a manager plans and logs single visits from a vacant area's list (the previous
--   rep's doctors), and "if the area is vacant make the district manager obligatory either to fill the dr
--   address by hand or to capture location and the address area and brick are auto filled". He chose that
--   it binds the visit log only (multiple choice, same day). Nobody holds a vacant territory, so this visit
--   is the only record of where its doctor is.
-- ROLLBACK:
--   alter table public.phoenix_crm_manager_visits drop constraint if exists phoenix_crm_manager_visits_vacant_place;
--   alter table public.phoenix_crm_manager_visits drop constraint if exists phoenix_crm_manager_visits_address;
--   alter table public.phoenix_crm_manager_visits
--     drop column if exists in_vacant_territory, drop column if exists address, drop column if exists area_code,
--     drop column if exists area_name, drop column if exists brick_id, drop column if exists brick_name;
--   Additive only: every existing row keeps its values (the new columns are null, the flag false).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.phoenix_crm_manager_visits
  add column if not exists in_vacant_territory boolean not null default false,
  add column if not exists address text,
  add column if not exists area_code text,
  add column if not exists area_name text,
  add column if not exists brick_id text,
  add column if not exists brick_name text;

alter table public.phoenix_crm_manager_visits drop constraint if exists phoenix_crm_manager_visits_address;
alter table public.phoenix_crm_manager_visits
  add constraint phoenix_crm_manager_visits_address check (address is null or char_length(address) between 1 and 300);

-- A visit to a vacant territory's doctor carries a typed address or a captured location — never neither.
alter table public.phoenix_crm_manager_visits drop constraint if exists phoenix_crm_manager_visits_vacant_place;
alter table public.phoenix_crm_manager_visits
  add constraint phoenix_crm_manager_visits_vacant_place check (not in_vacant_territory or address is not null or lat is not null);

comment on column public.phoenix_crm_manager_visits.in_vacant_territory is
  'The doctor was on the list of a territory nobody held on the visit day (owner, 2026-10-19). Such a visit carries a typed address or a captured location.';
comment on column public.phoenix_crm_manager_visits.address is
  'The doctor''s address as the manager saw it on the form: typed by hand, or filled in by Capture location.';
comment on column public.phoenix_crm_manager_visits.area_name is
  'The area the captured location fell in; null when he typed the address and captured nothing.';
comment on column public.phoenix_crm_manager_visits.brick_name is
  'The brick the captured location fell in, when it is a brick of an area he plans in; null otherwise.';

commit;
