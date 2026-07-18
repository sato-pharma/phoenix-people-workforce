-- Phase 7 defense-in-depth: enable RLS (deny-all, no policies) on the remaining au tables.
-- postgres (table+function owner) and service_role (app admin client) both have BYPASSRLS, so the
-- SECURITY DEFINER attribution/achievement functions and the app read/write unaffected; anon/
-- authenticated (no bypass, no grants, au not PostgREST-exposed) are fully denied. monthly_targets
-- already has RLS enabled.
alter table au.regions               enable row level security;
alter table au.lines                 enable row level security;
alter table au.canonical_areas       enable row level security;
alter table au.sos_official_line_map enable row level security;
alter table au.sos_area_crosswalk    enable row level security;
alter table au.seats                 enable row level security;
alter table au.line_area_map         enable row level security;
alter table au.occupancy_history     enable row level security;
alter table au.area_migration_map    enable row level security;
