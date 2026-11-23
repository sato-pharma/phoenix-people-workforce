-- The rep-picker summaries (getRepListSummaries, src/lib/crm/contact-lists.ts) in ONE statement:
-- phx_crm_rep_list_summary_groups().
--
-- WHY (23 Nov 2026, 16:01 Cairo: "AbortError: Supabase request timed out." on /api/auth/pulse, the direct
-- order area-rep lookup and /employee-portals/direct-orders/new, all inside two seconds). Ten minutes after a
-- deploy the summaries' five-minute cache was cold, and between 16:01:16 and 16:01:29 Cairo it was rebuilt
-- three times. Each rebuild counted the open crm_contact_assignments rows (17,478), cut the table's whole id
-- span (1-68,666) into eighteen ranges and walked all eighteen AT ONCE, page after page - about forty
-- requests a rebuild. Those waves took every connection PostgREST had: for those thirteen seconds every
-- other read in the app queued behind them, a one-row app_auth_users lookup included (13.6 s at Supabase's
-- edge), and the reads already waiting crossed the client's 15 s budget together - 19 timeouts in one
-- second (process_health 16:02 Cairo: supabase.fetch.timeout count 19, event loop max 66 ms, so the app was
-- not the stall).
--
-- WHAT IT RETURNS. One jsonb array, one tuple per (agent_hr_id, agent_crm_id, list_type) among the open
-- rows (effective_to is null): [first_id, agent_crm_id, agent_hr_id, list_type, rows, synced_at], where
-- first_id is the group's lowest id, rows its row count and synced_at its newest updated_at. Ordered by
-- first_id, so summarizeRepLists meets each rep's groups in the order the id walk met his rows: the first
-- group of a rep carries his first row's HR id and CRM account, the first group with a CRM account carries
-- the first row with one, and counts and the newest updated_at add up exactly. NO FIGURE CHANGES.
-- A jsonb array rather than a set because PostgREST's 1,000-row cap applies to a set-returning function too.
--
-- MEASURED on production, 23 Nov 2026: 327 groups from 17,863 open rows, 21.7 ms, 618 shared buffers, one
-- request - against ~40 requests a rebuild before.
--
-- SECURITY DEFINER (search_path 'public'), executable by the service role only, as the table reads were.
-- Until it is applied the caller falls back to its id-range walk (PGRST202).
--
-- ROLLBACK:
--   drop function if exists public.phx_crm_rep_list_summary_groups();

begin;

set local lock_timeout = '5s';

create or replace function public.phx_crm_rep_list_summary_groups()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_array(g.first_id, g.agent_crm_id, g.agent_hr_id, g.list_type, g.row_count, g.synced_at)
      order by g.first_id
    ),
    '[]'::jsonb
  )
  from (
    select
      min(a.id) as first_id,
      a.agent_crm_id,
      a.agent_hr_id,
      a.list_type,
      count(*) as row_count,
      max(a.updated_at) as synced_at
    from public.crm_contact_assignments a
    where a.effective_to is null
    group by a.agent_hr_id, a.agent_crm_id, a.list_type
  ) g;
$$;

comment on function public.phx_crm_rep_list_summary_groups() is
  'The open crm_contact_assignments rows grouped by (agent_hr_id, agent_crm_id, list_type), as one jsonb array of '
  '[first_id, agent_crm_id, agent_hr_id, list_type, rows, synced_at] ordered by first_id. Read by getRepListSummaries '
  '(src/lib/crm/contact-lists.ts). See supabase/migrations/20261123160756_crm_rep_contact_list_summaries_in_one_statement.sql.';

revoke execute on function public.phx_crm_rep_list_summary_groups() from public, anon, authenticated;
grant execute on function public.phx_crm_rep_list_summary_groups() to service_role;

commit;
