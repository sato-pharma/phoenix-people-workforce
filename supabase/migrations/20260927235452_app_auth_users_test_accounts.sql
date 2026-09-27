-- app_auth_users_test_accounts
--
-- WHAT THIS CHANGES: two columns and two check constraints on public.app_auth_users.
--   is_test_persona        boolean, default false — the row is a TEST ACCOUNT.
--   test_persona_of_hr_id  the real employee a test account mirrors (FK employees.hr_id).
--   A test account never carries an hr_id of its own and its login id starts with TEST-; a mirror is
--   set on a test account only. Every existing row becomes is_test_persona = false and is otherwise
--   untouched.
-- WHY: owner, 2026-09-27 — a production login the Super Admin creates, with its own password, that
--   lives inside a real employee's employee portal (her data, her screens) while nothing it does is
--   saved as her: Phoenix CRM files its saves as test entries and every other save is refused
--   (src/lib/auth/test-persona.ts). The session resolver (src/lib/auth/server.ts) reads these two
--   columns on every request, so THIS MUST BE APPLIED BEFORE THE CODE DEPLOYS.
-- ROLLBACK (only after the code that reads the columns is reverted, or every session breaks):
--   alter table public.app_auth_users drop constraint if exists app_auth_users_test_persona_shape;
--   alter table public.app_auth_users drop constraint if exists app_auth_users_test_persona_mirror_only;
--   alter table public.app_auth_users drop column if exists test_persona_of_hr_id;
--   alter table public.app_auth_users drop column if exists is_test_persona;
--   (dropping the columns loses which rows were test accounts; deactivate those logins first.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This change is additive: no row is rewritten beyond taking the new column's default.

begin;

alter table public.app_auth_users
  add column if not exists is_test_persona boolean not null default false,
  add column if not exists test_persona_of_hr_id text references public.employees(hr_id) on update cascade on delete set null;

comment on column public.app_auth_users.is_test_persona is
  'A test account (src/lib/auth/test-persona.ts): signs in with its own password, reads as the employee in test_persona_of_hr_id, and never saves as her.';
comment on column public.app_auth_users.test_persona_of_hr_id is
  'The real employee a test account mirrors. Null on every real account. A test account whose mirror is gone is refused at sign-in.';

-- A test account has no HR id of its own — so no lookup of a real person's account by HR id can ever
-- land on it — and its login id starts with TEST-, so it can never be mistaken for a real login.
alter table public.app_auth_users drop constraint if exists app_auth_users_test_persona_shape;
alter table public.app_auth_users
  add constraint app_auth_users_test_persona_shape
  check (not is_test_persona or (hr_id is null and upper(login_id) like 'TEST-%'));

-- Only a test account mirrors anybody.
alter table public.app_auth_users drop constraint if exists app_auth_users_test_persona_mirror_only;
alter table public.app_auth_users
  add constraint app_auth_users_test_persona_mirror_only
  check (test_persona_of_hr_id is null or is_test_persona);

commit;
