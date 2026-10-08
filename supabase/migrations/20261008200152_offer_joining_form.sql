-- offer_joining_form
--
-- WHAT THIS CHANGES: additive only — no row is rewritten.
--   * employees.personal_email — the candidate's private address, typed on the joining form.
--   * offers.accepted_at / accepted_via / employee_hr_id / joining_claimed_at — when and how the
--     offer was accepted, the employee record the joining form created, and the short claim that
--     stops a double Submit from creating two employees.
--   * offer_acceptances — the audit trail of every joining-form submit (what he typed, when, and a
--     hashed address — never the raw IP). Service-role only: RLS on, no anon/authenticated grant.
-- WHY: owner, 2026-10-08 — the offer email carries an Accept button that opens a Sato-branded
--   joining form; Submit IS the acceptance and creates the employee record from the offer and its
--   AU seat, so HR no longer retypes the hire.
-- ROLLBACK:
--   drop table if exists public.offer_acceptances;
--   alter table public.offers drop column if exists joining_claimed_at, drop column if exists employee_hr_id,
--     drop column if exists accepted_via, drop column if exists accepted_at;
--   alter table public.employees drop column if exists personal_email;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.employees add column if not exists personal_email text;

alter table public.offers
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_via text,
  add column if not exists employee_hr_id text,
  add column if not exists joining_claimed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'offers_accepted_via_check') then
    alter table public.offers
      add constraint offers_accepted_via_check check (accepted_via is null or accepted_via in ('candidate_form', 'hr'));
  end if;
end $$;

-- One offer produces at most one employee record.
create unique index if not exists offers_employee_hr_id_key on public.offers (employee_hr_id) where employee_hr_id is not null;

create table if not exists public.offer_acceptances (
  id uuid primary key default gen_random_uuid(),
  -- The audit outlives the offer: deleting an offer clears the link, never the record of what he typed.
  offer_id uuid references public.offers (id) on delete set null,
  employee_hr_id text,
  submitted_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  ip_hash text
);

create index if not exists offer_acceptances_offer_id_idx on public.offer_acceptances (offer_id);

alter table public.offer_acceptances enable row level security;
revoke all on table public.offer_acceptances from anon, authenticated;
grant select, insert on table public.offer_acceptances to service_role;

comment on table public.offer_acceptances is 'Every offer joining-form submit (owner, 2026-10-08): the answers as typed, the employee record created, and a sha256 of the address. Service-role only.';
comment on column public.offers.employee_hr_id is 'The employee record the candidate''s joining form created. Set only by the joining form; never a link to a candidate.';
comment on column public.employees.personal_email is 'The private email the new hire typed on the offer joining form. Never a company address.';

commit;

-- Timestamp 20261008200152 was minted to sort after every migration already on main.
