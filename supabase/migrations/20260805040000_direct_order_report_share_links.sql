-- Live Direct Orders report feed (owner request, 2026-08-05): a link that anyone can open
-- without a Phoenix account, and a CSV feed a Google Sheet can pull with IMPORTDATA so the sheet
-- refreshes itself.
--
-- THE RISK THIS TABLE EXISTS TO CONTAIN.
--
-- The report carries requester names, pharmacies, quantities, prices and sales values. A link is a
-- BEARER credential: whoever holds it is the audience, including whoever it gets forwarded to. So
-- every column here is a control, not bookkeeping:
--
--   * `token`      — 32 random bytes, base64url. Never sequential, never derived from the creator.
--   * `passcode_hash` — the human link demands a short code shared out-of-band, so a forwarded URL
--                    alone is useless. The CSV feed cannot carry one (IMPORTDATA cannot type it),
--                    which is exactly why the two surfaces are separate rows in `surface`.
--   * `expires_at` — MANDATORY. A link with no end date becomes an unowned copy of the business.
--   * `revoked_at` — one click kills it, without waiting for expiry.
--   * `scope`/`scope_hr_id` — frozen to the CREATOR's scope at creation. The link can never show
--                    more than the person who made it could see, even if their role changes later.
--   * `filters`    — the slice they were looking at, so the link matches the screen it came from.
--   * access columns — every open is counted and stamped; a link nobody opens and a link opened
--                    200 times are different facts.

create table if not exists public.direct_order_report_share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  -- 'live'  = human page, passcode required.
  -- 'feed'  = CSV for Google Sheets IMPORTDATA; token-only by necessity, so it is meant to live
  --           inside a private sheet formula and never be handed to a person.
  surface text not null default 'live' check (surface in ('live', 'feed')),
  label text,
  created_by_hr_id text not null,
  created_at timestamptz not null default now(),
  -- Frozen creator scope. 'all' | 'hierarchy' | 'own' — the same vocabulary the report uses.
  scope text not null,
  scope_hr_id text not null,
  filters jsonb,
  passcode_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_hr_id text,
  last_accessed_at timestamptz,
  access_count integer not null default 0
);

create index if not exists direct_order_report_share_links_active_idx
  on public.direct_order_report_share_links (created_by_hr_id, created_at desc);

comment on table public.direct_order_report_share_links is
  'Shareable live views of the Direct Orders report. A link is a bearer credential: mandatory '
  'expiry, one-click revoke, creator-frozen scope, and every open audited. The human surface also '
  'requires a passcode; the CSV feed cannot (IMPORTDATA cannot supply one) and is meant to sit '
  'inside a private Google Sheet formula rather than be given to a person.';

comment on column public.direct_order_report_share_links.scope is
  'The creator''s report scope AT CREATION. Never re-resolved on read — a link must not silently '
  'widen when its creator is promoted, nor break when they are not.';
