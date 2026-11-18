-- exact_type_lists_for_whatsapp_and_held_email_buckets
--
-- WHAT THIS CHANGES:
--   The two buckets that 20261119013709 left with wide family lists (`image/*`, `application/*` ...)
--   now carry EXACT type lists, like the other three:
--
--   whatsapp-inbox-media           JPEG, PNG, WebP; MP4, 3GPP; AAC, AMR, MPEG, MP4 and OGG audio; plain
--                                  text; PDF, Word, Excel and PowerPoint (old and new); generic binary
--   notification-held-attachments  JPEG, PNG, WebP, GIF; plain text, CSV; PDF, Word, Excel and
--                                  PowerPoint (old and new); generic binary
--
--   Sizes stay 100 MB and 40 MB. No stored file is read, moved or removed.
--
-- WHY:
--   The owner asked for these two to be narrowed like the rest (19 Nov 2026). A family wildcard
--   such as `application/*` still lets through types no one sends.
--
--   Narrowing them safely needs the code change that ships in the same pull request:
--   src/lib/uploads/stored-content-type.ts. A file whose type is not on its bucket's list is now
--   stored as `application/octet-stream` (allowed here, and served as a download, never rendered)
--   instead of failing the upload. The WhatsApp inbox keeps the real type on the message row and the
--   held email keeps it on the held attachment, and both read the file back under that type, so
--   nothing a sender or an email carries is lost. tests/stored-content-type.test.ts fails if the
--   code's lists and these arrays ever differ.
--
--   Every type that has reached production is on the lists: the WhatsApp inbox has received 696
--   PDF, 83 MP4, 50 Word, 49 JPEG, 6 old Word, 4 OGG voice notes, 3 PowerPoint, 2 WebP stickers and
--   1 PNG; storage compares only the type itself, so `audio/ogg; codecs=opus` matches `audio/ogg`
--   (proven on staging, where `application/json; charset=utf-8` also matched `application/json`).
--
--   Order: the lists are a superset of everything ever received, so applying them before the code
--   deploys loses nothing that has ever been sent. Between the two, an unlisted type would fail
--   once and succeed on the next open (Meta keeps a file 30 days).
--
-- ROLLBACK (restores 20261119013709's lists):
--   update storage.buckets set allowed_mime_types = array['image/*','video/*','audio/*','application/*',
--     'text/plain','text/csv','text/vcard','text/x-vcard'] where id = 'whatsapp-inbox-media';
--   update storage.buckets set allowed_mime_types = array['image/*','application/*','text/plain',
--     'text/csv','text/calendar','message/rfc822'] where id = 'notification-held-attachments';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: two configuration rows change, no file is touched, and it is safe to replay.

begin;

update storage.buckets
   set allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp',
         'video/mp4', 'video/3gpp',
         'audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg',
         'text/plain',
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-powerpoint',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/octet-stream'
       ]
 where id = 'whatsapp-inbox-media';

update storage.buckets
   set allowed_mime_types = array[
         'image/jpeg', 'image/png', 'image/webp', 'image/gif',
         'text/plain', 'text/csv',
         'application/pdf',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.ms-excel',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.ms-powerpoint',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/octet-stream'
       ]
 where id = 'notification-held-attachments';

-- Fail loudly if the result is not what this migration claims: no wildcard left, generic binary kept.
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
    from storage.buckets b
   where b.id in ('whatsapp-inbox-media', 'notification-held-attachments')
     and (b.allowed_mime_types is null
          or exists (select 1 from unnest(b.allowed_mime_types) t where t like '%*%')
          or not ('application/octet-stream' = any (b.allowed_mime_types)));
  if v_bad > 0 or (select count(*) from storage.buckets
                    where id in ('whatsapp-inbox-media', 'notification-held-attachments')) <> 2 then
    raise exception 'the WhatsApp and held-email buckets do not carry exact type lists with generic binary';
  end if;
end
$$;

commit;
