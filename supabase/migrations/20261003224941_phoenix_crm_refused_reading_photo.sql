-- ════════════════════════════════════════════════════════════════════════════════════════════════
--  Phoenix CRM — A REFUSED CAPTURE KEEPS ITS PHOTO
--
--  Owner, 2026-10-03: "save the photo when a validation is refused."
--
--  WHAT  One nullable column on `phoenix_crm_refused_readings`: the storage path of the live photo
--        the refused capture was carrying. Nothing else — no table, no function, no view, no
--        constraint, and nothing existing is altered in behaviour.
--
--  WHY   20261003211500 gave a refusal its NUMBERS and still threw away its PICTURE. The JPEG was
--        already in the bucket — the browser PUTs it to its slot before the save is even attempted —
--        but nothing pointed at it: `phoenix_crm_photo_uploads` records only that a slot was asked
--        for, and a refused place or visit row is never created. So the one piece of evidence that
--        shows where the rep was actually standing, readable by a person rather than inferred from a
--        radius, could be found only by hand-joining unused slots to `storage.objects`. That is
--        exactly how both of 3 October's incidents had to be reconstructed, hours late.
--
--        With the path on the row, a refusal is now one read: its reading, its line, its clock, and
--        the photograph the rep took. `/api/phoenix-crm/photos/sign` turns the path into a viewable
--        URL under the module's own `read` gate, so no new door is opened to reach it.
--
--  🔴 NOTHING IS UPLOADED, COPIED OR DELETED BY THIS. The bytes exist already and no sweep removes
--  an unused slot, so "save the photo" is a POINTER being kept, not a second copy being written. If
--  a purge of unused slots is ever added, it must exempt a path named here — otherwise this column
--  starts pointing at objects that are gone, which is worse than not having it.
--
--  🔴 GOLDEN RULE #1 IS UNTOUCHED. The rep's refusal is byte-for-byte the one he read before this
--  column existed; the photo he already took is simply no longer orphaned. Nothing is added to his
--  day, nothing is drawn, and the row stays service-role only — readable above him alone.
--
--  ROLLBACK  begin;
--              alter table public.phoenix_crm_refused_readings drop column if exists photo_path;
--            commit;
--
--            Safe: the column is nullable, nothing reads it but the Super Admin's own queries, and
--            the writer (src/lib/phoenix-crm/server/refused-readings.ts) swallows its own errors —
--            so a dropped column costs the pointer and never a rep his work.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '5s';

-- `add column ... if not exists` with no default and no NOT NULL: a metadata-only change on
-- PostgreSQL, so it does not rewrite the table and cannot block the writer mid-field-day.
alter table public.phoenix_crm_refused_readings
  add column if not exists photo_path text;

comment on column public.phoenix_crm_refused_readings.photo_path is
  'Storage path of the live photo the refused capture was carrying (owner, 2026-10-03: "save the photo when a validation is refused"). The object already exists — the browser uploads it to its slot before the save is attempted — so this is a pointer kept, never a second copy. Null for a visit refused with no photo. Sign it through /api/phoenix-crm/photos/sign.';

-- The read this column exists for: "show me every refusal that has a picture, newest first".
create index if not exists phoenix_crm_refused_readings_photo_idx
  on public.phoenix_crm_refused_readings (refused_at desc)
  where photo_path is not null;

notify pgrst, 'reload schema';

commit;
