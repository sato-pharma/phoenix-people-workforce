-- WHAT:     Production Planner — the CARTON material's Arabic name becomes علبة (was كرتونة),
--           matching its English name "Box" (20261008162500). The material CODE stays CARTON.
-- WHY:      Owner, 2026-10-08: "fix the Arabic name to علبة".
-- ROLLBACK: update public.prodplan_materials set name_ar = 'كرتونة' where code = 'CARTON';
-- One row, display text only; safe to re-run (matches the old wording only).

update public.prodplan_materials
   set name_ar = 'علبة'
 where code = 'CARTON'
   and name_ar = 'كرتونة';
