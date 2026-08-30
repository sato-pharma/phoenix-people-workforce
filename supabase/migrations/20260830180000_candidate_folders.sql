-- Recruitment / ATS — the CV shelf. Four columns that take a good CV off the main pool without
-- judging it, and put it in a named folder somebody will come back to when a seat opens.
--
-- Owner's instruction, 2026-08-30, in his own words:
--
--   "In recruitment, I want to make folders for areas ... if this CV is good, but I'm not needing
--    it now, I push the CV to the folder, and then I have every single archive ... folder for
--    medical reps for now and folder for district manager. The district managers will be who must
--    have six folders based on the regions. Medical reps have folders based on the areas and make
--    other folder for any other position."
--
--   "The CV that I push to a folder ... it is not appearing now on the main page."
--
-- He said six regions; the company has EIGHT (`au.regions` minus the UE-1/UE-2 sales subdivisions).
-- Asked directly the same day, he answered "8 regions, and split other positions by job title" —
-- so the district-manager shelf is keyed on the full `candidateRegionCodes` list, which already
-- includes Delta (3) and Others, and the other-positions shelf is keyed on the job title text.
--
-- WHY NEW COLUMNS RATHER THAN AN EXISTING ONE. Three columns on this table already look like they
-- would do, and every one of them would corrupt something that is already true:
--
--   preferred_region_code / preferred_area_name  the APPLICANT's own answer on WhatsApp about where
--                                                they want to work. A recruiter's filing decision
--                                                written here would overwrite what the candidate
--                                                said, and that field is read back to them.
--   manager_notified_*                           the send trail — who a CV went to and when.
--                                                Writing anything else there wipes it.
--   sent_for_*                                   the vacancy a CV was actually pushed for. Filing
--                                                happens when there is NO vacancy, which is the
--                                                whole point of the shelf.
--
-- WHY NOT A STATUS. `status` is a decision about the person (shortlisted, rejected, hired) and it
-- holds exactly one value. Filing is a decision about the QUEUE, not the person: a shortlisted
-- candidate filed for September must still read as shortlisted when they are pulled back out. Same
-- reasoning that kept "seen" out of the status vocabulary in candidate-views.ts.
--
-- REVERSIBLE BY CONSTRUCTION. Returning a CV to the pool is `set folder_kind = null, folder_key =
-- null, folder_filed_at = null, folder_filed_by_hr_id = null` — nothing is deleted, moved, or
-- rewritten anywhere else, so a filing that turns out to be wrong costs one click and loses no
-- history.

begin;

alter table public.ats_candidates
  -- 'medical_rep' | 'district_manager' | 'other'. Plain text with a CHECK rather than an enum,
  -- matching how `status` is handled on this table: the vocabulary lives in
  -- src/lib/recruitment/candidate-folder.ts and adding a fourth shelf should be a code change.
  add column if not exists folder_kind text,
  -- WHAT the folder is, and its meaning depends on the kind above:
  --   medical_rep       an area name, verbatim from au.canonical_areas ("Nasr City")
  --   district_manager  a region CODE from candidateRegionCodes ("D3"), never the label — the code
  --                     is the stable half, and "Delta (3)" is rendered from candidateRegionLabels
  --   other             the job title as typed or picked ("Regulatory Affairs Specialist")
  add column if not exists folder_key text,
  add column if not exists folder_filed_at timestamptz,
  add column if not exists folder_filed_by_hr_id text;

-- The four columns move together or not at all. A row carrying a kind but no key is a folder with
-- no name, and a row carrying a key but no filed_at is invisible to every "is this filed?" check —
-- both are states no code path can produce and neither should be storable by hand either.
alter table public.ats_candidates
  drop constraint if exists ats_candidates_folder_complete;

alter table public.ats_candidates
  add constraint ats_candidates_folder_complete check (
    (folder_kind is null and folder_key is null and folder_filed_at is null)
    or (folder_kind is not null and folder_key is not null and folder_filed_at is not null)
  );

alter table public.ats_candidates
  drop constraint if exists ats_candidates_folder_kind_known;

alter table public.ats_candidates
  add constraint ats_candidates_folder_kind_known check (
    folder_kind is null or folder_kind in ('medical_rep', 'district_manager', 'other')
  );

-- Every screen that reads the pool asks the same question first — "is this on the shelf?" — and the
-- answer is null for the overwhelming majority of rows, so a partial index over the filed ones is
-- both the small index and the one that serves the folder screen's own grouping.
create index if not exists ats_candidates_folder_idx
  on public.ats_candidates (folder_kind, folder_key)
  where folder_filed_at is not null;

comment on column public.ats_candidates.folder_kind is
  'CV shelf: which set of folders this candidate is filed under — medical_rep (by area), district_manager (by region code), or other (by job title). Null means the candidate is in the live pool. See src/lib/recruitment/candidate-folder.ts.';
comment on column public.ats_candidates.folder_key is
  'CV shelf: the folder itself — an area name, a candidateRegionCodes region CODE, or a job title, according to folder_kind.';
comment on column public.ats_candidates.folder_filed_at is
  'CV shelf: when this CV was filed. Non-null is the single authority for "hidden from the main pool".';
comment on column public.ats_candidates.folder_filed_by_hr_id is
  'CV shelf: who filed it. Nullable because a dev-preview session carries no HR_ID, exactly like status_changed_by_hr_id.';

commit;
