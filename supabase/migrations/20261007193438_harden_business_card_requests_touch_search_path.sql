-- Pin the search_path on the business_card_requests "touch" trigger function.
--
-- The Supabase security linter flags it as `function_search_path_mutable`: a
-- SECURITY INVOKER plpgsql function whose search_path is role-mutable. The body
-- only calls now() (pg_catalog, always resolvable regardless of search_path) and
-- assigns new.updated_at, so it schema-qualifies nothing and an empty search_path
-- is safe. Same remediation pattern used for au.enforce_lam_region() on
-- 2026-07-19. Non-destructive ALTER; no data touched.

alter function public.business_card_requests_touch() set search_path = '';
