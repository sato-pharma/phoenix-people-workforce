-- Recruitment / ATS — the duplicate shelf.
--
-- WHY. ats_candidates.folder_kind is fenced by a CHECK listing the four POSITION shelves
-- (medical_rep, district_manager, other, paramedical). Each answers "which seat is this good CV
-- waiting for". Archiving a record as a duplicate of another is a different act — a discard of a
-- redundant ROW, not a hold — and it had nowhere to go, so the screening queue could report a
-- probable duplicate and offer nothing to do about it.
--
-- WHY A SHELF AND NOT A DELETE. The pairing is never proof. src/lib/recruitment/candidate-matching.ts
-- keeps the identity rule LOCKED to national ID then email, and records that phone matching once
-- "merged three different applicants into one record". Measured on production 2026-09-05: ZERO
-- national-id collisions and ZERO email collisions in the live pool, against 6 shared-phone groups
-- and 2 identical-name groups. So every duplicate a person archives today rests on evidence the
-- application refuses to merge on — families share a handset, and Egyptian names repeat. Filing is
-- reversible and preserves the row, its files and its history; a delete would not be.
--
-- SAFE TO RE-RUN. Drops and recreates the one CHECK, which is the only way to widen an IN-list
-- constraint in Postgres. The sibling constraint ats_candidates_folder_complete is untouched: it
-- still requires folder_kind, folder_key and folder_filed_at to be present or absent together, so a
-- half-written shelf stays impossible.
--
-- NOTHING IS BACKFILLED. No existing row becomes a duplicate by running this; the shelf starts
-- empty and only a person puts anything on it.

alter table public.ats_candidates
  drop constraint if exists ats_candidates_folder_kind_known;

alter table public.ats_candidates
  add constraint ats_candidates_folder_kind_known
  check (
    folder_kind is null
    or folder_kind = any (array['medical_rep'::text, 'district_manager'::text, 'other'::text, 'paramedical'::text, 'duplicate'::text])
  );

comment on constraint ats_candidates_folder_kind_known on public.ats_candidates is
  'The shelves a CV can be filed on. Four are positions (which seat is this good CV waiting for); "duplicate" is the one discard shelf, added 2026-09-05 — reversible, because a duplicate pairing is never proof.';
