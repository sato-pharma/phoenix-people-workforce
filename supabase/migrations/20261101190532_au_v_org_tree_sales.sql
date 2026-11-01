-- WHAT: the column au.seats.sales_only and the view public.au_v_org_tree_sales. No seat has the flag yet,
-- so the view returns exactly what public.au_v_org_tree returns. No row anywhere changes.
--
-- WHY: owner, 2026-11-01, Pedia Sharkia 1 and 2 count to Hany Saad from October. The seat that carries
-- them is hidden from the org tree, and the sales reads that follow the money read this view.
-- Account: docs/agents-owner-rules.md, "Pedia Sharkia 1 and 2".
--
-- ORDER: this file goes on BEFORE the merge, because the new code reads the view. The move itself,
-- 20261101190533_pedia_sharkia_to_hany_saad_from_october.sql, goes on AFTER production serves that code.
--
-- ROLLBACK: drop the view public.au_v_org_tree_sales, then drop the column au.seats.sales_only. Only once
-- no code reads the view and no seat carries the flag.
--
-- Idempotent. Transactional, so the view never exists with its default grants.
begin;

alter table au.seats add column if not exists sales_only boolean not null default false;

-- The org tree plus the seats that exist only so a sale has somewhere to count. Only the sales reads
-- that must follow the money use this; the path is the parent's, so a walk down from the regional seat
-- reaches it like any other district.
create or replace view public.au_v_org_tree_sales as
  select t.seat_id, t.parent_seat_id, t.seat_tier, t.line_code, t.region_code, t.area_code,
         t.is_other_pseudo_dm, t.seat_label, t.depth, t.path, t.occupant_hr_id, t.node_type,
         t.is_vacant, t.area_name, t.region_name, t.line_name, t.line_id, t.seat_display_label
    from au.v_org_tree t
  union all
  select s.seat_id, s.parent_seat_id, s.seat_tier, s.line_code, s.region_code, s.area_code,
         s.is_other_pseudo_dm, s.seat_label, p.depth + 1, p.path || s.seat_id, o.occupant_hr_id,
         o.node_type, o.occupant_hr_id is null, null::text, rg.region_name, p.line_name, p.line_id,
         s.seat_label
    from au.seats s
    join lateral (
      select distinct on (t.seat_id) t.depth, t.path, t.line_name, t.line_id
        from au.v_org_tree t
       where t.seat_id = s.parent_seat_id
    ) p on true
    left join au.occupancy_history o
      on o.seat_id = s.seat_id
     and o.effective_from <= (now() at time zone 'Africa/Cairo')::date
     and (o.effective_to is null or o.effective_to > (now() at time zone 'Africa/Cairo')::date)
    left join au.regions rg on rg.region_code = s.region_code
   where s.sales_only
     and (s.effective_from is null or s.effective_from <= (now() at time zone 'Africa/Cairo')::date)
     and (s.effective_to is null or s.effective_to > (now() at time zone 'Africa/Cairo')::date);

revoke all on public.au_v_org_tree_sales from public, anon, authenticated;
grant select on public.au_v_org_tree_sales to service_role;

notify pgrst, 'reload schema';

commit;
