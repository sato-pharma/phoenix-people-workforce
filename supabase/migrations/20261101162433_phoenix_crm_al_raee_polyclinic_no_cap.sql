-- phoenix_crm_al_raee_polyclinic_no_cap
--
-- WHAT THIS CHANGES:
--   One key-only row in phoenix_crm_offplan_exemptions, lifts_venue_cap = true, for the polyclinic
--   مستشفي الراعي الصالح on Mohamed Ahmed Mohamed Hassan Salem's seat (SEAT-PED-REP-D11, Pedia, Qalubeya).
--   The doors already exist (20261031170001): phoenix_crm_venue_cap_lifted(seat) answers this venue, so the
--   venue's own daily number (shared_place_daily_cap, 3) no longer applies to it on the plan's save, on its send
--   or at the door; and the existing venue-row door lifts the out-of-plan cap (2 a day, 8 a week) there.
--   No function, no column and no setting changes.
--
-- WHY (owner, 2026-11-01): "MAKE الراعى الصالح POLYCLICNIC FOR MOHAMED SALEM QALUBEYA PEDIA BE ABLE TO SUBMIT DRS
--   IN THIS POLYCLINIC AS NEEDED DONOT FOLLOW THE CAP IN THIS POLYCLINIC ONLY"
--   Only the caps are lifted. No other seat is reached: the CNS rep's venues of the same name in Qalubeya are on
--   SEAT-CNS-REP-D11 and keep their three. His other venue, مستشفي كنيسه العذراء, keeps its three. The approval chain
--   for an unplanned visit, one visit per customer per day, the plan's AM / PM day caps (5 and 15) and the hold on
--   a customer nobody has validated all stay.
--
-- ROLLBACK:
--   update public.phoenix_crm_offplan_exemptions set ended_at = now()
--    where seat_id = 'SEAT-PED-REP-D11' and lifts_venue_cap and ended_at is null;
--   Nothing existing is rewritten or deleted by this migration, so there is no pre-image to take.

begin;
set local lock_timeout = '5s';

insert into public.phoenix_crm_offplan_exemptions
  (seat_id, label, customer_id, venue_name_key, note, granted_by_hr_id, lifts_venue_cap)
select 'SEAT-PED-REP-D11',
       'مستشفي الراعي الصالح',
       null,
       public.phoenix_crm_fold_name('الراعي الصالح'),
       'Owner, 2026-11-01: as many doctors as needed in this polyclinic; no daily number here, this polyclinic only; approval unchanged.',
       'B-10',
       true
where not exists (
  select 1 from public.phoenix_crm_offplan_exemptions e
  where e.seat_id = 'SEAT-PED-REP-D11'
    and e.venue_name_key = public.phoenix_crm_fold_name('الراعي الصالح')
    and e.ended_at is null
);

-- "This polyclinic only": the key must reach at most one venue on the seat. Staging, cloned before the rep captured
-- it, holds none; production holds exactly the one.
do $$
declare
  v_lifted integer;
begin
  select count(*) into v_lifted from public.phoenix_crm_venue_cap_lifted('SEAT-PED-REP-D11');
  if v_lifted > 1 then
    raise exception 'phoenix_crm_al_raee_polyclinic_no_cap: the key reaches % venues on the seat, expected one', v_lifted;
  end if;
end;
$$;

commit;
