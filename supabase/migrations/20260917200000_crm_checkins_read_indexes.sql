-- CRM check-ins: index the two reads that had no index to use.
--
-- 1. (agent_hr_id, check_date) — a rep's own check-ins, named by HR id.
--    Production cancelled two "My Visits" check-in reads at the 8-second statement timeout
--    (14 Sep 21:40 and 17 Sep 16:24 Cairo). The page reads a rep's last 90 days of check-ins through
--    crm_checkins_unified filtered on agent_hr_id + check_date, and ireports360_checkins had no index
--    leading on either column: the planner walked (agent_crm_id, check_date) across every rep in the
--    window and threw away 51,039 of 52,834 rows (45,650 buffers) to return one rep's 1,795.
--    Staging, busiest rep, 90 days: 99.5 ms / 45,441 buffers / 50,018 rows thrown away before;
--    36.3 ms / 1,063 buffers / none thrown away after, and the generic plan a PostgREST prepared
--    statement gets uses the same index (17.6 ms).
--
-- 2. (check_date) — the company-wide check-in window, which the read door (src/lib/crm/reads.ts) now
--    reads one calendar day per request. Postgres 17 has no skip scan, so without an index leading on
--    check_date each day request walks a composite index across every rep. Staging, one day:
--    24.6 ms / 1,166 buffers before, 6.3 ms / 692 buffers after.
--
-- Additive only: no view, column or row changes, so every CRM figure is unchanged. Production holds
-- about 122,000 check-ins; a plain CREATE INDEX blocks writes to this table (not reads) while it
-- builds, which at that size is a few seconds.
--
-- Rollback:
--   drop index if exists public.ireports360_checkins_agent_hr_date_idx;
--   drop index if exists public.ireports360_checkins_check_date_idx;

create index if not exists ireports360_checkins_agent_hr_date_idx
  on public.ireports360_checkins (agent_hr_id, check_date);

create index if not exists ireports360_checkins_check_date_idx
  on public.ireports360_checkins (check_date);
