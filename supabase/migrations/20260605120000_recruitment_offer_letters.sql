-- Recruitment / ATS — Phase 4c offer-letter versions.
--
-- Each generated offer letter is a versioned snapshot of the offer terms at that
-- moment (V1/V2/V3...). The letter is rendered as print-ready HTML (save as PDF
-- from the browser). Service-role-only RLS; salary data, browser roles revoked.

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

notify pgrst, 'reload schema';
