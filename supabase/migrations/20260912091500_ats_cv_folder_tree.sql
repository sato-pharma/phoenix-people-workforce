-- Recruitment / ATS — the folder tree a recruiter builds BY HAND, and the CVs pushed into it.
--
-- Owner, 2026-09-12, in his own words:
--
--   "in /recruitment i want 2 be able to do a folder and subfolder and push cvs their and move
--    them copy or paste to another folder"
--
-- ── WHY THIS IS NOT THE SHELF WE ALREADY HAVE ───────────────────────────────────────────────────
--
-- `ats_candidates.folder_kind` / `folder_key` (migration 20260830180000) is FOUR FIXED SHELVES whose
-- folders are derived from the company's own vocabulary — an area name, a region code, a job title.
-- Three properties of that design are each the exact opposite of what was asked for here, and none
-- of them can be relaxed without changing what the shelf means for the CVs already sitting on it:
--
--   nobody creates a folder   the folders ARE the area/region/title lists, so they cannot drift
--                             from the Organogram. That is the feature, not a limitation.
--   nothing nests             two levels, kind then key, and the kind list is the owner's own.
--   one folder per CV         the filing lives in four columns ON the candidate row, so a second
--                             filing overwrites the first. "Copy" is not expressible at all.
--
-- So this is a SECOND tree, beside the shelves, and the two never touch. A CV can be on a shelf, in
-- this tree, in both, or in neither.
--
-- ── WHY A JOIN TABLE AND NOT MORE COLUMNS ───────────────────────────────────────────────────────
--
-- Because he asked for COPY. A copy is the same CV in two folders at once, which is a many-to-many
-- relation and cannot be stored on the candidate row however many columns are added. `move` is then
-- the ordinary case — delete the old membership, insert the new one — rather than a special one.
--
-- ── THE CV STILL LEAVES THE POOL ────────────────────────────────────────────────────────────────
--
-- Asked directly on 2026-09-12 whether a CV in one of these folders should stay in the main
-- candidate list, he chose the same behaviour the shelves already have: it disappears. So the
-- question the pool asks is "does this candidate have AT LEAST ONE row here", not "which folder" —
-- `isFiledCandidate` in src/lib/recruitment/candidate-folder.ts answers both halves in one place,
-- which is what stops the pool and the folder screen disagreeing about who is hidden. Returning a
-- CV to the pool removes EVERY membership, never just one, or a "copy" made last month would keep
-- somebody hidden after they were explicitly put back.
--
-- ── REVERSIBLE BY CONSTRUCTION ──────────────────────────────────────────────────────────────────
--
-- Nothing here writes to `ats_candidates`, `ats_files` or anything else. Dropping both tables
-- returns every CV to the pool and loses nothing but the arrangement.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE TREE
--
-- `parent_id is null` means a top-level folder. Depth is NOT stored: it is enforced in the
-- application (MAX_CV_FOLDER_DEPTH in src/lib/recruitment/cv-folder-tree.ts) because the whole tree
-- is a few hundred rows read in one query, and a stored depth is a second copy of the parent chain
-- that goes wrong the first time a subtree is moved.
--
-- CYCLES are likewise refused in the application, on the same read — moving a folder into its own
-- descendant is the only way to make one, and the move path already holds every row it needs to see
-- that. A recursive CHECK is not expressible in Postgres without a trigger, and a trigger here would
-- be a third place that knows what a legal tree is.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ats_cv_folders (
  id             uuid        primary key default gen_random_uuid(),
  -- ON DELETE CASCADE so a subtree cannot be orphaned into rows nothing can reach. The application
  -- refuses to delete a folder whose subtree holds any CV at all, so the cascade only ever reaches
  -- empty folders through the app; it is here for the hand-SQL case, where a stranded child is
  -- worse than a deleted one because nothing on any screen would ever show it again.
  parent_id      uuid        references public.ats_cv_folders (id) on delete cascade,
  -- As typed, and this is what every screen prints.
  name           text        not null,
  -- lower(name) with whitespace collapsed, written by the application. Uniqueness is enforced on
  -- THIS and not on `name`, so "Alex Team" and "alex team" cannot both exist under one parent and
  -- read as two folders. Not a generated column, matching ats_candidate_manager_folders: the
  -- normalisation is the application's rule and SQL doing half of it is how the halves drift.
  name_key       text        not null,
  created_at     timestamptz not null default now(),
  -- Whoever created it. NULL means "not recorded" — a dev-preview session carries no HR_ID — and
  -- never "system", exactly as with status_changed_by_hr_id.
  created_by_hr_id text,
  constraint ats_cv_folders_name_not_blank
    check (btrim(name) <> '' and btrim(name_key) <> ''),
  constraint ats_cv_folders_name_length
    check (char_length(name) <= 120),
  -- A name is one folder, never a path. A "/" would read as two folders in any path-shaped view of
  -- the tree, and a control character would render as nothing at all.
  constraint ats_cv_folders_name_has_no_separator
    check (name !~ '[/\\]' and name !~ '[[:cntrl:]]'),
  -- Its own parent is the one cycle a single row can make, and the only one SQL can see.
  constraint ats_cv_folders_not_its_own_parent
    check (parent_id is null or parent_id <> id)
);

comment on table public.ats_cv_folders is
  'Recruitment: the hand-built CV folder tree — folders and subfolders a recruiter creates, as opposed to the four derived shelves in ats_candidates.folder_kind. Owner request 2026-09-12. Depth and cycles are enforced in src/lib/recruitment/cv-folder-tree.ts, not here.';
comment on column public.ats_cv_folders.parent_id is
  'The folder this one sits inside. NULL is a top-level folder.';
comment on column public.ats_cv_folders.name_key is
  'Normalised name (lower-cased, whitespace collapsed) written by the application. Two folders under one parent cannot share it.';

-- Two partial indexes rather than one, because NULL is not equal to NULL in a unique index: a plain
-- unique on (parent_id, name_key) would let a hundred top-level folders share a name while
-- correctly rejecting duplicates everywhere else — and the root is exactly where duplicates are most
-- confusing to look at.
create unique index if not exists ats_cv_folders_child_name_idx
  on public.ats_cv_folders (parent_id, name_key)
  where parent_id is not null;

create unique index if not exists ats_cv_folders_root_name_idx
  on public.ats_cv_folders (name_key)
  where parent_id is null;

create index if not exists ats_cv_folders_parent_idx
  on public.ats_cv_folders (parent_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS IN EACH FOLDER
--
-- One row per (folder, candidate). A CV in three folders has three rows, which is what makes a copy
-- a copy. No foreign key to ats_candidates, matching ats_candidate_comments,
-- ats_candidate_status_events and ats_candidate_manager_folders: a candidate can be hard-deleted,
-- and a filing should neither block that delete nor disappear a folder's contents with it.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ats_cv_folder_items (
  id             bigint      generated always as identity primary key,
  folder_id      uuid        not null references public.ats_cv_folders (id) on delete cascade,
  candidate_id   uuid        not null,
  filed_at       timestamptz not null default now(),
  filed_by_hr_id text
);

comment on table public.ats_cv_folder_items is
  'Recruitment: which CVs are in which hand-built folder. One row per (folder, candidate) — a CV copied into a second folder has two rows, which is the whole reason this is a join table and not columns on ats_candidates. A candidate with AT LEAST ONE row here is hidden from the main pool (owner decision 2026-09-12); returning them to the pool deletes every row, never one.';
comment on column public.ats_cv_folder_items.filed_by_hr_id is
  'Who pushed it here. NULL means not recorded (a dev-preview session has no HR_ID), never "system".';

-- The same CV cannot be added to the same folder twice — a second push is a no-op, not a duplicate
-- line in the folder.
create unique index if not exists ats_cv_folder_items_unique_idx
  on public.ats_cv_folder_items (folder_id, candidate_id);

-- "Is this candidate filed anywhere?" — the question the pool asks about every row it renders, and
-- the one that decides whether a CV is visible at all.
create index if not exists ats_cv_folder_items_candidate_idx
  on public.ats_cv_folder_items (candidate_id);

-- "What is in this folder, newest first" — the folder screen's own read.
create index if not exists ats_cv_folder_items_folder_idx
  on public.ats_cv_folder_items (folder_id, filed_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- ACCESS
--
-- Service-role only, deliberately, and identical to ats_candidate_manager_folders. Visibility in
-- this app is application-scoped: every read here goes through the service-role client behind a
-- route that has already checked `candidates: read`. These rows say which job applicants the
-- recruitment team is keeping in reserve and under what heading, so no anon or authenticated grant.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.ats_cv_folders enable row level security;
alter table public.ats_cv_folder_items enable row level security;

drop policy if exists phx_ats_cv_folders_service_role on public.ats_cv_folders;
create policy phx_ats_cv_folders_service_role
  on public.ats_cv_folders
  to service_role using (true) with check (true);

drop policy if exists phx_ats_cv_folder_items_service_role on public.ats_cv_folder_items;
create policy phx_ats_cv_folder_items_service_role
  on public.ats_cv_folder_items
  to service_role using (true) with check (true);

grant all on table public.ats_cv_folders to service_role;
grant all on table public.ats_cv_folder_items to service_role;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--
--   drop table if exists public.ats_cv_folder_items;
--   drop table if exists public.ats_cv_folders;
--
-- In that order — the items table's foreign key is what makes the reverse fail. Dropping both
-- returns every filed CV to the main pool (nothing on ats_candidates is touched by this feature at
-- all) and loses only the arrangement itself. Take a copy of both tables first if any rows exist:
-- the tree is somebody's filing work and cannot be re-derived from anything.
-- ─────────────────────────────────────────────────────────────────────────────
