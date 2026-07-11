-- Recruitment Offer Pipeline (M1) — job_offers columns + status widen.
alter table public.job_offers
  add column if not exists probation_period_months integer not null default 3,
  add column if not exists benefits jsonb not null default '[]'::jsonb,
  add column if not exists approved_at timestamptz,
  add column if not exists generated_at timestamptz,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_by_hr_id text,
  add column if not exists sent_version integer,
  add column if not exists expiry_date date;

alter table public.job_offers
  drop constraint if exists job_offers_status_check;
alter table public.job_offers
  add constraint job_offers_status_check
  check (status in (
    'draft', 'pending_approval', 'approved', 'approval_rejected', 'generated',
    'sent', 'negotiation_in_progress', 'accepted', 'rejected', 'expired',
    'hired', 'withdrawn', 'cancelled', 'voided'
  ));

notify pgrst, 'reload schema';;
