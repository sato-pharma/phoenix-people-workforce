-- ============================================================================
-- Re-sync GoTrue (Supabase Auth) password hashes with Phoenix's own hashes.
--
-- Why: privileged-role login (Super Admin, CEO, Finance Manager, SFE Manager,
-- National Sales Manager) is forced through a Supabase Auth "bridge" that calls
-- GoTrue signInWithPassword. That fast path has been failing for every login
-- because auth.users.encrypted_password was frozen at the 2026-05-09 bulk
-- provision while the matching Phoenix password (app_auth_users.password_hash)
-- was changed later. Every failed sign-in then falls into a repair path that
-- pages through up to 10k auth users (~10 seconds) — the "28-second login".
--
-- Both stores use identical, portable bcrypt ($2b$12$, 60 chars) and Phoenix
-- verifies with a plain bcrypt.compare (no pepper). So copying the CURRENT
-- Phoenix hash into GoTrue makes GoTrue verify the exact same password the user
-- already uses. NO password is changed/reset; no user does anything; nobody is
-- locked out. This only overwrites a stale one-way hash with the current one.
--
-- Proven end-to-end on staging (2026-07-05): a user whose GoTrue hash was stale
-- returned 400 on signInWithPassword; after copying the Phoenix hash in, the same
-- password signed in successfully with a session issued.
--
-- Idempotent: only touches rows where the hashes actually differ; a second run
-- updates 0 rows. The backup table is created once and preserved.
-- ============================================================================

-- SAFE: one-time reversible re-sync of stale auth password hashes; backup taken below.
create schema if not exists cleanup_backup;

-- Reversible backup of the exact column we touch (first run only).
create table if not exists cleanup_backup.auth_users_pw_backup_20260705 as
  select id, encrypted_password, updated_at, now() as backed_up_at
  from auth.users;

-- Copy the current Phoenix bcrypt hash into GoTrue for every linked user whose
-- GoTrue hash is stale. Scoped tightly: linked only, well-formed bcrypt only,
-- mismatched only.
update auth.users u
set encrypted_password = a.password_hash,
    updated_at = now()
from public.app_auth_users a
where u.id = a.auth_user_id
  and a.password_hash is not null
  and a.password_hash like '$2%'
  and u.encrypted_password is distinct from a.password_hash;

-- Rollback (manual, if ever needed):
--   update auth.users u
--   set encrypted_password = b.encrypted_password
--   from cleanup_backup.auth_users_pw_backup_20260705 b
--   where u.id = b.id;
