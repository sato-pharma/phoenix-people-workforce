-- set_upload_limits_on_five_older_buckets
--
-- WHAT THIS CHANGES:
--   Five private storage buckets were created without a size limit, a file-type limit, or both.
--   Each now gets limits drawn from the code that writes to it and from every file it holds today
--   (read on production, 19 Nov 2026). Limits are checked on upload only: no stored file is read,
--   moved or removed, and every file already in these buckets would pass the new limits anyway.
--
--   bucket                         size before -> after   types before -> after
--   employee-photos                5 MB (kept)            any -> JPEG, PNG, WebP
--   job-exports                    none -> 50 MB          any -> Excel workbook, JSON, PDF
--   sales-imports                  20 MB (kept)           any -> Excel (.xlsx, .xls), generic binary
--   whatsapp-inbox-media           100 MB (kept)          any -> images, video, audio, documents, plain text, CSV, contact cards
--   notification-held-attachments  40 MB (kept)           any -> images, documents, plain text, CSV, calendar invites, saved emails
--
-- WHY:
--   The 18 Nov 2026 Supabase audit found these five as the only buckets without both limits; every
--   bucket created since September carries them. A bucket with no type limit will store and serve a
--   web page or a script as readily as a photo, and one with no size limit takes whatever the
--   project-wide ceiling allows.
--
--   Per bucket, from the code on origin/main:
--   * employee-photos — src/lib/employees/employee-photo.ts already refuses anything but JPEG, PNG
--     and WebP over 5 MB before uploading; the bucket now says the same. Held: 116 JPEG, 18 PNG, 1 WebP.
--   * job-exports — src/lib/background-jobs/worker.ts writes Excel workbooks and
--     `application/json; charset=utf-8`; src/lib/chatgpt-connector/files.ts writes Excel and PDF.
--     Largest file ever held: 4.1 MB, so 50 MB is twelve times the largest.
--   * sales-imports — the one bucket a browser writes to directly, through a signed upload URL
--     (src/components/sales/*-upload-workspace.tsx, sales-import-workspace.tsx). The screens accept
--     .xlsx and .xls and send the file's own type, falling back to the .xlsx type when the browser
--     reports none. `application/octet-stream` stays allowed so a computer that labels a workbook
--     generically still uploads; a file of that type is served as a download, never rendered.
--   * whatsapp-inbox-media — src/lib/whatsapp-inbox/store.ts copies what senders outside the company
--     send, under the type Meta reports. Every family that has ever arrived stays allowed (production:
--     696 PDF, 83 MP4, 50 Word, 49 JPEG, 6 old Word, 4 voice notes `audio/ogg; codecs=opus`, 3
--     PowerPoint, 2 WebP stickers, 1 PNG). What it now refuses is a sender's web page or script
--     (`text/html`, `text/javascript`, `text/xml`).
--   * notification-held-attachments — src/lib/notifications/confidence-gate.ts keeps a held email's
--     attachments until it is approved. A file it cannot keep is recorded and approving that email is
--     refused, never sent without it (the code says so), so a refused type is loud, not silent.
--
-- ROLLBACK (restores the exact earlier values):
--   update storage.buckets set allowed_mime_types = null
--    where id in ('employee-photos','sales-imports','whatsapp-inbox-media','notification-held-attachments');
--   update storage.buckets set file_size_limit = null, allowed_mime_types = null where id = 'job-exports';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: five configuration rows change, no file is touched, and it is safe to replay.

begin;

update storage.buckets
   set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'employee-photos';

update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array[
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/json',
         'application/pdf'
       ]
 where id = 'job-exports';

update storage.buckets
   set allowed_mime_types = array[
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-excel',
         'application/octet-stream'
       ]
 where id = 'sales-imports';

update storage.buckets
   set allowed_mime_types = array[
         'image/*', 'video/*', 'audio/*', 'application/*',
         'text/plain', 'text/csv', 'text/vcard', 'text/x-vcard'
       ]
 where id = 'whatsapp-inbox-media';

update storage.buckets
   set allowed_mime_types = array[
         'image/*', 'application/*',
         'text/plain', 'text/csv', 'text/calendar', 'message/rfc822'
       ]
 where id = 'notification-held-attachments';

-- Fail loudly if the result is not what this migration claims.
do $$
declare
  v_missing int;
begin
  select count(*) into v_missing
    from (values ('employee-photos'), ('job-exports'), ('sales-imports'),
                 ('whatsapp-inbox-media'), ('notification-held-attachments')) as want(id)
    left join storage.buckets b on b.id = want.id
   where b.id is null or b.file_size_limit is null or b.allowed_mime_types is null;
  if v_missing > 0 then
    raise exception '% of the five buckets still lack a size or type limit (or do not exist)', v_missing;
  end if;
end
$$;

commit;
