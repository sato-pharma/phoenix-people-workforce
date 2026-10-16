-- phoenix_crm_visit_report_views
--
-- WHAT THIS CHANGES:
--   One new table, additive, rewriting not a single existing row:
--     public.phoenix_crm_visit_report_views — a Visit report reader's own named choice of fields, one
--     row per (owner, test world, name), replaced when the same name is saved again.
--
-- WHY:
--   Owner, 16 October 2026, on the Visit report generator: "make a save view for someone to save his fav
--   choices". Asked in chat, he chose "Only its owner" (each person's own views, on any device) and
--   "Fields only" (a view holds the ticked fields, never a rep, a district or a period).
--
--   🔴 WHY is_test IS PART OF THE KEY. A test login carries the HR id of the real person it mirrors
--   (src/lib/auth/test-persona.ts), so a key on owner_hr_id alone would put a persona's views in the real
--   person's list and the other way round. Every read and write in
--   src/lib/phoenix-crm/server/visit-report-views.ts filters on both columns.
--
--   🔴 WHY THE UNIQUE INDEX IS PLAIN. The save is a PostgREST upsert on (owner_hr_id, is_test, name), and
--   PostgREST's on_conflict emits column names with no WHERE — a partial index would answer "no unique or
--   exclusion constraint matching the ON CONFLICT specification" on every save.
--
--   The cap of 20 views per person is the service's (VISIT_REPORT_SAVED_VIEWS_MAX); the CHECKs below hold
--   only what a row must be on its own: a real name of at most 60 characters and at least one field.
--   The field keys are cleaned against the reader's sight in the service, on the way in and on the way
--   out, so a key stored here never widens what a reader is offered.
--
-- ROLLBACK:
--   -- SAFE: the table is new in this migration, so dropping it loses only the views saved since it was
--   -- applied, and no other object in the schema depends on it.
--   drop table if exists public.phoenix_crm_visit_report_views;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration rewrites not one existing row and reads none.

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_visit_report_views (
  id uuid primary key default gen_random_uuid(),
  -- The canonical (upper-case) HR id of the person whose view it is — `personKey`, as every Phoenix CRM
  -- viewer carries it.
  owner_hr_id text not null,
  is_test boolean not null default false,
  name text not null,
  -- Visit report field keys (src/lib/phoenix-crm/visit-report-fields.ts), in the catalogue's order.
  fields text[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint phoenix_crm_visit_report_views_name_chk
    check (btrim(name) <> '' and char_length(name) <= 60),
  constraint phoenix_crm_visit_report_views_fields_chk
    check (cardinality(fields) between 1 and 200)
);

comment on table public.phoenix_crm_visit_report_views is
  'Phoenix CRM: a Visit report reader''s own named choice of fields (owner, 2026-10-16: "Only its owner", '
  '"Fields only"). Read and written only by its owner, through the service role; the same name saved again '
  'replaces the row.';

create unique index if not exists phoenix_crm_visit_report_views_owner_name_uidx
  on public.phoenix_crm_visit_report_views (owner_hr_id, is_test, name);

alter table public.phoenix_crm_visit_report_views enable row level security;
create policy phoenix_crm_visit_report_views_service_role
  on public.phoenix_crm_visit_report_views for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_visit_report_views from public, anon, authenticated;
grant all on table public.phoenix_crm_visit_report_views to service_role;

-- The table is brand new, so PostgREST would answer PGRST205 about it until its next own reload — and the
-- route writes through PostgREST.
notify pgrst, 'reload schema';

commit;
