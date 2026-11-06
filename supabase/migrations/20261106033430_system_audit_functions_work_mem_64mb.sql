-- system_audit_functions_work_mem_64mb
--
-- WHAT THIS CHANGES: the two System Audit functions' own work_mem, 32MB → 64MB.
--   public.system_audit_page(jsonb, text, integer, integer, jsonb)
--   public.system_audit_alert_candidates()
--   Every other setting on them (search_path, plan_cache_mode) is left as it is.
-- WHY: production compute went from 2 GB to 4 GB on 2026-11-06 (03:27 Cairo) and the database-wide
--   work_mem was raised 32MB → 64MB with it (ALTER DATABASE postgres). These two functions pin their
--   own value, which wins over the database's, so without this they would be the only reads left at
--   half the new default. Owner's request, 2026-11-06 ~03:34 Cairo.
-- ROLLBACK:
--   alter function public.system_audit_page(jsonb, text, integer, integer, jsonb) set work_mem = '32MB';
--   alter function public.system_audit_alert_candidates() set work_mem = '32MB';
--
-- Note for the next CREATE OR REPLACE of either function (20261023051848_system_audit_functions.sql
-- still says set work_mem = '32MB'): a replace re-applies whatever SET clauses it carries, so write
-- 64MB there or this ALTER is quietly undone.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter function public.system_audit_page(jsonb, text, integer, integer, jsonb) set work_mem = '64MB';
alter function public.system_audit_alert_candidates() set work_mem = '64MB';

commit;
