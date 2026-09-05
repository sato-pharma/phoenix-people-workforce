-- Seat occupancy, with its history, readable by the application.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS. `au_v_org_tree` carries who sits in a seat TODAY and no date at all, so anything
-- resolved through it labels a past month with today's people. That produced a real misattribution:
-- August 2026 credited four Delta (3) areas to a district manager whose seat begins 2026-09-01,
-- moving 6,215 EGP under the wrong name while every total still reconciled.
--
-- The area -> seat half of that was fixed against `au_v_line_area_map_all`, which was already
-- readable. The seat -> PERSON half could not be: the history lives in `au.occupancy_history`, and
-- PostgREST exposes only `public`, `graphql_public` and `analytics` — `.schema("au")` answers
-- PGRST106. This view is the missing half, and nothing more than that.
--
-- ADDITIVE AND READ-ONLY. It creates no table, changes no row, and drops nothing. `au.occupancy_history`
-- keeps its own grants; this only projects it into a schema PostgREST can see.
--
-- GRANTS MATCH ITS SIBLINGS EXACTLY — service_role only, never `authenticated`. Seat history names
-- people and the dates they moved, which is HR information and has no business reaching a browser
-- role. The application reads it with the service-role client, server-side, as it does the rest of
-- the seat model.

create or replace view public.au_v_seat_occupancy_all as
  select
    o.seat_id,
    o.occupant_hr_id,
    o.occupant_canonical_hr_id,
    o.node_type,
    o.line_code,
    o.region_code,
    o.area_code,
    o.manager_seat_id,
    o.effective_from,
    o.effective_to
  from au.occupancy_history o;

comment on view public.au_v_seat_occupancy_all is
  'Seat occupancy WITH history, for period-aware attribution. au_v_org_tree is today only; resolving a past month through it names the wrong person. Dating is half-open [effective_from, effective_to): a seat change closes and reopens on the same day, so an inclusive end matches both rows.';

revoke all on public.au_v_seat_occupancy_all from anon, authenticated, public;
grant select on public.au_v_seat_occupancy_all to service_role;
