-- ─────────────────────────────────────────────────────────────────────────────
-- Recruitment — a MANAGER's own CV folders, separate from the recruitment team's.
--
-- WHY THIS EXISTS
--
-- The owner, 2026-08-30, about the manager's portal: *"and I want him to have a folders like like
-- me."* He had just been given the recruiter's shelf — three sets of folders a good CV waits in
-- until a seat opens — and asked for the same thing on the receiving side. A District Manager gets
-- five CVs, wants one, and today has exactly two answers for the other four: "Interview" or "Not
-- interested". Neither is true of a CV that is good but not needed this month, which is the precise
-- gap the recruiter's shelf was built to close.
--
-- ── WHY A SEPARATE TABLE, RATHER THAN ats_candidates.folder_kind/folder_key ──
--
-- This is the whole reason the feature is not four lines of reuse. The recruiter's filing lives in
-- two columns ON THE CANDIDATE, one filing per CV, and filing a CV REMOVES IT FROM THE POOL every
-- recruiter is working from (see partitionCandidatesByFolder in candidate-folder.ts). So if a
-- manager filed through those same columns:
--
--   • a District Manager tidying his own inbox would make the CV disappear from Talent Acquisition's
--     pool, with nothing on either screen explaining where it went; and
--   • the second manager to file the same candidate would silently overwrite the first, because
--     there is only one pair of columns to hold the answer.
--
-- One filing per candidate PER MANAGER, in a table of its own, is what makes both impossible. The
-- recruiter's shelf and the manager's shelf are two different people's filing cabinets and they
-- never touch — measured 2026-08-30, 0 of the 36 pushed CVs carried a recruiter filing at all, so
-- reusing that column would also have started every manager's folders empty.
--
-- ── THE VOCABULARY IS SHARED ON PURPOSE ─────────────────────────────────────
--
-- Same three shelves as the recruiter's — Medical Representative by area, District Manager by
-- region, Other positions by job title — because the owner asked for folders "like me", and a
-- manager and a recruiter discussing the same CV must be using the same words for where it is. The
-- CHECK below therefore mirrors ats_candidates' own, deliberately duplicated rather than shared:
-- these two tables are allowed to be filed independently, but not to disagree about what a shelf is.
--
-- ── MIXED-CASE HR_IDs ───────────────────────────────────────────────────────
--
-- HR_IDs in this database are mixed case, and a plain equality match on one has already under-
-- returned by 28% elsewhere in this codebase. `manager_hr_id_norm` is the canonical key and the
-- application writes it with canonicalHrIdKey() — NOT a generated lower() column, because that
-- function also folds the legacy alias aaa -> aa, and SQL doing its own half of the normalisation
-- is exactly how the two halves drift apart. The unique index is on the normalised column, so one
-- manager cannot file the same CV twice by reaching the route with a differently-cased id.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ats_candidate_manager_folders (
  id                 bigint generated always as identity primary key,
  -- No foreign key, matching ats_candidate_comments and ats_candidate_status_events: a candidate can
  -- be hard-deleted, and a manager's filing should not take the row with it or block the delete.
  candidate_id       uuid        not null,
  -- As supplied, for display and audit. The NORM column below is what anything matches on.
  manager_hr_id      text        not null,
  manager_hr_id_norm text        not null,
  kind               text        not null,
  folder_key         text        not null,
  filed_at           timestamptz not null default now(),
  -- Whoever pressed the button. Normally the manager themselves; kept apart from manager_hr_id
  -- because the two differ the moment anyone files on somebody's behalf, and NULL means "not
  -- recorded", never "system".
  filed_by_hr_id     text,
  constraint ats_candidate_manager_folders_kind_check
    check (kind in ('medical_rep', 'district_manager', 'other')),
  constraint ats_candidate_manager_folders_key_not_blank
    check (btrim(folder_key) <> ''),
  constraint ats_candidate_manager_folders_key_length
    check (char_length(folder_key) <= 120),
  constraint ats_candidate_manager_folders_manager_not_blank
    check (btrim(manager_hr_id) <> '' and btrim(manager_hr_id_norm) <> '')
);

comment on table public.ats_candidate_manager_folders is
  'A manager''s own filing of a CV into one of the three recruitment shelves. Separate from ats_candidates.folder_kind/folder_key on purpose: that one is the recruitment team''s and filing there removes the CV from their pool. One row per candidate per manager, keyed on manager_hr_id_norm because HR_IDs here are mixed case.';
comment on column public.ats_candidate_manager_folders.manager_hr_id_norm is
  'canonicalHrIdKey(manager_hr_id) — written by the application, not generated in SQL, because that function also folds the legacy alias aaa -> aa.';
comment on column public.ats_candidate_manager_folders.kind is
  'medical_rep | district_manager | other — the same three shelves as ats_candidates.folder_kind, duplicated so the two tables can be filed independently but cannot disagree about what a shelf is.';

-- One filing per candidate per manager: filing again MOVES the CV rather than adding a second row.
create unique index if not exists ats_candidate_manager_folders_unique_idx
  on public.ats_candidate_manager_folders (candidate_id, manager_hr_id_norm);

-- The read this table exists to serve: "everything HE has filed", newest first.
create index if not exists ats_candidate_manager_folders_manager_idx
  on public.ats_candidate_manager_folders (manager_hr_id_norm, filed_at desc);

alter table public.ats_candidate_manager_folders enable row level security;

drop policy if exists phx_ats_candidate_manager_folders_service_role on public.ats_candidate_manager_folders;
create policy phx_ats_candidate_manager_folders_service_role
  on public.ats_candidate_manager_folders
  to service_role using (true) with check (true);

grant all on table public.ats_candidate_manager_folders to service_role;

-- Deliberately NO grant to anon or authenticated. Visibility in this app is application-scoped:
-- every read goes through the service-role client behind a route that has already proved the
-- viewer's place in the org chart, and these rows say which job applicants a named manager is
-- keeping in reserve.

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--
--   drop table if exists public.ats_candidate_manager_folders;
--
-- Dropping it destroys every manager's filing and returns their whole inbox to one flat list. No
-- other table reads it and no candidate row changes, so nothing else breaks. Take a copy first if
-- any rows exist.
-- ─────────────────────────────────────────────────────────────────────────────
