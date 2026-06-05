-- Phoenix Workforce v2 vacation request policy updates.
-- Replaces personal vacation with other, adds sick document metadata, and
-- keeps the private leave attachment bucket available for required sick files.

begin;
update public.v2_vacation_requests
set vacation_type = 'other'
where vacation_type = 'personal';
alter table public.v2_vacation_requests
  add column if not exists sick_attachment_bucket text null,
  add column if not exists sick_attachment_object_path text null,
  add column if not exists sick_attachment_original_name text null,
  add column if not exists sick_attachment_content_type text null,
  add column if not exists sick_attachment_size_bytes bigint null,
  add column if not exists sick_attachment_uploaded_at timestamptz null;
alter table public.v2_vacation_requests
  drop constraint if exists v2_vacation_requests_vacation_type_check,
  add constraint v2_vacation_requests_vacation_type_check
    check (vacation_type in ('annual', 'emergency', 'sick', 'other'));
create index if not exists v2_vacation_requests_sick_attachment_idx
  on public.v2_vacation_requests (sick_attachment_object_path)
  where sick_attachment_object_path is not null;
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'leave-attachments',
      'leave-attachments',
      false,
      10485760,
      array[
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/png',
        'image/webp'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists leave_attachments_service_role on storage.objects';
    execute $policy$
      create policy leave_attachments_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'leave-attachments')
      with check (bucket_id = 'leave-attachments')
    $policy$;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
