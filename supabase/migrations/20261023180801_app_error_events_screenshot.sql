-- app_error_events_screenshot
--
-- WHAT THIS CHANGES:
--   1. adds `app_error_events.screenshot_path` (text, nullable) — the object key of the picture of
--      the screen the employee was looking at when the error fired, or null where none was taken;
--   2. creates the private `error-screenshots` bucket the pictures live in: 2 MB a file, WebP only.
--
-- WHY: the owner, 23 Oct 2026 — "the most important thing, I need a screenshot of the error appear
--   to the employee." A message and a stack say what threw; they do not say what the person was
--   looking at. The browser rasterises its own DOM once the error UI has painted and posts it to
--   /api/errors/client/screenshot, which admits it only on a two-minute signed ticket naming this
--   row. Nothing is masked in the image, by the owner's decision the same day, so the bucket is
--   private and stays private — a payslip that errors is photographed with the pay on it.
--
-- ROLLBACK:
--   alter table public.app_error_events drop column screenshot_path;
--   delete from storage.buckets where id = 'error-screenshots';
--   The bucket delete fails while objects remain, and objects are removed through the Storage API,
--   never with SQL (storage.protect_delete() raises 42501 on a delete from storage.objects). The
--   column drop is one-way for the paths already written; the image objects themselves survive it.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is destructive: one nullable column and one new, empty bucket.

begin;

alter table public.app_error_events
  add column if not exists screenshot_path text;

comment on column public.app_error_events.screenshot_path is
  'Object key in the private error-screenshots bucket for the capture of the screen this error was reported from, or null when none was taken. Written only by /api/errors/client/screenshot.';

-- Private, like every other bucket in this project. 2 MB matches the client-side ceiling in
-- src/lib/error-monitor/screenshot-intake.ts, and the mime allow-list is the second gate behind the
-- route's own magic-byte sniff.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('error-screenshots', 'error-screenshots', false, 2097152, array['image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;
