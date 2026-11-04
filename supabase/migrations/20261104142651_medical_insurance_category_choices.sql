-- Medical insurance: the category decided for someone who is not on the policy yet (owner, 2026-11-04:
-- "make me decide in the system").
--
-- A joiner has no member row until the insurer confirms them, so the register has nowhere to hold the
-- category that goes on the additions form. Five Head Office joiners had no category to suggest, and the
-- export's picker forgot a choice as soon as the file was built. This table keeps the decision, who made
-- it and when; the additions form and the add-member form both read it. Once the person is on the
-- register, the member's own category is the truth and this row is only history.
--
-- ACCESS. Same as the rest of the module: RLS on, no policy, nothing granted but to the service role.

create table if not exists public.medical_insurance_category_choices (
  policy_id uuid not null references public.medical_insurance_policies (id) on delete restrict,
  hr_id text not null,
  category text not null check (category in ('A', 'B', 'C')),
  decided_by_hr_id text,
  decided_at timestamptz not null default now(),
  primary key (policy_id, hr_id)
);

comment on table public.medical_insurance_category_choices is
  'The category decided for an employee who is not on the policy yet, read by the additions form. One row per person per policy; a new decision replaces it.';

alter table public.medical_insurance_category_choices enable row level security;
revoke all on public.medical_insurance_category_choices from public, anon, authenticated;
grant all on public.medical_insurance_category_choices to service_role;
