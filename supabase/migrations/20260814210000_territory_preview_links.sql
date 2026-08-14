-- Territory Management preview links (owner request, 2026-08-14): a link that anyone can open with
-- no Phoenix account, no username and no passcode. The recipient picks a region, then an area, and
-- sees that area's brick pins on a map.
--
-- HOW THIS DIFFERS FROM direct_order_report_share_links, AND WHY.
--
-- That table's human surface REQUIRES a passcode. This one deliberately has none — the owner asked
-- for "normal access, no password or username". So the passcode column is not merely unused here,
-- it is absent: a nullable passcode_hash would invite a later session to "restore" the gate the
-- feature exists to remove, and an always-null column reads as a bug rather than a decision.
--
-- Losing the passcode makes every remaining control load-bearing, so each is stronger here:
--
--   * `token`      — 32 random bytes, base64url. With no second factor this IS the credential.
--   * `expires_at` — MANDATORY, and the owner set the default at 14 days rather than 30. An open
--                    link with no end date is an unowned public copy of the company's geography.
--   * `revoked_at` — one click kills it without waiting for expiry.
--   * `area_codes` — THE containment. Not a coarse scope word re-resolved at read time, but the
--                    literal list of area codes the creator could see AT CREATION. The public
--                    routes intersect every request against this array, so a forged area code
--                    cannot reach geography the creator never had, and a promotion cannot widen a
--                    link that was already sent.
--   * `line_code`  — frozen too, and NEVER rendered to the viewer. An area's brick allocation only
--                    means something inside one line, so the link must pin one; the owner asked
--                    that the line itself not be shown, hence 'pedia' by default with no picker.
--   * access columns — a link nobody opened and a link opened 200 times are different facts.
--
-- What the link does NOT carry, by construction rather than by the UI hiding it: the residence
-- recommendation, the "closer to another area" mis-assignment findings, the route/span/gap km, and
-- the coverage tiles. Those are internal management analysis; the public route projects them out
-- before responding, so they are absent from the payload and not merely unrendered.

create table if not exists public.territory_preview_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  label text,
  created_by_hr_id text not null,
  created_at timestamptz not null default now(),
  -- Frozen at creation. Pinned to one line because area membership is per-line; never shown to the
  -- viewer, who sees only regions, areas and bricks.
  line_code text not null default 'pedia',
  -- Frozen at creation: the exact areas the creator could see. This is the containment boundary.
  area_codes text[] not null default '{}',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_hr_id text,
  last_accessed_at timestamptz,
  access_count integer not null default 0
);

create index if not exists territory_preview_links_creator_idx
  on public.territory_preview_links (created_by_hr_id, created_at desc);

comment on table public.territory_preview_links is
  'Passwordless preview links for Territory Management (owner request, 2026-08-14). Anyone holding '
  'the URL is the audience: there is no passcode by design, so the 32-byte token, the mandatory '
  '14-day expiry, one-click revoke and the frozen area_codes list are the whole of the control. '
  'The viewer filters region then area and sees brick pins only — never the residence '
  'recommendation, the mis-assignment findings or the line the link is pinned to.';

comment on column public.territory_preview_links.area_codes is
  'The literal area codes the creator could see AT CREATION. Every public request is intersected '
  'against this array, so a forged area code reaches nothing and a later promotion cannot widen a '
  'link that has already been sent. Never re-resolved from the creator''s live scope.';

comment on column public.territory_preview_links.line_code is
  'The line the link is pinned to. Frozen because an area''s brick allocation only means something '
  'inside one line. Deliberately NEVER rendered to the viewer — the owner asked that the preview '
  'not disclose which line it is built from.';

-- RLS parity, matching 20260806010000_share_links_rls_parity.sql. This table stores tokens that
-- alone unlock a public view of company geography, so it carries the same risk shape as the report
-- share-link tables: anything created in `public` inherits the schema-wide grants, and only RLS plus
-- an explicit REVOKE keeps it shut. That earlier migration exists precisely because the first two
-- share-link tables shipped WITHOUT this and sat open in staging until someone measured it — so it
-- is done here in the same file as the table, not left for a later parity sweep to discover.
--
-- Access is mediated entirely by server-side code through the service-role client, so
-- service_role-only is the whole intended contract: there is no legitimate direct reader among anon
-- or authenticated. Note the GRANT is not optional — REVOKE ... FROM PUBLIC also strips what
-- service_role held implicitly through the default ACL, and this repo has been bitten by that.

alter table public.territory_preview_links enable row level security;

drop policy if exists territory_preview_links_service_role_all on public.territory_preview_links;
create policy territory_preview_links_service_role_all
  on public.territory_preview_links for all to service_role using (true) with check (true);

revoke all on table public.territory_preview_links from anon;
revoke all on table public.territory_preview_links from authenticated;
revoke all on table public.territory_preview_links from public;
grant all on table public.territory_preview_links to service_role;

-- Fail loudly rather than reporting success while a bearer-token table is still open.
do $verify$
declare
  v_oid oid := to_regclass('public.territory_preview_links');
begin
  if not (select relrowsecurity from pg_class where oid = v_oid) then
    raise exception 'RLS is not enabled on territory_preview_links — bearer tokens would be unprotected';
  end if;
  if has_table_privilege('anon', v_oid, 'SELECT')
     or has_table_privilege('authenticated', v_oid, 'SELECT') then
    raise exception 'anon/authenticated can still read territory_preview_links — tokens are exposed';
  end if;
  if not has_table_privilege('service_role', v_oid, 'SELECT') then
    raise exception 'service_role lost SELECT on territory_preview_links — every server reader would break';
  end if;
end
$verify$;

notify pgrst, 'reload schema';
