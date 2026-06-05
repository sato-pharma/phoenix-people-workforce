-- Recruitment Offer Pipeline (M2) — offer approval-chain steps.
create table if not exists public.offer_approval_steps (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.job_offers(id) on update cascade on delete cascade,
  application_id uuid null,
  version integer not null default 1,
  sequence integer not null,
  approver_kind text not null default 'role' check (approver_kind in ('role', 'person')),
  approver_role text null,
  approver_hr_id text null,
  required boolean not null default true,
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
  decided_by text null,
  decided_at timestamptz null,
  reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offer_approval_steps_unique unique (offer_id, version, sequence)
);

create index if not exists offer_approval_steps_offer_idx
  on public.offer_approval_steps (offer_id, version, sequence);

alter table public.offer_approval_steps enable row level security;
revoke all on public.offer_approval_steps from anon, authenticated;
grant all on public.offer_approval_steps to service_role;

drop policy if exists phx_offer_approval_steps_service_role on public.offer_approval_steps;
create policy phx_offer_approval_steps_service_role
  on public.offer_approval_steps for all to service_role using (true) with check (true);

notify pgrst, 'reload schema';;
