alter table public.marketing_request_finance_requirements
  add column if not exists money_transfer_proof_storage_path text null,
  add column if not exists money_transfer_proof_original_file_name text null,
  add column if not exists money_transfer_proof_uploaded_by_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  add column if not exists money_transfer_proof_uploaded_at timestamptz null,
  add column if not exists invoice_original_file_name text null,
  add column if not exists invoice_uploaded_by_hr_id text null references public.employees(hr_id) on update cascade on delete set null,
  add column if not exists invoice_uploaded_at timestamptz null;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'marketing-finance-evidence',
      'marketing-finance-evidence',
      false,
      5242880,
      array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists marketing_finance_evidence_service_role on storage.objects';
    execute $policy$
      create policy marketing_finance_evidence_service_role
      on storage.objects
      for all
      to service_role
      using (bucket_id = 'marketing-finance-evidence')
      with check (bucket_id = 'marketing-finance-evidence')
    $policy$;
  end if;
end $$;
