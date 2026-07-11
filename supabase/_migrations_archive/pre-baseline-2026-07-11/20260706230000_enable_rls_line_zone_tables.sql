-- Supabase Security Advisor flagged these 3 tables as ERROR-level "RLS Disabled in Public":
-- 20260702180000_area_region_line_unification_schema.sql created them without enabling RLS.
-- No policies are added here (same deny-all pattern as the marketing_* tables in
-- 20260520233108_marketing_requests_mvp.sql): all app reads go through getSupabaseAdmin()
-- (service role, bypasses RLS), so enabling RLS with no policy is sufficient and safe.
alter table public.line_area_region_map enable row level security;
alter table public.line_zones enable row level security;
alter table public.line_zone_regions enable row level security;
