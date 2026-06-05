-- onboarding (pre-boarding & joining checklist)
create table if not exists public.recruitment_onboarding_items (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.recruitment_applications(id) on update cascade on delete cascade,
  category text not null,
  item_key text not null,
  label text not null,
  status text not null default 'pending',
  file_id uuid null references public.recruitment_files(id) on update cascade on delete set null,
  notes text null,
  completed_by text null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_onboarding_items_category_check
    check (category in ('document', 'joining')),
  constraint recruitment_onboarding_items_status_check
    check (status in ('pending', 'submitted', 'approved', 'rejected', 'waived', 'completed')),
  constraint recruitment_onboarding_items_unique unique (application_id, item_key)
);

create index if not exists recruitment_onboarding_items_application_idx
  on public.recruitment_onboarding_items (application_id);

alter table public.recruitment_onboarding_items enable row level security;
revoke all on public.recruitment_onboarding_items from anon, authenticated;
grant all on public.recruitment_onboarding_items to service_role;

drop policy if exists phx_recruitment_onboarding_items_service_role on public.recruitment_onboarding_items;
create policy phx_recruitment_onboarding_items_service_role
  on public.recruitment_onboarding_items for all to service_role using (true) with check (true);

-- public job postings
create table if not exists public.recruitment_job_postings (
  id uuid primary key default gen_random_uuid(),
  requisition_id uuid not null references public.recruitment_requisitions(id) on update cascade on delete cascade,
  public_token text not null unique,
  title text not null default '',
  status text not null default 'open',
  created_by text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recruitment_job_postings_status_check check (status in ('open', 'closed')),
  constraint recruitment_job_postings_requisition_unique unique (requisition_id)
);

create index if not exists recruitment_job_postings_requisition_idx
  on public.recruitment_job_postings (requisition_id);

alter table public.recruitment_applications
  add column if not exists submitted_ip_hash text null;
create index if not exists recruitment_applications_submitted_ip_idx
  on public.recruitment_applications (submitted_ip_hash);

alter table public.recruitment_job_postings enable row level security;
revoke all on public.recruitment_job_postings from anon, authenticated;
grant all on public.recruitment_job_postings to service_role;

drop policy if exists phx_recruitment_job_postings_service_role on public.recruitment_job_postings;
create policy phx_recruitment_job_postings_service_role
  on public.recruitment_job_postings for all to service_role using (true) with check (true);

-- offer-letter versions
create table if not exists public.recruitment_offer_letters (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.job_offers(id) on update cascade on delete cascade,
  application_id uuid null references public.recruitment_applications(id) on update cascade on delete set null,
  version integer not null,
  snapshot jsonb not null default '{}'::jsonb,
  generated_by text null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint recruitment_offer_letters_version_unique unique (offer_id, version)
);

create index if not exists recruitment_offer_letters_offer_idx
  on public.recruitment_offer_letters (offer_id);

alter table public.recruitment_offer_letters enable row level security;
revoke all on public.recruitment_offer_letters from anon, authenticated;
grant all on public.recruitment_offer_letters to service_role;

drop policy if exists phx_recruitment_offer_letters_service_role on public.recruitment_offer_letters;
create policy phx_recruitment_offer_letters_service_role
  on public.recruitment_offer_letters for all to service_role using (true) with check (true);

-- threshold senior approval columns on applications
alter table public.recruitment_applications
  add column if not exists senior_approval_status text null,
  add column if not exists senior_approved_by text null,
  add column if not exists senior_approved_at timestamptz null;

-- private storage bucket for candidate files
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

notify pgrst, 'reload schema';;
