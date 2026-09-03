-- Attendance deduction rules: let an eighth of a day actually be an eighth of a day.
--
-- `attendance_policy_rules.deduction_days` is numeric(8,2). The "Deduct eighth day"
-- bracket therefore had to be stored as 0.13 rather than 0.125 — scale 2 cannot hold
-- a third decimal, and an UPDATE to 0.125 silently rounds straight back to 0.13.
--
-- That rounding is not cosmetic. The flexible-hours engine HALVES a late penalty when
-- the required hours were still completed, so the stored 0.13 produces a deduction of
-- 0.065 of a day where an eighth halved is 0.0625. Every late-but-made-up day on the
-- 13 policies carrying this bracket is charged slightly more than the rule intends,
-- and the employee-facing policy card has to print "0.065 day" because that is the
-- honest number.
--
-- Widening to numeric(8,4) is additive: every existing value keeps its exact meaning
-- (0.25 -> 0.2500), no row changes size class, and the only writer of this column
-- (the Attendance Policies admin screen) already round-trips it as a plain number.
--
-- Direction of the change: it makes deductions very slightly SMALLER, never larger.

alter table public.attendance_policy_rules
  alter column deduction_days type numeric(8,4);

-- Only the eighth-day bracket is touched, and only where it is still the rounded
-- value. Scoped by recommended_action as well as the number so a policy that
-- deliberately uses 0.13 for some other reason is left alone.
update public.attendance_policy_rules
   set deduction_days = 0.1250,
       updated_at = now()
 where deduction_days = 0.13
   and recommended_action = 'Deduct eighth day';

-- Guard: the widening is what makes the update stick. If the column were still
-- scale 2 the update above would be a silent no-op, so fail loudly instead.
do $$
declare
  remaining integer;
begin
  select count(*) into remaining
    from public.attendance_policy_rules
   where deduction_days = 0.13
     and recommended_action = 'Deduct eighth day';

  if remaining > 0 then
    raise exception
      'attendance_policy_rules still has % eighth-day rows at 0.13 — the numeric scale did not widen',
      remaining;
  end if;
end
$$;
