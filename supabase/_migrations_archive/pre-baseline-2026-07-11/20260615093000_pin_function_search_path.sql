-- ============================================================================
-- Pin search_path on functions flagged with a role-mutable search_path
-- ----------------------------------------------------------------------------
-- Finding (Low, security advisor 0011 function_search_path_mutable): four
-- functions have no fixed search_path, so object resolution depends on the
-- caller's session search_path. Pinning it removes the ambiguity / search-path
-- injection surface. (All four are SECURITY INVOKER, so the practical risk is
-- low, but the advisor expects an explicit search_path.)
--
-- Verified live signatures (ref ozucdzovmcqvepbozvqf):
--   private.phx_exec_source(text, text)        -- builds a jsonb status blob
--   public.generate_report_it_number()         -- nextval('report_it_report_number_seq')
--   public.phx_sos_try_date(text, text)        -- safe to_date() wrapper
--   public.report_it_set_updated_at()          -- updated_at trigger
--
-- `public, pg_temp` covers every object each function references
-- (the sequence lives in public; the rest are pg_catalog built-ins, which are
-- always implicitly resolved first). ALTER FUNCTION ... SET search_path does
-- not change behaviour beyond pinning resolution. Reversible with RESET.
-- ============================================================================

alter function private.phx_exec_source(text, text)      set search_path = public, pg_temp;
alter function public.generate_report_it_number()       set search_path = public, pg_temp;
alter function public.phx_sos_try_date(text, text)      set search_path = public, pg_temp;
alter function public.report_it_set_updated_at()        set search_path = public, pg_temp;
