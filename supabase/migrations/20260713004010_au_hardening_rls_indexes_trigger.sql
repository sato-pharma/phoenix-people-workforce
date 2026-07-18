-- #1 Lock the org views to service-role only (app reads server-side; block anon/authenticated
-- from pulling the whole org tree via the API and bypassing line-scoping).
revoke select on public.au_v_org_tree, public.au_v_org_structure_kpis, public.au_v_line_area_map, public.au_v_canonical_areas from anon, authenticated;

-- #5 Indexes on the new join keys (tree climb + employee<->seat joins).
create index if not exists idx_occ_canonical_hr on au.occupancy_history(occupant_canonical_hr_id);
create index if not exists idx_occ_seat on au.occupancy_history(seat_id);
create index if not exists idx_seats_parent on au.seats(parent_seat_id);
create index if not exists idx_lam_dm_seat on au.line_area_map(dm_seat_id);
create index if not exists idx_lam_rep_seat on au.line_area_map(rep_seat_id);

-- #4 Integrity: a mapping's operational region must equal its DM-seat's region (no drift).
create or replace function au.enforce_lam_region() returns trigger
language plpgsql as $$
declare seat_region text;
begin
  if new.dm_seat_id is not null then
    select region_code into seat_region from au.seats where seat_id = new.dm_seat_id;
    if seat_region is distinct from new.operational_region_code then
      raise exception 'line_area_map(%,%): operational_region_code % must equal dm_seat % region %',
        new.line_code, new.area_code, new.operational_region_code, new.dm_seat_id, seat_region;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_lam_region on au.line_area_map;
create trigger trg_lam_region before insert or update on au.line_area_map
  for each row execute function au.enforce_lam_region();
