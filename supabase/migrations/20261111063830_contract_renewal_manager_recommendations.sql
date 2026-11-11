-- contract_renewal_manager_recommendations
--
-- WHAT THIS CHANGES: adds public.contract_renewal_manager_recommendations — one row per employee,
--   renewal date and recommending manager: "renew" or "do not renew", with an optional note.
-- WHY: the contract renewal reminder (75/60/30/15 days before the renewal date) asks the
--   employee's manager chain for a "manager recommendation", but there was nowhere to give one —
--   the email's button opened Contract Renewal, which only HR and the Super Admin can open, so every
--   manager was sent to the portal home (owner, 2026-11-11: "people are redirected to nothing").
--   The manager now answers on /contracts/recommend/<hrId>, and HR reads the answer on the
--   Contract Renewal board. A reminder goes out before any renewal request exists, so the answer
--   is keyed by the renewal date, not by a contract_renewal_requests row.
-- ROLLBACK: drop table public.contract_renewal_manager_recommendations; (new table, nothing else
--   reads it; losing it loses only the recommendations recorded since this was applied).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.contract_renewal_manager_recommendations (
  id uuid primary key default gen_random_uuid(),
  employee_hr_id text not null,
  renewal_date date not null,
  recommender_hr_id text not null,
  recommendation text not null check (recommendation in ('renew', 'do_not_renew')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_renewal_manager_recommendations_one_per_manager
    unique (employee_hr_id, renewal_date, recommender_hr_id)
);

create index if not exists contract_renewal_manager_recommendations_employee_idx
  on public.contract_renewal_manager_recommendations (employee_hr_id, renewal_date);

-- Read and written only by the server with the service-role client, after the application has
-- decided the viewer is in the employee's manager chain (src/lib/contracts/manager-recommendation.ts).
alter table public.contract_renewal_manager_recommendations enable row level security;
revoke all on table public.contract_renewal_manager_recommendations from anon, authenticated;
grant select, insert, update on table public.contract_renewal_manager_recommendations to service_role;

commit;
