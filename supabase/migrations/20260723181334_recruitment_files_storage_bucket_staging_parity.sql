-- Staging was missing the recruitment-files storage bucket entirely (pre-existing gap,
-- discovered while browser-verifying the CV-extraction feature — production has this
-- bucket, staging does not). Recreating exactly per the original migration
-- (pre-baseline-2026-07-11/20260605014515_..._approval_files.sql) for parity.
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

notify pgrst, 'reload schema';
