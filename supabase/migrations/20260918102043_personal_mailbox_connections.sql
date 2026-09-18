-- personal_mailbox_connections
--
-- WHAT THIS CHANGES: adds one new table, public.personal_mailbox_connections, and one function,
--   public.phx_purge_departed_personal_mailboxes(). Nothing existing is altered; no row anywhere
--   is written by this migration.
-- WHY: the envelope in the top bar gains "My email" — each employee connects their OWN Turbify
--   mailbox once (an app password they create themselves) and then reads and sends their company
--   mail inside Phoenix. The owner's rule (2026-09-18) is that the connection is PRIVATE to that
--   person: no screen lets anyone else open it, the compliance monitor included. So this is a
--   separate table from public.mailbox_monitors, the app password is sealed under its own
--   secret-box context (src/lib/security/secret-box.ts), and browser roles get no grant at all.
--   The purge function removes a connection once its owner no longer holds an active login, so a
--   leaver's stored key does not outlive their account; the daily mailbox-offboarding sweep calls
--   it right after the departed-access sweep has switched leavers' logins off.
-- ROLLBACK: drop function if exists public.phx_purge_departed_personal_mailboxes();
--           drop table if exists public.personal_mailbox_connections;
--   Dropping the table deletes every stored connection; each person would simply connect again.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create table if not exists public.personal_mailbox_connections (
  id uuid primary key default gen_random_uuid(),
  -- Whose connection this is: the session's HR id (upper case), or its login id for the one kind
  -- of account that has no HR id. Always taken from the resolved session, never from a request.
  owner_key text not null unique check (char_length(owner_key) between 1 and 200),
  owner_hr_id text,
  owner_login_id text,
  -- The mailbox. Locked by the app to the owner's own company address on record.
  email_address text not null check (char_length(email_address) between 3 and 320),
  -- The owner's app password, sealed by secret-box.ts under the "personal-mailbox" context.
  -- Never plaintext, and never openable by the compliance monitor's key.
  sealed_password text not null,
  -- active: usable. needs_reconnect: the mailbox refused the stored app password, so Phoenix stops
  -- trying (Yahoo locks a mailbox after repeated failed logins) until the owner pastes a new one.
  status text not null default 'active' check (status in ('active', 'needs_reconnect')),
  last_ok_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.personal_mailbox_connections enable row level security;

-- No policies, and no browser grants: only the server (service role) ever reads this table, and
-- only on behalf of the signed-in owner. Revoked explicitly because Supabase's default privileges
-- grant anon and authenticated on every new public table.
revoke all on table public.personal_mailbox_connections from public, anon, authenticated;
grant select, insert, update, delete on table public.personal_mailbox_connections to service_role;

-- Deletes every connection whose owner no longer has an active Phoenix login. Matching is
-- case- and space-insensitive on both sides, because HR ids are mixed case in this database.
-- Idempotent: a missed day self-heals on the next run.
create or replace function public.phx_purge_departed_personal_mailboxes()
returns integer
language plpgsql
set search_path = public
as $$
declare
  removed integer;
begin
  delete from public.personal_mailbox_connections c
  where not exists (
    select 1
    from public.app_auth_users u
    where u.is_active is true
      and (
        lower(trim(coalesce(u.hr_id, ''))) = lower(trim(c.owner_key))
        or lower(trim(coalesce(u.login_id, ''))) = lower(trim(c.owner_key))
      )
  );
  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.phx_purge_departed_personal_mailboxes() from public, anon, authenticated;
grant execute on function public.phx_purge_departed_personal_mailboxes() to service_role;

notify pgrst, 'reload schema';

commit;
