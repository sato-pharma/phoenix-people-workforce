-- Recruitment / ATS — the CV's own fingerprint.
--
-- APPLY THIS BEFORE THE CODE SHIPS. uploadCandidateFile writes content_md5 on EVERY insert, and a
-- merge to main deploys to production within minutes. Deploy first and every CV upload fails on a
-- column that does not exist yet — the deploy-before-migration window, on the one path the whole
-- recruitment intake runs through. This file is additive and re-runnable, so it is safe to apply
-- against the code currently live; the reverse order is not.
--
-- WHY. createCandidate dedupes on national ID, then email. candidate-matching.ts deliberately keeps
-- phone OUT of that decision, because phone matching once merged three different applicants into one
-- record. A WhatsApp CV usually carries neither a national ID nor an email, and its phone belongs to
-- whoever FORWARDED it — measured 2026-09-05, three numbers in the live pool each carry CVs for two
-- or three different people. So nothing matches, and an identical CV arriving twice creates a second
-- candidate every time.
--
-- Measured on production 2026-09-05: 986 CV files hold only 739 distinct documents. 247 files are
-- byte-identical copies of another; 226 of those sit on the SAME candidate, and 21 created a
-- duplicate candidate record. One of the duplicated pairs had already been sent to a hiring manager
-- under one record while the identical CV sat untouched under the other.
--
-- WHY A HASH AND NOT A NAME. Names repeat and files get renamed: the same document arrived as "Hams"
-- and as "Hams Sameh M.", and as "Abdo & Hussein" and as the applicant's full name. The bytes do not
-- change. A byte-identical CV is the one duplicate signal in this pool that is PROOF rather than
-- resemblance — which is precisely what 20260905051500's duplicate shelf records that phone and name
-- matching are NOT. That shelf stays the answer for a resemblance; this column is for an identity.
--
-- NOTHING IS BACKFILLED HERE, and no row changes meaning by running this. The column starts null;
-- uploadCandidateFile fills it from now on, and a separate one-off pass fills the existing rows from
-- the storage object's own MD5 (storage.objects.metadata->>'eTag').
--
-- SAFE TO RE-RUN — both statements are if-not-exists, and the column is nullable with no default, so
-- this rewrites no table and takes no long lock.

alter table public.ats_files
  add column if not exists content_md5 text;

create index if not exists ats_files_content_md5_idx
  on public.ats_files (content_md5)
  where content_md5 is not null;

comment on column public.ats_files.content_md5 is
  'MD5 of the file bytes, written at upload time by uploadCandidateFile. The one duplicate signal in this pool that is proof rather than resemblance: an identical CV attaches to the candidate who already owns it instead of spawning a second record. Null on rows uploaded before 2026-09-05 that the backfill has not reached.';
