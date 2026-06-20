-- Repo parity for the prod-applied migration `revoke_marketing_roi_table_default_grants`.
--
-- Least-privilege hardening for the two marketing ROI tables. Both are service-role-only +
-- RLS deny-all, so Supabase's default anon/authenticated table grants (from ALTER DEFAULT
-- PRIVILEGES on the public schema) are already inert under the deny-all RLS. This removes
-- them for explicit least-privilege + advisor hygiene. service_role keeps its explicit grant.
-- Idempotent (safe to re-run); no functional change.

revoke all on table public.marketing_roi_export_audit from anon, authenticated;
revoke all on table public.marketing_roi_filter_presets from anon, authenticated;

notify pgrst, 'reload schema';
