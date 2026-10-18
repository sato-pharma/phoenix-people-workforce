-- org_tree_keeps_a_resigner_in_the_seat_until_the_last_day
--
-- WHAT THIS CHANGES:
--   au.v_org_tree joined each seat to the span that is OPEN-ENDED (o.effective_to IS NULL). It now joins
--   the span IN FORCE TODAY in Cairo: it has started (effective_from <= today) and has not ended
--   (effective_to IS NULL OR effective_to > today).
-- WHY:
--   au.resign_occupant (called by phx_vacate_au_seats_for_employee) dates a resignation in the FUTURE:
--   it closes the occupant's span at last working day + 1 and inserts a vacant placeholder span that
--   starts on that same day with no end. The view only looked for the open-ended span, so the placeholder
--   won the join the moment the resignation was recorded and the seat read VACANT while the rep was
--   still working. Hana Abdelaziz (B-110, Pedia GZ4 rep, last day 2026-10-31) lost her Phoenix CRM row,
--   page and territory the day her resignation was filed, with 13 working days left. The rule it breaks:
--   a resignation vacates the seat on last working day + 1, never on the last working day itself.
--   Every other occupied seat has an open-ended span that started in the past, so the only row that
--   changes today is the resigner's; from 1 November the placeholder's span is in force and the seat
--   reads vacant, exactly as before.
-- ROLLBACK:
--   create or replace view au.v_org_tree with the join condition `o.effective_to IS NULL` in place of
--   the in-force test (the pre-image definition). View-only: no row is written.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration redefines one read-only view and writes no rows; same columns, same order.

begin;

create or replace view au.v_org_tree as
 WITH RECURSIVE tree AS (
         SELECT s.seat_id,
            s.parent_seat_id,
            s.seat_tier,
            s.line_code,
            s.region_code,
            s.area_code,
            s.is_other_pseudo_dm,
            s.seat_label,
            0 AS depth,
            ARRAY[s.seat_id] AS path
           FROM au.seats s
          WHERE s.parent_seat_id IS NULL AND s.is_active AND (s.effective_to IS NULL OR s.effective_to > (now() AT TIME ZONE 'Africa/Cairo'::text)::date)
        UNION ALL
         SELECT c.seat_id,
            c.parent_seat_id,
            c.seat_tier,
            c.line_code,
            c.region_code,
            c.area_code,
            c.is_other_pseudo_dm,
            c.seat_label,
            t_1.depth + 1,
            t_1.path || c.seat_id
           FROM au.seats c
             JOIN tree t_1 ON c.parent_seat_id = t_1.seat_id
          WHERE c.is_active AND (c.effective_to IS NULL OR c.effective_to > (now() AT TIME ZONE 'Africa/Cairo'::text)::date)
        )
 SELECT t.seat_id,
    t.parent_seat_id,
    t.seat_tier,
    t.line_code,
    t.region_code,
    t.area_code,
    t.is_other_pseudo_dm,
    t.seat_label,
    t.depth,
    t.path,
    o.occupant_hr_id,
    o.node_type,
    o.occupant_hr_id IS NULL AS is_vacant,
    ca.area_name,
    rg.region_name,
    ln.line_name,
    ln.line_id,
        CASE
            WHEN o.occupant_hr_id IS NULL THEN t.seat_label || ' (VACANT)'::text
            ELSE t.seat_label
        END AS seat_display_label
   FROM tree t
     LEFT JOIN au.occupancy_history o ON o.seat_id = t.seat_id
       AND o.effective_from <= (now() AT TIME ZONE 'Africa/Cairo'::text)::date
       AND (o.effective_to IS NULL OR o.effective_to > (now() AT TIME ZONE 'Africa/Cairo'::text)::date)
     LEFT JOIN au.canonical_areas ca ON ca.area_code = t.area_code
     LEFT JOIN au.regions rg ON rg.region_code = t.region_code
     LEFT JOIN au.lines ln ON ln.line_code = t.line_code;

commit;
