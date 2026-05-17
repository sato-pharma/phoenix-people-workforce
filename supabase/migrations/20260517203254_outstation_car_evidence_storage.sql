alter table public.outstation_expense_requests
  add column if not exists car_evidence_image_path text,
  add column if not exists car_evidence_metadata jsonb;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'outstation-evidence',
      'outstation-evidence',
      false,
      2097152,
      array['image/jpeg']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists outstation_evidence_service_role on storage.objects';
    execute $policy$
      create policy outstation_evidence_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'outstation-evidence')
      with check (bucket_id = 'outstation-evidence')
    $policy$;
  end if;
end $$;
