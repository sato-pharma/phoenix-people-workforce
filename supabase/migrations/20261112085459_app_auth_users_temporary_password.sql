-- app_auth_users_temporary_password
--
-- WHAT THIS CHANGES: adds one nullable column, public.app_auth_users.temporary_password_expires_at.
--   No row is written; every existing row reads NULL, which means "no temporary password".
-- WHY: the owner's new account email (12 Nov 2026) carries the username, a temporary password and the
--   sign-in link instead of a set-your-password link. While this column is in the future AND
--   force_password_reset is true, the person's stored password is that temporary one: signing in with
--   it opens the choose-your-own-password screen, never a session. Any other force_password_reset
--   (an admin reset link, a brand-new account) keeps refusing the sign-in exactly as before — which is
--   why this needs its own marker instead of reading force_password_reset alone.
-- ROLLBACK: alter table public.app_auth_users drop column if exists temporary_password_expires_at;
--   (only after the code that reads it is gone — PostgREST fails the whole login read on a missing column.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.app_auth_users
  add column if not exists temporary_password_expires_at timestamptz;

comment on column public.app_auth_users.temporary_password_expires_at is
  'Set when an admin emails a temporary password (src/lib/auth/password-setup.ts). While in the future and force_password_reset is true, signing in with that password opens /password-setup to choose a new one; cleared when the person sets their own password or a setup link replaces it.';

commit;
