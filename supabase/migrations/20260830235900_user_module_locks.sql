-- Temporary per-account module locks — the system administrator suspends ONE module for ONE
-- account, without touching that person's role or the role permission matrix.
--
-- Owner's instruction, 2026-08-30: "choose an account and then choose a module he have access on it
-- normally … temporary lock it, so when he opens he finds a lock on its tab in the sidebar, and if
-- pressed or tried to access a page it says locked temporarily by system admin."
--
-- WHY THIS IS NOT A ROLE PERMISSION OVERRIDE. `role_permission_overrides` is keyed by ROLE, so
-- revoking `payroll:read` there removes it from every Finance Manager in the company. This is the
-- opposite shape: one person, one module, and reversible in one click. It is also deliberately a
-- SUSPENSION rather than a revocation — the underlying grant is untouched, so releasing the lock
-- restores exactly what the person had before, with no risk of a role edit being half-undone.
--
-- WHY THE ROW IS RELEASED AND NEVER DELETED. This takes a working module away from someone on a
-- live payroll system. `released_at` keeps the whole history — who locked what, when, who released
-- it — so "why could I not open Payroll on Tuesday" has an answer. A delete would leave the
-- question unanswerable, and the person asking it is the person who was locked out.
--
-- ACTIVE means released_at is null AND (unlock_at is null OR unlock_at > now()). `unlock_at` is the
-- OPTIONAL auto-release: a lock with no unlock_at stands until an administrator releases it, which
-- is the plain "until I say so" case. Expiry is evaluated in the read query rather than by a job,
-- so there is no cron to fail and nothing that can leave a person locked out past their own
-- unlock time.
--
-- FAIL-OPEN BY CONSTRUCTION, on purpose. The application treats an unreadable or missing lock table
-- as "no locks" (see src/lib/auth/module-locks.ts). A lock is a restriction on normal access, so a
-- broken lock table must degrade to everyone keeping their access — never to everyone losing it.
-- That is also what makes this migration safe to apply before or after the code deploy.
--
-- REVERSIBLE BY CONSTRUCTION. `drop table public.user_module_locks` and nothing else is touched.
-- No existing table, column or row is altered.

begin;

create table if not exists public.user_module_locks (
  id uuid primary key default gen_random_uuid(),

  -- The ACCOUNT, as app_auth_users.login_id spells it. No foreign key, matching the other
  -- login_id-keyed tables here: app_auth_users rows are edited and re-created by the access-control
  -- screen, and a cascade from that would silently erase a lock history nobody asked to erase.
  login_id text not null,

  -- The same person's HR_ID, stored CANONICAL (lower case, per canonicalHrIdKey in src/lib/hr-id.ts)
  -- and used only as a second way to recognise the viewer. Some sessions carry an HR_ID and no
  -- login_id — the dev-preview path is one — and a lock that silently does not apply to such a
  -- session would read as "the lock does not work" rather than as a missing column. Nullable: an
  -- account with no employee record is still lockable.
  hr_id text,

  -- The module, spelled exactly as a PermissionResource in src/lib/auth/permissions.ts ('payroll',
  -- 'crm_visits', …). Text rather than an enum: the resource list changes with the product, and an
  -- enum turns adding a module into a migration. Unknown values are ignored by the reader, so a
  -- resource retired later cannot resurrect as a lock on nothing.
  module_key text not null,

  -- Shown to the locked-out person UNDER the standard headline, when set. Optional: the headline
  -- alone is the owner's wording and stands on its own.
  note text,

  locked_at timestamptz not null default now(),
  locked_by_login_id text,
  locked_by_hr_id text,
  locked_by_name text,

  -- Optional auto-release. Null = the lock stands until released by hand.
  unlock_at timestamptz,

  released_at timestamptz,
  released_by_login_id text,
  released_by_hr_id text,
  released_by_name text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live lock per (account, module). Re-locking a module that is already locked updates the
-- standing row (its note and unlock_at) instead of stacking a second one — two live locks on one
-- module would make "release it" ambiguous, and the second release would look like a no-op.
-- PARTIAL on released_at so the history keeps every past lock on the same pair.
create unique index if not exists user_module_locks_active_unique
  on public.user_module_locks (login_id, module_key)
  where released_at is null;

-- The hot read is "every live lock", loaded once and cached for a few seconds by the app. The
-- per-account index serves the admin screen's per-person view.
create index if not exists user_module_locks_login_idx
  on public.user_module_locks (login_id, locked_at desc);

create index if not exists user_module_locks_active_idx
  on public.user_module_locks (module_key)
  where released_at is null;

comment on table public.user_module_locks is
  'Temporary per-account module suspensions. One row per (account, module) lock; released rather than deleted so the history survives. ACTIVE = released_at is null and (unlock_at is null or unlock_at > now()). Read through src/lib/auth/module-locks.ts, which fails OPEN if this table is unreadable.';
comment on column public.user_module_locks.module_key is
  'A PermissionResource from src/lib/auth/permissions.ts. Text, not an enum: the resource list is product data and must not need a migration to grow.';
comment on column public.user_module_locks.hr_id is
  'Canonical (lower-case) HR_ID of the locked account, per canonicalHrIdKey. Second recognition path for sessions that carry an HR_ID but no login_id.';
comment on column public.user_module_locks.unlock_at is
  'Optional auto-release instant. Evaluated in the read query, so no job can fail and leave someone locked out past this time. Null = stands until released by hand.';

alter table public.user_module_locks enable row level security;

drop policy if exists phx_user_module_locks_service_role on public.user_module_locks;
create policy phx_user_module_locks_service_role
  on public.user_module_locks
  to service_role using (true) with check (true);

grant all on table public.user_module_locks to service_role;

-- Deliberately NO grant to anon or authenticated. Every read goes through the service-role client
-- behind a route that has already proved the caller is the system administrator, and a row here
-- names a person and a module that was taken away from them.

commit;
