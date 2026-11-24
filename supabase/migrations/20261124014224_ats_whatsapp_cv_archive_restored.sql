-- ats_whatsapp_cv_archive_restored
--
-- WHAT THIS CHANGES: two NEW nullable columns on public.ats_whatsapp_cv_archive — restored_at and
-- restored_to_candidate_id — and a partial index on the rows still in the Archive. No existing row
-- is rewritten by this file.
--
-- WHY (owner, 24 Nov 2026: "get from archive to recruitment module any office coordinator or any hr
-- role", then "and the google drive and everywhere"): the Office Coordinator and Human Resources
-- applicants kept in the WhatsApp CV Archive go back into Recruitment as live candidates, with their
-- CVs in the recruitment-files bucket and the owner's Drive cabinet. The Archive row is KEPT (never
-- deleted) and marked restored, so the Archive under WhatsApp Applicants stops listing a person who
-- is now a candidate, and the row still says who they were and where they went.
--
--   restored_at               — when the person was brought back into Recruitment. NULL = still archived.
--   restored_to_candidate_id  — the live candidate they now are: the same id for a plain restore, or
--                               the live record they were merged into when they had applied again.
--                               No foreign key, like the rest of this table: a later candidate delete
--                               must not reach back into the Archive.
--
-- ROLLBACK:
--   drop index if exists public.ats_whatsapp_cv_archive_unrestored_idx;
--   alter table public.ats_whatsapp_cv_archive drop column if exists restored_to_candidate_id;
--   alter table public.ats_whatsapp_cv_archive drop column if exists restored_at;
--   (the Archive then lists the restored people again, beside their live candidate records)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This
-- migration adds two empty columns and rewrites no row.

begin;
set local lock_timeout = '5s';

alter table public.ats_whatsapp_cv_archive
  add column if not exists restored_at timestamptz,
  add column if not exists restored_to_candidate_id uuid;

create index if not exists ats_whatsapp_cv_archive_unrestored_idx
  on public.ats_whatsapp_cv_archive (received_at desc)
  where restored_at is null;

comment on column public.ats_whatsapp_cv_archive.restored_at is
  'When this archived applicant was brought back into Recruitment as a live candidate. NULL = still in the Archive.';
comment on column public.ats_whatsapp_cv_archive.restored_to_candidate_id is
  'The live ats_candidates id this archived applicant now is (same id, or the record they were merged into).';

commit;
