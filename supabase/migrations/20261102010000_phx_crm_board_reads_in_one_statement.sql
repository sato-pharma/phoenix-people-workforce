-- Three Phoenix CRM board reads in ONE statement each: phx_crm_open_assignments(),
-- phx_crm_brick_meta(text[]) and phx_crm_contact_checkins(bigint[]).
--
-- WHY (owner, 1 Nov 2026: "find the ROOT root cause of the slowness"). Each read costs about 450 ms at
-- Supabase's edge for 2-7 ms of SQL on the saturated 2-core host (measured 1 Nov 2026, 10:30-11:00 Cairo:
-- 36,104 requests in half an hour), so the number of requests is the lever, not the statements. Three
-- readers behind the Reps List / My List board and the KPI boards asked in waves of chunked requests what
-- one statement answers:
--   1. loadPanelRows (src/lib/crm/rep-kpi-reports-data.ts) counted the open crm_contact_assignments rows
--      (14,440 that day) and fetched fifteen OFFSET pages at once on every KPI open — 5,488 pages a day at
--      28 ms each, 154 s of database time, the heaviest statement of the day;
--   2. loadBrickMeta (src/lib/crm/reps-list.ts) read the bricks in play, then their areas, then those
--      areas' regions — three waves of chunked reads for a few dozen names;
--   3. loadCheckins (src/lib/crm/reps-list.ts) walked each chunk of fifty contacts through the
--      crm_checkins_unified view by keyset — two to six chunks, one rep's history being ~1,200 rows.
--
-- WHAT EACH RETURNS. One jsonb array of tuples, not a set, because PostgREST's 1,000-row cap applies to a
-- set-returning function too (phx_crm_contact_roster, 25 Oct 2026, is the precedent):
--   phx_crm_open_assignments()      [id, agent_crm_id, agent_hr_id, contact_crm_id, grade, list_type] per
--                                   open assignment (effective_to is null), ordered by id — the page
--                                   walk's rows in the page walk's order;
--   phx_crm_brick_meta(p_brick_ids) [brick_id, brick_name, area_code, area_name, region_name] per named
--                                   brick that is not retired (active is distinct from false), the region
--                                   taken from the area's region code, else the brick's own — the same
--                                   fall-through the three-wave read applied;
--   phx_crm_contact_checkins(p_contact_ids)
--                                   [contact_crm_id, agent_crm_id, agent_hr_id, lat, lon, address,
--                                   check_date] per iReports360 check-in of those contacts that has a pin
--                                   (lat and lon not null), newest first with the check-in id breaking a
--                                   tie — the walk's rows in the walk's order, so the first row seen for a
--                                   contact is still the pin the board shows. A Phoenix visit's position
--                                   never reaches a rep's screen (golden rule #1), so the source is fixed.
--
-- MEASURED on production, 1 Nov 2026 (light reads, shared buffers warm): the open assignments 86.7 ms for
-- 14,440 rows; the brick names 4.6 ms; one rep's 1,200 check-ins 26.8 ms through
-- perf_ireports360_checkins_contact_crm_id_check_date. The contact ids are taken as a PARAMETER on
-- purpose: `= any((select array_agg(...)))` planned a 346 ms full scan of the view in the same measurement.
--
-- NO FIGURE CHANGES: the same filters, the same columns, the same rows; the TypeScript mappers
-- (toPanelContactRecord, brickMetaFromTuple, checkinRowFromTuple) are pinned by
-- tests/phoenix-crm-board-reads.test.ts. SECURITY DEFINER (search_path 'public'), executable by the
-- service role only, as the reads were. Until it is applied each caller falls back to its page walk
-- (PGRST202).
--
-- ROLLBACK:
--   drop function if exists public.phx_crm_open_assignments();
--   drop function if exists public.phx_crm_brick_meta(text[]);
--   drop function if exists public.phx_crm_contact_checkins(bigint[]);

begin;

set local lock_timeout = '5s';

create or replace function public.phx_crm_open_assignments()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_array(a.id, a.agent_crm_id, a.agent_hr_id, a.contact_crm_id, a.grade, a.list_type)
      order by a.id
    ),
    '[]'::jsonb
  )
  from public.crm_contact_assignments a
  where a.effective_to is null;
$$;

comment on function public.phx_crm_open_assignments() is
  'Every open crm_contact_assignments row as one jsonb array of [id, agent_crm_id, agent_hr_id, contact_crm_id, '
  'grade, list_type], ordered by id. Read by loadPanelRows (src/lib/crm/rep-kpi-reports-data.ts). See '
  'supabase/migrations/20261102010000_phx_crm_board_reads_in_one_statement.sql.';

revoke execute on function public.phx_crm_open_assignments() from public, anon, authenticated;
grant execute on function public.phx_crm_open_assignments() to service_role;

create or replace function public.phx_crm_brick_meta(p_brick_ids text[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_array(b.brick_id, b.brick_name, b.area_code, a.area_name, r.region_name)
      order by b.brick_id
    ),
    '[]'::jsonb
  )
  from public.source_of_sales_bricks b
  left join public.source_of_sales_areas a on a.area_code = b.area_code
  left join public.source_of_sales_regions r
    on r.region_code = coalesce(nullif(btrim(a.region_code), ''), nullif(btrim(b.region_code), ''))
  where b.brick_id = any (coalesce(p_brick_ids, '{}'::text[]))
    and b.active is distinct from false;
$$;

comment on function public.phx_crm_brick_meta(text[]) is
  'The named bricks that are not retired, as one jsonb array of [brick_id, brick_name, area_code, area_name, '
  'region_name] - the region from the area''s region code, else the brick''s own. Read by loadBrickMeta '
  '(src/lib/crm/reps-list.ts). See supabase/migrations/20261102010000_phx_crm_board_reads_in_one_statement.sql.';

revoke execute on function public.phx_crm_brick_meta(text[]) from public, anon, authenticated;
grant execute on function public.phx_crm_brick_meta(text[]) to service_role;

create or replace function public.phx_crm_contact_checkins(p_contact_ids bigint[])
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_array(c.contact_crm_id, c.agent_crm_id, c.agent_hr_id, c.lat, c.lon, c.address, c.check_date)
      order by c.check_date desc, c.crm_checkin_id desc
    ),
    '[]'::jsonb
  )
  from public.crm_checkins_unified c
  where c.source = 'ireports360'
    and c.contact_crm_id = any (coalesce(p_contact_ids, '{}'::bigint[]))
    and c.lat is not null
    and c.lon is not null;
$$;

comment on function public.phx_crm_contact_checkins(bigint[]) is
  'The iReports360 check-ins with a pin of the named contacts, newest first, as one jsonb array of '
  '[contact_crm_id, agent_crm_id, agent_hr_id, lat, lon, address, check_date]. Read by loadCheckins '
  '(src/lib/crm/reps-list.ts). See supabase/migrations/20261102010000_phx_crm_board_reads_in_one_statement.sql.';

revoke execute on function public.phx_crm_contact_checkins(bigint[]) from public, anon, authenticated;
grant execute on function public.phx_crm_contact_checkins(bigint[]) to service_role;

notify pgrst, 'reload schema';

commit;
