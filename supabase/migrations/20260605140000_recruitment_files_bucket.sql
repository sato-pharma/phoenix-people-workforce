-- Recruitment / ATS — candidate file storage bucket (Supabase Storage).
--
-- Private bucket for CVs / offer PDFs / ID docs. All access is server-side via
-- the service-role client; the service-role storage policy + private bucket keep
-- browser roles out (mirrors the outstation-evidence + leave-attachments setup).

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'recruitment-files',
      'recruitment-files',
      false,
      10485760,
      array[
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists recruitment_files_service_role on storage.objects';
    execute $policy$
      create policy recruitment_files_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'recruitment-files')
      with check (bucket_id = 'recruitment-files')
    $policy$;
  end if;
end $$;
