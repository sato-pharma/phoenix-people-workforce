-- A held email keeps its attachments, so approving it sends the file.
--
-- Owner 2026-10-24: "fix the held-email approval so it keeps the attachments".
--
-- The Notification Confidence Gate stored a held email's subject, body and recipients, and nothing
-- else. Approving it re-sent exactly that, so an email held with a PDF on it went out with no PDF,
-- and nothing on screen said so. The files are not stored in the review row: a held email can carry
-- up to 38MB of attachments (the send-time budget), so a held email's files go to a private bucket,
-- read only by the service role, and the row keeps the list of what was attached and where it is.
--
-- Only a HELD email with files writes here, which is rare by design (the gate holds a send only when
-- it reaches an unusually large audience, or its content or recipients are broken). An email that is
-- sent at once writes nothing new.
begin;

alter table public.notification_send_reviews
  add column if not exists held_attachments jsonb;

comment on column public.notification_send_reviews.held_attachments is
  'Set only on a held send that carried files: one entry per file (filename, contentType, contentId, remoteUrl, byteSize, storagePath in the notification-held-attachments bucket). storagePath null = the file could not be kept, and approval refuses rather than send without it.';

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'notification-held-attachments',
      'notification-held-attachments',
      false,
      -- 40MB per object: above the 38MB whole-message budget in send-phoenix-email.ts, so any file
      -- the send would have carried can be kept. No type list — the bucket holds whatever the held
      -- email carried, and nothing ever serves from it.
      41943040,
      null
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists notification_held_attachments_service_role on storage.objects';
    execute $policy$
      create policy notification_held_attachments_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'notification-held-attachments')
      with check (bucket_id = 'notification-held-attachments')
    $policy$;
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
