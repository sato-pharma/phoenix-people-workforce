-- job_exports_bucket_accepts_connector_captures
--
-- WHAT THIS CHANGES:
--   The private `job-exports` bucket also accepts PNG pictures and MP4 / WebM videos. Its list
--   goes from Excel workbook, JSON, PDF to Excel workbook, JSON, PDF, PNG, MP4, WebM. The 50 MB size
--   limit is kept. Limits apply on upload only: no stored file is read, moved or removed.
--
-- WHY:
--   The ChatGPT connector's screenshot and video tools (20261120111031) store their captures in this
--   bucket through src/lib/chatgpt-connector/files.ts. The 19 Nov migration
--   20261119013709_set_upload_limits_on_five_older_buckets limited this bucket to the three types
--   the code wrote at the time. So on production, 20 Nov 2026 at 11:48 Cairo, both screenshot
--   attempts from ChatGPT failed with "StorageApiError: mime type image/png is not supported".
--   CONNECTOR_FILE_CONTENT_TYPES in files.ts is now the list the bucket must accept, and
--   tests/chatgpt-connector-capture.test.ts keeps the two equal.
--
-- ROLLBACK (restores the exact earlier list):
--   update storage.buckets
--      set allowed_mime_types = array[
--            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
--            'application/json',
--            'application/pdf'
--          ]
--    where id = 'job-exports';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This is neither destructive nor bulk: one configuration row changes, no file is touched, and it
-- is safe to replay.

begin;

update storage.buckets
   set allowed_mime_types = array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/json', 'application/pdf', 'image/png', 'video/mp4', 'video/webm']
 where id = 'job-exports';

do $$
declare
  v_types text[];
begin
  select allowed_mime_types into v_types from storage.buckets where id = 'job-exports';
  if v_types is null or not (v_types @> array['image/png', 'video/mp4', 'video/webm']) then
    raise exception 'job-exports does not accept the connector capture types (allowed: %)', v_types;
  end if;
end
$$;

commit;
