-- The company-wide contact roster (every open list row with its doctor's name, phone, speciality and CRM
-- region) is read in ONE statement instead of fourteen OFFSET pages.
--
-- WHY (2026-10-25 production load audit, after the 16:14 Cairo hard restart). One statement was 28% of all
-- database time since that restart: loadContactRoster (src/lib/crm/reps-list.ts), which every Reps List
-- rep page runs for its "also on X's list" check. It counted the open rows, then asked PostgREST for every
-- page of 1,000 at once, each page `crm_contact_assignments` with the `crm_contacts` row embedded, ordered by
-- id, by LIMIT/OFFSET: 2,357 pages, 222 ms and about 30,000 buffer hits each, 523.6 s in seven hours. An
-- embed is a LATERAL join evaluated for every row the OFFSET then throws away, so page 13 joined 13,000
-- doctors to return 1,000 — the whole read cost ~3.1 s of database time for 13,095 rows. The same rows in
-- one hash join take ~180 ms.
--
-- WHAT IT ADDS: phx_crm_contact_roster(), one jsonb array of [id, contact_crm_id, agent_crm_id, agent_hr_id,
-- name, phone, speciality, crm_region_name] per open assignment (effective_to IS NULL), ordered by id. A
-- single jsonb value, not a set, because PostgREST's 1,000-row cap applies to a set-returning function too.
-- The contact is a LEFT join, exactly the embed's null `contact` when no doctor row exists.
--
-- NO FIGURE CHANGES: the same filter, the same columns, the same rows; toRosterEntry still decides every
-- entry. SECURITY DEFINER (search_path 'public'), executable by the service role only, as the read was.
-- Until it is applied the caller falls back to its page walk (PGRST202).
--
-- ROLLBACK:
--   drop function if exists public.phx_crm_contact_roster();

begin;

set local lock_timeout = '5s';

create or replace function public.phx_crm_contact_roster()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_array(a.id, a.contact_crm_id, a.agent_crm_id, a.agent_hr_id, c.name, c.phone, c.speciality, c.crm_region_name)
      order by a.id
    ),
    '[]'::jsonb
  )
  from public.crm_contact_assignments a
  left join public.crm_contacts c on c.contact_crm_id = a.contact_crm_id
  where a.effective_to is null;
$$;

comment on function public.phx_crm_contact_roster() is
  'Every open crm_contact_assignments row with its crm_contacts name, phone, speciality and CRM region, as one '
  'jsonb array of [id, contact_crm_id, agent_crm_id, agent_hr_id, name, phone, speciality, crm_region_name], '
  'ordered by id. Read by loadContactRoster (src/lib/crm/reps-list.ts). See '
  'supabase/migrations/20261025231000_crm_contact_roster_read_in_one_statement.sql.';

revoke execute on function public.phx_crm_contact_roster() from public, anon, authenticated;
grant execute on function public.phx_crm_contact_roster() to service_role;

commit;
