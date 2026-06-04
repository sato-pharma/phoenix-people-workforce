-- Recruitment / ATS — Phase 3 pre-boarding & joining checklist.
--
-- One table holds both the pre-boarding DOCUMENT checklist (stages 17-18) and the
-- JOINING task checklist (stages 19-20) per application. Standard items are seeded
-- by the service when an application enters pre_boarding. Documents gate the hire.
-- Service-role-only RLS, no browser-role grant (PII-adjacent).

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

notify pgrst, 'reload schema';
