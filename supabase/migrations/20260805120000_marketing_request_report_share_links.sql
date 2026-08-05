-- Live Marketing Request report feed (owner request, 2026-08-05): a Google Sheet that populates
-- itself and refreshes the moment a request changes, with clickable evidence photos and finance
-- files inside it.
--
-- Deliberately a SEPARATE table from direct_order_report_share_links rather than a shared generic
-- one. A token here unlocks a different and wider body of data — marketing spend, doctor identity,
-- GPS capture of a real clinic, evidence photographs, invoice and money-transfer files. Merging
-- the two would mean one revoke list, one expiry policy and one blast radius for two reports whose
-- audiences are not the same, and a mistake in either would silently widen the other.
--
-- Every column is a control, not bookkeeping. Same reasoning as the direct-orders table:
--   * `token`         — 32 random bytes, base64url. Never sequential, never derived from anything.
--   * `passcode_hash` — the human 'live' surface demands a code shared out-of-band, so a forwarded
--                       URL alone is useless. The 'feed' surface cannot carry one — a spreadsheet
--                       formula cannot type a passcode — which is why the two are separate rows.
--   * `expires_at`    — MANDATORY. A link with no end date becomes an unowned copy of the business.
--   * `revoked_at`    — one click kills it, and kills the file links with it.
--   * `scope`/`scope_hr_id` — frozen to the CREATOR at creation, never re-resolved on read.
--   * access columns  — every open counted and stamped.
--
-- `allow_files` exists because the file route is a real escalation over the CSV: the feed leaks
-- numbers, but a file link streams a photograph of a named doctor's clinic. A link that only needs
-- the table can be minted without ever being able to fetch an image.

create table if not exists public.marketing_request_report_share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  -- 'live' = human page, passcode required.
  -- 'feed' = CSV bundle for the Google Sheet's Apps Script; token-only by necessity, so it is meant
  --          to sit inside a private sheet and never be handed to a person.
  surface text not null default 'live' check (surface in ('live', 'feed')),
  label text,
  created_by_hr_id text not null,
  created_at timestamptz not null default now(),
  -- Frozen creator scope. 'all' | 'own' — the marketing report has no middle tier today, but the
  -- column is text rather than a two-value enum so adding one is not a migration on a live table.
  scope text not null,
  scope_hr_id text not null,
  filters jsonb,
  passcode_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_hr_id text,
  last_accessed_at timestamptz,
  access_count integer not null default 0,
  -- Whether this link may also stream evidence photos, invoices and money-transfer proofs.
  -- Defaults to FALSE: the safe link is the one you get without asking for anything.
  allow_files boolean not null default false,
  file_access_count integer not null default 0
);

create index if not exists marketing_request_report_share_links_creator_idx
  on public.marketing_request_report_share_links (created_by_hr_id, created_at desc);

comment on table public.marketing_request_report_share_links is
  'Shareable live views of the Marketing Request report. A link is a bearer credential: mandatory '
  'expiry, one-click revoke, creator-frozen scope, every open audited. The human surface also '
  'requires a passcode; the CSV feed cannot (a sheet formula cannot supply one) and is meant to '
  'sit inside a private Google Sheet rather than be given to a person.';

comment on column public.marketing_request_report_share_links.scope is
  'The creator''s report scope AT CREATION. Never re-resolved on read — a link must not silently '
  'widen when its creator is promoted, nor break when they are not.';

comment on column public.marketing_request_report_share_links.allow_files is
  'Whether this token may stream evidence photos, invoices and money-transfer proofs. Separate '
  'from the CSV grant on purpose: the table leaks numbers, a file leaks a photograph of a named '
  'doctor''s clinic. Off unless explicitly asked for.';
