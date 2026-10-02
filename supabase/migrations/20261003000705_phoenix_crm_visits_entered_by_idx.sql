-- phoenix_crm_visits_entered_by_idx
--
-- WHAT THIS CHANGES: one index on public.phoenix_crm_visits (entered_by_hr_id, captured_at).
--   No column, no constraint, no data: additive and invisible to every existing read.
-- WHY: the owner's rule of 2026-10-03 — the FIRST visit a rep ever submits emails his district
--   manager, his national sales manager and the SFE Manager. Every save therefore asks "has this
--   person submitted one before?" (`isFirstVisitSubmittedBy`, src/lib/phoenix-crm/server/visits.ts),
--   and that question has no index today: `entered_by_hr_id` is indexed nowhere. The answer costs
--   nothing at 7 rows and a full scan at the ~600 visits a working day this module is built for —
--   worst in exactly the case the notice exists for, a rep with no earlier row, where `limit 1`
--   cannot stop early and must read the whole table.
-- ROLLBACK: drop index if exists public.phoenix_crm_visits_entered_by_idx;
--   Nothing reads the index by name, so dropping it only makes that one query slower again.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create index if not exists phoenix_crm_visits_entered_by_idx
  on public.phoenix_crm_visits (entered_by_hr_id, captured_at);

commit;

-- Before you push, the rules that fail the required `validate` job:
--   * a public SECURITY DEFINER function must
--       revoke execute on function public.<fn>(<args>) from public, anon, authenticated;
--     and then re-grant what needs it (revoking PUBLIC also strips service_role).
--   * never  alter default privileges ... in schema public grant ... to anon|authenticated
--   * a snapshot table goes in <domain>_backup_YYYYMMDD, never in public
--   * DROP TABLE / TRUNCATE wants a  -- SAFE: <reason>  annotation
-- Timestamp 20261003000705 was minted to sort after every migration already on main.
