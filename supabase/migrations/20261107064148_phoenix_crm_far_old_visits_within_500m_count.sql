-- phoenix_crm_far_old_visits_within_500m_count
--
-- APPLIED BY HAND (scripts/apply-sql-file.mjs, staging then production) — like 20261107044059, whose trigger
-- it replaces. Never part of the merge.
--
-- WHY (owner, 7 Nov 2026: "visits upto 500 m move them to normal visits but flag them"): a converted old
-- iReports360 visit whose check-in lay past the far line (visit_far_meters, 300 m) but no more than 500 m from
-- the customer's validated place is a NORMAL visit — counted in visits and KPIs, its location_flag kept 'far'
-- so the visit reports show it "Far from the place". Only one beyond 500 m is archived 'far'.
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_visits_old_system_kpi (the BEFORE trigger of 20261107044059): the archive line for a far
--      converted visit is 500 m, and a far one within it counts. The same number is
--      OLD_VISIT_ARCHIVE_FAR_METERS in src/lib/phoenix-crm/old-visit-conversion.ts.
--   2. The converted visits archived 'far' within 500 m are touched once, so the trigger lifts their mark and
--      counts them; the AFTER trigger phoenix_crm_visits_old_system_far_archive removes their far archive rows.
--      Measured on production before this ran: 1,800 visits, 1,805 archive rows; 3,802 stay archived beyond 500 m.
--
-- WHAT DOES NOT CHANGE: no row is deleted from phoenix_crm_visits; crm_visits_unified serves the same rows
--   (it serves every old row, archived or not — only counts_in_kpi follows, once 20261107044742 is applied).
--
-- ROLLBACK: re-run the phoenix_crm_visits_old_system_kpi statement of 20261107044059, then touch the same rows
--   (`update public.phoenix_crm_visits set archived_at = archived_at where imported_from_ireports360_at is not null
--   and location_flag = 'far' and archived_at is null and place_id is not null`): the trigger re-archives them
--   and the AFTER trigger re-creates their archive rows from the sources. Before-image:
--   F:\PHX backup\phoenix-crm-ireports360-conversion-20261107\before-far-500-*.json.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

-- 1. The rule ---------------------------------------------------------------------------------------------

create or replace function public.phoenix_crm_visits_old_system_kpi()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare
  -- Far BEYOND 500 m only: a far converted visit within 500 m is a normal visit, flagged (owner, 7 Nov 2026).
  v_far boolean := new.imported_from_ireports360_at is not null
    and new.ireports360_checkin_id is not null
    and new.place_id is not null
    and new.location_flag = 'far'
    and (new.distance_meters is null or new.distance_meters > 500);
begin
  if v_far and new.archived_at is null then
    new.archived_at := now();
    new.archive_reason := 'far';
  elsif not v_far and new.archive_reason = 'far' then
    new.archived_at := null;
    new.archive_reason := null;
  end if;

  new.ireports360_kpi_counted := new.imported_from_ireports360_at is not null
    and new.archived_at is null
    and new.ireports360_checkin_id is not null
    and new.lat is not null
    and new.place_id is not null
    and (
      new.location_flag in ('ok', 'weak_gps')
      or (new.location_flag = 'far' and new.distance_meters <= 500)
    );
  return new;
end;
$function$;

revoke execute on function public.phoenix_crm_visits_old_system_kpi() from public, anon, authenticated;

comment on column public.phoenix_crm_visits.ireports360_kpi_counted is
  'A copied visit that counts in visits and KPIs: converted with a check-in AND measured ok, weak GPS, or far within 500 m (flagged far) against a validated place, and not archived. Set by the trigger phoenix_crm_visits_old_system_kpi only.';
comment on column public.phoenix_crm_visits.archived_at is
  'A copied visit that is not a visit (a campaign visit, or no check-in location), or a converted one whose check-in lay more than 500 m from the validated place (far, kept by the trigger phoenix_crm_visits_old_system_kpi). Owner, 2026-11-07. Never deleted, counted nowhere, shown on no visit screen. Its old visits are in phoenix_crm_visit_archive.';
comment on column public.phoenix_crm_visit_archive.distance_meters is
  'A far visit (reason far): metres from its check-in to the validated place it was measured against, more than 500 m. Null for every other reason.';

-- 2. The far visits within 500 m come back ----------------------------------------------------------------

update public.phoenix_crm_visits
   set archived_at = archived_at
 where imported_from_ireports360_at is not null
   and archive_reason = 'far'
   and distance_meters <= 500;

commit;
