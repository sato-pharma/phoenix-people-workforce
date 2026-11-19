-- phoenix_crm_visits_agent_day_and_rep_day_indexes
--
-- Phoenix CRM visits: two indexes so a read that names a rep reads that rep's visits, not the table.
--
-- WHY (19 Nov 2026 performance audit; production pg_stat_statements since 1 Nov, read only).
--   1. Both CRM doors, crm_visits_unified and crm_checkins_unified, give a Phoenix row the agent
--      coalesce(p.rep_hr_id, p.manager_hr_id). No index carried that expression, so every door read that
--      names people by agent_hr_id read EVERY visit in its date window on phoenix_crm_visits_day_idx and
--      threw the other reps' rows away afterwards: a three-month window read ~36,000 rows for one rep, a
--      year-to-date window turned into a sequential scan, and the Medical Rep landing's double-visit
--      summary, which carried no date at all, read all ~118,000 visits about 550 times a day. Six such
--      statements came to about 10,000 seconds of database time.
--   2. The System Audit's visit-lifecycle detector (readSavedVisits) asks rep_hr_id = any(...) and
--      visit_date = any(...) ordered by id. With no (rep_hr_id, visit_date) index the planner walked the
--      whole primary key for it, ~7,600 buffers a call.
--
-- WHAT THIS CHANGES
--   phoenix_crm_visits_agent_day_idx on ((coalesce(rep_hr_id, manager_hr_id)), visit_date),
--     partial on `not is_test and imported_from_ireports360_at is null` — the two filters BOTH doors'
--     Phoenix branches apply, so the planner can prove the predicate from the door's own WHERE.
--     🔴 The expression must stay identical to the doors' agent expression. A later door body that
--     changes it (an upper(), a btrim(), another coalesce arm) loses this index without an error and
--     every rep read goes back to the whole window. tests/phoenix-crm-visits-agent-index.test.ts reads
--     the newest door and this file and holds the two equal.
--   phoenix_crm_visits_rep_day_idx on (rep_hr_id, visit_date) — the raw table's rep reads.
--
-- HOW IT REACHES PRODUCTION. CREATE INDEX CONCURRENTLY, run on its own before this file, so no write
-- lock lands on the table every rep's visit save writes to. CONCURRENTLY cannot run inside a
-- transaction and migrations do, so the statements below are the plain form behind IF NOT EXISTS: a
-- no-op on production once the indexes are there, and correct for staging and any rebuilt database.
--
-- ROLLBACK:
--   drop index concurrently if exists public.phoenix_crm_visits_agent_day_idx;
--   drop index concurrently if exists public.phoenix_crm_visits_rep_day_idx;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. Nothing
-- here changes a row: two indexes are added and nothing is dropped.

begin;

create index if not exists phoenix_crm_visits_agent_day_idx
  on public.phoenix_crm_visits ((coalesce(rep_hr_id, manager_hr_id)), visit_date)
  where not is_test and imported_from_ireports360_at is null;

create index if not exists phoenix_crm_visits_rep_day_idx
  on public.phoenix_crm_visits (rep_hr_id, visit_date);

commit;
