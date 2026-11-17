-- chatgpt_connector_oauth — the four tables behind the ChatGPT connector's sign-in and its files.
--
-- WHAT THIS CHANGES: adds four new, empty tables. Nothing existing changes and no row is written.
--   1. public.connector_oauth_clients — the ChatGPT connectors that registered themselves (RFC 7591).
--      Registration is accepted only for ChatGPT's own return addresses, and a registration alone
--      opens nothing: a Phoenix sign-in by the owner or the CEO is still needed.
--   2. public.connector_oauth_codes — the two-minute codes handed to ChatGPT after the person approved
--      it on Phoenix's own page. Stored as SHA-256 fingerprints with the PKCE challenge; good once.
--   3. public.connector_oauth_tokens — the access tokens (one hour) and refresh tokens (30 days) ChatGPT
--      holds, as SHA-256 fingerprints, never the tokens. A refresh token is good once; presenting a
--      spent one revokes its whole family. session_version pins the account's version at approval,
--      so a password change or "sign out everywhere" ends ChatGPT's access too.
--   4. public.connector_files — the Excel and PDF files Phoenix built for the person in ChatGPT, kept
--      in the job-exports storage bucket; downloadable only by the same signed-in person, for 7 days.
-- WHY: the owner asked for ChatGPT to answer questions about any module from the live data and to
--   build sheets and PDFs (17 Nov 2026). His choices: the live app, everything his role can see, the
--   owner and the CEO only, files built by Phoenix. Account: docs/phoenix-intelligence/CHATGPT_DATA_CONNECTOR.md.
-- ACCESS: read and written only by the server (service role). RLS is enabled with NO policy on all
--   four, and public, anon and authenticated hold no privilege, so the browser key can neither read
--   nor write them.
-- KILL SWITCH: `update public.connector_oauth_tokens set revoked_at = now(), revoked_reason = 'owner'
--   where revoked_at is null;` ends every ChatGPT connection at once.
-- ROLLBACK: drop table if exists public.connector_files;
--           drop table if exists public.connector_oauth_tokens;
--           drop table if exists public.connector_oauth_codes;
--           drop table if exists public.connector_oauth_clients;
--   (ship the code revert FIRST: /api/mcp reads connector_oauth_tokens and refuses every call when the
--   table is missing, which is safe, but noisy.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is neither destructive nor bulk: four new, empty tables.

begin;

create table if not exists public.connector_oauth_clients (
  client_id      text primary key,
  client_name    text,
  -- Only ChatGPT's return addresses are accepted (checked in src/lib/chatgpt-connector/oauth.ts).
  redirect_uris  text[] not null,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

alter table public.connector_oauth_clients enable row level security;
revoke all on table public.connector_oauth_clients from public;
revoke all on table public.connector_oauth_clients from anon;
revoke all on table public.connector_oauth_clients from authenticated;
grant select, insert, update, delete on table public.connector_oauth_clients to service_role;

comment on table public.connector_oauth_clients is
  'ChatGPT connectors registered for the Phoenix data connector (RFC 7591). ChatGPT return addresses only; a registration opens nothing without a Phoenix sign-in by the owner or the CEO. Server only: RLS on, no policy.';

create table if not exists public.connector_oauth_codes (
  code_hash        text primary key,
  client_id        text not null references public.connector_oauth_clients(client_id) on delete cascade,
  login_id         text not null references public.app_auth_users(login_id) on update cascade on delete cascade,
  hr_id            text,
  role             text not null,
  session_version  integer not null,
  redirect_uri     text not null,
  -- PKCE S256 challenge (base64url SHA-256 of the verifier ChatGPT keeps).
  code_challenge   text not null,
  resource         text not null,
  scope            text not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);

alter table public.connector_oauth_codes enable row level security;
revoke all on table public.connector_oauth_codes from public;
revoke all on table public.connector_oauth_codes from anon;
revoke all on table public.connector_oauth_codes from authenticated;
grant select, insert, update, delete on table public.connector_oauth_codes to service_role;

comment on table public.connector_oauth_codes is
  'Two-minute authorization codes for the ChatGPT connector, as SHA-256 fingerprints, with the PKCE S256 challenge. Good once (used_at). Server only: RLS on, no policy.';

create table if not exists public.connector_oauth_tokens (
  token_hash       text primary key,
  kind             text not null check (kind in ('access', 'refresh')),
  -- Every token minted from one approval shares a family; a replayed refresh token revokes it all.
  family_id        uuid not null,
  client_id        text not null references public.connector_oauth_clients(client_id) on delete cascade,
  login_id         text not null references public.app_auth_users(login_id) on update cascade on delete cascade,
  hr_id            text,
  role             text not null,
  session_version  integer not null,
  resource         text not null,
  scope            text not null,
  expires_at       timestamptz not null,
  -- A refresh token is spent when it is exchanged; presenting it again revokes the family.
  used_at          timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text,
  last_used_at     timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists connector_oauth_tokens_family_idx on public.connector_oauth_tokens (family_id);
-- Every foreign key in public has an index leading with its columns (F-DB-006).
create index if not exists connector_oauth_tokens_login_id_fk_idx on public.connector_oauth_tokens (login_id);
create index if not exists connector_oauth_tokens_client_id_fk_idx on public.connector_oauth_tokens (client_id);
create index if not exists connector_oauth_codes_login_id_fk_idx on public.connector_oauth_codes (login_id);
create index if not exists connector_oauth_codes_client_id_fk_idx on public.connector_oauth_codes (client_id);

alter table public.connector_oauth_tokens enable row level security;
revoke all on table public.connector_oauth_tokens from public;
revoke all on table public.connector_oauth_tokens from anon;
revoke all on table public.connector_oauth_tokens from authenticated;
grant select, insert, update, delete on table public.connector_oauth_tokens to service_role;

comment on table public.connector_oauth_tokens is
  'ChatGPT connector access (1 h) and refresh (30 d) tokens as SHA-256 fingerprints, never the tokens. session_version pins the account at approval. Revoke every row to end every ChatGPT connection. Server only: RLS on, no policy.';

create table if not exists public.connector_files (
  id            uuid primary key default gen_random_uuid(),
  login_id      text not null references public.app_auth_users(login_id) on update cascade on delete cascade,
  hr_id         text,
  kind          text not null check (kind in ('xlsx', 'pdf')),
  title         text not null,
  file_name     text not null,
  storage_path  text not null,
  size_bytes    integer not null,
  expires_at    timestamptz not null,
  downloaded_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists connector_files_login_idx on public.connector_files (login_id, created_at desc);

alter table public.connector_files enable row level security;
revoke all on table public.connector_files from public;
revoke all on table public.connector_files from anon;
revoke all on table public.connector_files from authenticated;
grant select, insert, update, delete on table public.connector_files to service_role;

comment on table public.connector_files is
  'Excel and PDF files Phoenix built for a person through the ChatGPT connector, stored in the job-exports bucket. Downloadable only by the same signed-in person until expires_at. Server only: RLS on, no policy.';

commit;
