-- Recruitment / ATS — track each CV's copy in the owner's Google Drive.
--
-- WHY NEW COLUMNS RATHER THAN THE EXISTING ONE. `ats_files.drive_file_id` is named for a Drive
-- integration that never went live; it actually holds the SUPABASE STORAGE object path
-- ("cv/<uuid>/<name>.pdf") for all 950 rows, and the whole download path reads it. Reusing it for a
-- real Drive id would break every existing file. The column keeps its meaning and its misleading
-- name; the Drive mirror gets its own, unambiguous ones.
--
-- SUPABASE STORAGE REMAINS THE SOURCE OF TRUTH. Drive is a MIRROR the owner browses, not the app's
-- backend: the app keeps serving CVs through its own permission-gated download route. So every
-- column here is nullable and nothing depends on it — a Drive outage, a revoked token or a folder
-- the owner deletes by hand degrades to "not mirrored yet" and never to a CV the app cannot open.

alter table public.ats_files
  add column if not exists drive_mirror_file_id text,
  add column if not exists drive_mirror_path text,
  add column if not exists drive_mirror_at timestamptz,
  add column if not exists drive_mirror_error text;

comment on column public.ats_files.drive_mirror_file_id is
  'Google Drive file id of the mirrored copy in the owner''s Drive. NULL means not mirrored yet. Distinct from drive_file_id, which despite its name holds the Supabase Storage object path.';
comment on column public.ats_files.drive_mirror_path is
  'The folder path the mirror was last filed under, slash-joined (e.g. "Medical Representative/Alex-BHR/Alex Center"). Compared against the candidate''s current folder to decide whether the file needs moving.';
comment on column public.ats_files.drive_mirror_at is
  'When the mirror was last uploaded or moved.';
comment on column public.ats_files.drive_mirror_error is
  'Last mirror failure, in words, or NULL. Set so a failure is visible without reading logs; cleared on the next success.';

-- The backfill and the retry sweep both ask the same question: which CVs still have no Drive copy?
-- Partial, so it indexes only the shrinking set of unmirrored rows rather than all 950 and growing.
create index if not exists ats_files_drive_mirror_pending_idx
  on public.ats_files (created_at)
  where drive_mirror_file_id is null;

-- Finding a mirrored file to MOVE, once its applicant finally answers the WhatsApp questions. The
-- lookup is by candidate, and only mirrored rows can move.
create index if not exists ats_files_drive_mirror_candidate_idx
  on public.ats_files (candidate_id)
  where drive_mirror_file_id is not null;
