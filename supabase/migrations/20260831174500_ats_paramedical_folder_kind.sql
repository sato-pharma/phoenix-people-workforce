-- Recruitment / ATS — a fourth shelf: Paramedical.
--
-- The owner, 2026-08-31: "I want the non science or pharmacy or vet to be excluded in a separate
-- folder. Name this folder paramedical." Asked the same day whether a doctor counts, he answered
-- "medicine and dentistry are accepted", so the ELIGIBLE set is five disciplines — pharmacy,
-- science, veterinary, medicine, dentistry — and this shelf holds everyone else.
--
-- ── WHY A FOURTH KIND RATHER THAN A FOLDER ON THE "other" SHELF ──────────────────────────────────
--
-- The "other" shelf is one folder per JOB TITLE — "Regulatory Affairs Specialist", "Marketing
-- Executive" — and a recruiter reads it as a list of roles somebody might be hired into. Paramedical
-- is not a role and nobody is hired into it; it is the answer to a different question entirely
-- ("is this person eligible for the field force at all"). Filing it there would need no migration,
-- which is the only argument for it, and would put an exclusion bucket in the middle of a list of
-- vacancies where it sorts alphabetically between two real job titles.
--
-- ── WHAT THIS MIGRATION DOES NOT DO ─────────────────────────────────────────────────────────────
--
-- It files NOBODY. It widens two CHECK constraints and updates two comments, and that is all. The
-- backfill is a separate, reversible step, and it is deliberately not folded in here: the owner's
-- instruction splits the two directions and only one of them may happen without a person.
--
--   "the two hundred eligible, you will backfill them. But anyone non eligible, you will make the
--    admin be able to check first their CV and confirm."
--
-- Filing somebody as Paramedical takes them off the screen the recruiters work from, and nothing
-- ever brings them back — nobody re-reads a folder named for people who were filtered out. So no
-- row reaches this shelf without an admin having looked at that CV, and a migration is exactly the
-- wrong place to make that decision for 146 people at once.
--
-- BOTH tables are widened together. ats_candidate_manager_folders duplicates this vocabulary on
-- purpose — its own comment says the two "cannot disagree about what a shelf is" — so leaving it
-- behind would make a shelf that exists for the recruitment team and not for a manager, which is the
-- drift that duplication was accepted in order to avoid. In practice a manager will not file here:
-- a paramedical CV is one that never reaches a district manager at all.
--
-- REVERSIBLE. Narrowing both constraints back requires only that no row uses the new value; the
-- rollback at the foot of this file does that check rather than assuming it.
--
-- ── APPLIED 2026-08-31, ON BOTH PROJECTS — DO NOT RE-APPLY ──────────────────────────────────────
--
--   production  ozucdzovmcqvepbozvqf   ledger version 20260831162442
--   staging     cifwmndunmlxjhyjugxa   ledger version 20260831162537
--
-- Applied with the owner's explicit approval, ahead of the merge rather than after it: the code
-- half offers a Paramedical shelf, and a deploy that reached production first would have let a
-- recruiter press File against a constraint that did not yet allow the value.
--
-- NEITHER ledger version matches this filename, and neither ever will — apply_migration stamps the
-- MCP server's clock, not the repo timestamp, and the two projects were stamped 55 seconds apart, so
-- no single filename could match both. The nightly drift check survives that: it matches by version
-- OR by NAME, and both ledgers recorded the name `ats_paramedical_folder_kind`, which is exactly
-- this file's slug. Renaming this file to chase one of the versions would break the match on the
-- other. Verified by reading scripts/check-migrations-applied.ts, not assumed.
--
-- Verified live against pg_constraint on both projects (never list_migrations): both CHECKs read
-- four values and both are convalidated. Production's data was identical either side of the change
-- — 514 unfiled, 76 medical_rep, 11 district_manager, 2 other — which is the point: it files
-- nobody.

begin;

-- ── ats_candidates — the recruitment team's own shelf ────────────────────────────────────────────
alter table public.ats_candidates
  drop constraint if exists ats_candidates_folder_kind_known;

alter table public.ats_candidates
  add constraint ats_candidates_folder_kind_known check (
    folder_kind is null
    or folder_kind in ('medical_rep', 'district_manager', 'other', 'paramedical')
  );

comment on column public.ats_candidates.folder_kind is
  'medical_rep (one folder per area) | district_manager (one folder per region) | other (one folder per job title) | paramedical (one folder, for graduates outside the five eligible disciplines — pharmacy, science, veterinary, medicine, dentistry). Paramedical is an eligibility answer rather than a role, and a CV only reaches it after an admin has read it: see candidate-background.ts for why the exclusive direction never auto-files.';

-- ── ats_candidate_manager_folders — a manager's own shelf, same vocabulary ───────────────────────
alter table public.ats_candidate_manager_folders
  drop constraint if exists ats_candidate_manager_folders_kind_check;

alter table public.ats_candidate_manager_folders
  add constraint ats_candidate_manager_folders_kind_check
    check (kind in ('medical_rep', 'district_manager', 'other', 'paramedical'));

comment on column public.ats_candidate_manager_folders.kind is
  'medical_rep | district_manager | other | paramedical — the same four shelves as ats_candidates.folder_kind, duplicated so the two tables can be filed independently but cannot disagree about what a shelf is.';

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Narrowing back is safe only while nothing is filed on the new shelf. Run the two counts FIRST and
-- expect 0 from both; a non-zero result means somebody has been filed as Paramedical and narrowing
-- the constraint would fail on them — unfile those candidates before reverting, never delete them.
--
--   select count(*) from public.ats_candidates                where folder_kind = 'paramedical';
--   select count(*) from public.ats_candidate_manager_folders where kind        = 'paramedical';
--
-- begin;
--   alter table public.ats_candidates
--     drop constraint if exists ats_candidates_folder_kind_known;
--   alter table public.ats_candidates
--     add constraint ats_candidates_folder_kind_known check (
--       folder_kind is null or folder_kind in ('medical_rep', 'district_manager', 'other')
--     );
--   alter table public.ats_candidate_manager_folders
--     drop constraint if exists ats_candidate_manager_folders_kind_check;
--   alter table public.ats_candidate_manager_folders
--     add constraint ats_candidate_manager_folders_kind_check
--       check (kind in ('medical_rep', 'district_manager', 'other'));
-- commit;
