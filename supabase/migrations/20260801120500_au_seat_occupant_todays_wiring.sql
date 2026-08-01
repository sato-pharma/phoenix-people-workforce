-- Who gets credited for a month's sales.
--
-- Owner ruling, 2026-08-01: "sales are wired to areas and bricks and regions, not persons; the
-- person wired to that area should have the sales wired to him" — using TODAY'S area→person wiring
-- for historical months (consistent with the standing "always today's geography" rule) — AND
-- "departed reps should keep their historical credit".
--
-- Those two together define the rule exactly:
--
--     credit = coalesce( occupant of the seat TODAY , occupant of the seat AT PERIOD END )
--
-- Today's wiring wins, so a transfer re-points history to whoever owns the area now. But when the
-- seat is vacant today, the person who actually held it then keeps the credit rather than the sale
-- becoming ownerless.
--
-- WHAT WAS WRONG. au.f_seat_occupant_asof ordered by
--     (span covers p_asof) desc, effective_from asc
--     limit 1
-- so when NO span covered the date it fell through to `effective_from asc` — the EARLIEST occupant
-- the seat ever had. That does not fail closed, it INVENTS an owner: a rep who never held the seat
-- in that period, and possibly had not joined yet. Measured over the 525 (area × period) rows the
-- loaded periods produce, that fallback was firing on 100 of them — 19%.
--
-- MEASURED EFFECT of this change, against production before shipping:
--
--     525  area × period rows in total
--     100  previously received an INVENTED owner from the earliest-ever fallback
--      83  of those now resolve to the correct person (the fabricated pick happened to be the
--          same human, because most seats have had only one occupant)
--      17  become genuinely unowned — nobody holds the area today and nobody held it then
--      17  rows change owner in total; every other attribution is byte-identical
--
-- In particular the five areas whose seat is vacant TODAY but had a real occupant at period end —
-- D16/pedia B-169, AB5/cns B-171, CA2/anti_infective AI-0004, GZ2/cns B-147, UE3/pedia B-111,
-- ≈4.87M EGP of June credit between them — are UNCHANGED. That is the "departed reps keep their
-- historical credit" half of the ruling, and it is why the fallback arm exists.
--
-- NAMING. This leaves the function called `_asof` while it now prefers today's occupant. That is a
-- deliberate trade: the alternative is editing the two large plpgsql callers
-- (au.f_monthly_attribution, au.f_monthly_achievement), which both call
-- `au.f_seat_occupant_asof(seat, v_period_end)`, and a faithful rewrite of those is a much larger
-- and riskier diff than this one predicate. A rename to f_seat_occupant_effective, with the callers
-- updated, is tracked as follow-up. Until then this comment is the contract.

begin;

-- STABLE / SECURITY DEFINER / search_path are re-declared verbatim from the live definition.
-- CREATE OR REPLACE does NOT carry them over — anything omitted silently reverts to the default,
-- which here would drop SECURITY DEFINER (breaking every caller without direct access to
-- au.occupancy_history) and unset search_path. ACLs, unlike these settings, ARE preserved.
create or replace function au.f_seat_occupant_asof(p_seat_id text, p_asof date)
returns text
language sql
stable
security definer
set search_path to 'au', 'public'
as $function$
  select coalesce(
    -- 1. Today's wiring wins: whoever holds this seat now inherits its history.
    (
      select oh.occupant_hr_id
      from au.occupancy_history oh
      where oh.seat_id = p_seat_id
        and oh.effective_from <= current_date
        and (oh.effective_to is null or oh.effective_to > current_date)
      order by oh.effective_from desc
      limit 1
    ),
    -- 2. Seat vacant today ⇒ the person who actually held it in that period keeps the credit.
    (
      select oh.occupant_hr_id
      from au.occupancy_history oh
      where oh.seat_id = p_seat_id
        and oh.effective_from <= p_asof
        and (oh.effective_to is null or oh.effective_to > p_asof)
      order by oh.effective_from desc
      limit 1
    )
    -- 3. No third arm on purpose. The previous `effective_from asc` fallback returned the earliest
    --    occupant the seat EVER had whenever neither window matched — inventing an owner who never
    --    held the seat in that period. Nobody held it ⇒ NULL, and the sale stays area-level.
  );
$function$;

commit;

notify pgrst, 'reload schema';
