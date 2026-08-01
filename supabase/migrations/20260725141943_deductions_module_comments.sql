-- Unified Deductions module — Phase 4: employee/HR comment thread on a
-- published candidate, mirroring the legacy deduction_comments table 1:1 so
-- the existing employee-portal comment thread (app/employee-portals/deductions,
-- the admin-shell embedded Deductions tab, and DeductionsPortalWorkspace) keeps
-- working unchanged once its data source is re-pointed at this module for
-- months the new module has published. Legacy deduction_comments continues to
-- serve comments for pre-cutover months untouched.
--
-- Like the legacy table, RLS is service-role-only: the visibility/authorship
-- rule ("an employee may comment only on their own published deduction, only
-- after it has actually been published") is complex enough that the legacy
-- table already keeps it in application code (getSupabaseAdmin() + an explicit
-- assert) rather than an RLS predicate, and this module follows that same,
-- already-proven pattern rather than reinventing it.

create table if not exists public.deductions_comments (
  id               uuid primary key default gen_random_uuid(),
  candidate_id     uuid not null references public.deductions_candidates(id) on delete cascade,
  author_login_id  text not null default 'system',
  author_hr_id     text,
  author_role      text,
  body             text not null,
  created_at       timestamptz not null default now(),
  constraint deductions_comments_author_not_blank check (btrim(author_login_id) <> ''),
  constraint deductions_comments_body_not_blank check (btrim(body) <> '')
);

comment on table public.deductions_comments is
  'Unified Deductions module: employee/HR comment thread on a published deduction candidate. Mirrors legacy deduction_comments 1:1 (candidate_id -> deductions_candidates). Access mediated entirely in application code via the service-role client, same as the legacy table.';

create index if not exists deductions_comments_candidate_created_idx
  on public.deductions_comments (candidate_id, created_at desc);

alter table public.deductions_comments enable row level security;

drop policy if exists deductions_comments_service_role_all on public.deductions_comments;
create policy deductions_comments_service_role_all
  on public.deductions_comments for all to service_role
  using (true) with check (true);

revoke all on table public.deductions_comments from anon;
revoke all on table public.deductions_comments from authenticated;
revoke all on table public.deductions_comments from public;
grant all on table public.deductions_comments to service_role;
