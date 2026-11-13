-- Backfill job_title from positions.title when job_title is NULL/empty
-- Run in a safe maintenance window. Review and backup before executing.
-- Assumes tables: employees (id, position_id, job_title) and positions (id, title)

BEGIN;

-- Preview rows that will be updated
-- SELECT e.id, e.position_id, e.job_title, p.title
-- FROM public.employees e
-- JOIN public.positions p ON p.id = e.position_id
-- WHERE (e.job_title IS NULL OR trim(e.job_title) = '')
--   AND p.title IS NOT NULL;

-- Perform idempotent update: only updates when job_title is null/empty and position has a title
UPDATE public.employees e
SET job_title = p.title
FROM public.positions p
WHERE e.position_id = p.id
  AND (e.job_title IS NULL OR trim(e.job_title) = '')
  AND p.title IS NOT NULL;

COMMIT;

-- Notes:
-- * Test the SELECT preview first to confirm affected rows.
-- * Consider running within a transaction and taking a backup or PITR snapshot.
-- * If your schema uses different column/table names (e.g., positionId), adapt accordingly.
