-- Makes the sales_records RLS policies evaluate their access helpers ONCE per statement instead of
-- once per row. No row that was visible before is hidden, and no row that was hidden becomes
-- visible: this is purely about when the same expressions are evaluated.
--
-- WHAT WAS WRONG
-- Every sales_records policy called the access helpers bare:
--
--   current_access_is_super_admin() OR current_access_is_company_reader() OR current_access_is_hr()
--   OR lower(coalesce(employee_hr_id,'')) = lower(coalesce(current_access_hr_id(),''))
--   OR lower(coalesce(manager_hr_id,''))  = lower(coalesce(current_access_hr_id(),''))
--
-- A bare function call in a policy predicate is part of the per-row qual, so Postgres re-runs it for
-- every row scanned. Each of these helpers runs its own `select ... from public.user_access_profiles
-- where auth_user_id = auth.uid()`. Against 11,267 rows that is roughly 56,000 extra subqueries for
-- a single SELECT.
--
-- HOW IT SHOWED UP
-- scripts/phase24-real-auth-rls-api-smoke.ts, run end to end on 2026-08-13, reported
-- "canceling statement due to statement timeout" reading sales_records for all five scoped roles
-- (Employee, Medical Rep, District Manager, Finance Manager, Talent Acquisition). Super Admin and
-- CEO passed only because OR short-circuits on the first disjunct for them; a scoped role falls
-- through all five and pays for every one.
--
-- WHY THE FIX IS SAFE
-- All four helpers are STABLE, take zero arguments, and are SECURITY DEFINER:
--
--   current_access_is_super_admin, current_access_is_company_reader,
--   current_access_is_hr, current_access_hr_id
--
-- Nothing in them depends on the row being tested, so their value cannot vary within one statement.
-- Wrapping each in a scalar subquery lets the planner hoist it into an InitPlan evaluated once. This
-- is the same shape already used by employee_probation_select_access, which reads
-- `( SELECT private.phx_has_company_access() )`. The predicate is otherwise character-for-character
-- unchanged, including the lower(coalesce(...)) comparisons.
--
-- The three write policies get the identical treatment. They are not what timed out, but they carry
-- the same per-row cost on any multi-row UPDATE or DELETE and the transformation is the same.
--
-- ROLLBACK
-- Restore the bare calls, which is the pre-change state:
--
--   alter policy sales_records_select_access on public.sales_records
--   using (
--     current_access_is_super_admin() or current_access_is_company_reader() or current_access_is_hr()
--     or lower(coalesce(employee_hr_id, ''::text)) = lower(coalesce(current_access_hr_id(), ''::text))
--     or lower(coalesce(manager_hr_id, ''::text)) = lower(coalesce(current_access_hr_id(), ''::text))
--   );
--   alter policy sales_records_hr_update on public.sales_records
--   using (current_access_is_super_admin() or current_access_is_hr())
--   with check (current_access_is_super_admin() or current_access_is_hr());
--   alter policy sales_records_hr_delete on public.sales_records
--   using (current_access_is_super_admin() or current_access_is_hr());
--   alter policy sales_records_hr_insert on public.sales_records
--   with check (current_access_is_super_admin() or current_access_is_hr());

-- ── SELECT: the policy that was timing out ───────────────────────────────────
alter policy sales_records_select_access on public.sales_records
using (
  (select public.current_access_is_super_admin())
  or (select public.current_access_is_company_reader())
  or (select public.current_access_is_hr())
  or lower(coalesce(employee_hr_id, ''::text)) = lower(coalesce((select public.current_access_hr_id()), ''::text))
  or lower(coalesce(manager_hr_id, ''::text)) = lower(coalesce((select public.current_access_hr_id()), ''::text))
);

-- ── Write policies: same hoist, same predicate ───────────────────────────────
alter policy sales_records_hr_update on public.sales_records
using (
  (select public.current_access_is_super_admin())
  or (select public.current_access_is_hr())
)
with check (
  (select public.current_access_is_super_admin())
  or (select public.current_access_is_hr())
);

alter policy sales_records_hr_delete on public.sales_records
using (
  (select public.current_access_is_super_admin())
  or (select public.current_access_is_hr())
);

alter policy sales_records_hr_insert on public.sales_records
with check (
  (select public.current_access_is_super_admin())
  or (select public.current_access_is_hr())
);
