-- Marketing ROI saved filter presets (per-user saved views for the Filter Engine).
-- filter_json stores a serialized RoiFilterState. A stale/shared preset can never widen
-- visibility: the server re-derives the viewer's scope and re-validates on every report
-- request (incl. re-checking includeRestricted against canRevealRestricted).
--
-- Server-only: the app uses the service-role client and enforces owner-scoping in the
-- service layer (auth is application-managed; there is no Supabase-Auth JWT carrying the
-- HR_ID, so RLS cannot owner-scope). RLS is enabled with an explicit deny-all policy as
-- defense-in-depth + advisor hygiene.
--
-- APPROVAL-GATED — NOT YET APPLIED: stage to staging, verify, then apply to production with
-- explicit per-migration approval.

create table if not exists public.marketing_roi_filter_presets (
  id uuid primary key default gen_random_uuid(),
  owner_hr_id text not null references public.employees(hr_id) on update cascade on delete cascade,
  name text not null check (btrim(name) <> ''),
  filter_json jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  scope_role text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_roi_filter_presets_owner_name_unique unique (owner_hr_id, name)
);

create index if not exists marketing_roi_filter_presets_owner_idx
  on public.marketing_roi_filter_presets (owner_hr_id);
create unique index if not exists marketing_roi_filter_presets_one_default_uidx
  on public.marketing_roi_filter_presets (owner_hr_id) where is_default = true;

alter table public.marketing_roi_filter_presets enable row level security;
drop policy if exists marketing_roi_filter_presets_no_direct_access on public.marketing_roi_filter_presets;
create policy marketing_roi_filter_presets_no_direct_access
  on public.marketing_roi_filter_presets for all using (false) with check (false);

grant all on table public.marketing_roi_filter_presets to service_role;

notify pgrst, 'reload schema';
