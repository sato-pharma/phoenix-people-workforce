-- expense_claims: the SELECT policy its predecessors already had, then the grant (2026-08-12)
--
-- THE INCIDENT THIS CLOSES. PHOENIX_EXPENSE_CLAIMS_READ was set to "true" in production at about
-- 17:10 UTC on 2026-08-12. /api/admin/outstation/expenses returned 500 for roughly three and a half
-- hours until the flag was set back to "false". The cause, once the route was made to record its own
-- error:
--
--     {"code":"42501","message":"permission denied for table expense_claims",
--      "hint":"Grant the required privileges to the current role with:
--              GRANT SELECT ON public.expense_claims TO authenticated;"}
--
-- listExpenseClaims uses getSupabaseRlsClientIfAvailable, so with a real user session the query runs
-- as `authenticated`, not service_role. The read switch was turned on before the table it reads had
-- the permissions its predecessors have.
--
-- WHY NOT JUST RUN THE HINT. Because the hint is half the job and the dangerous half. Before this
-- migration expense_claims carried RLS with exactly ONE policy — service_role, `using (true)` —
-- while outstation_expenses and outstation_expense_requests carry five each. A bare
-- `grant select ... to authenticated` with no matching SELECT policy either denies everything (RLS
-- with no permissive policy denies by default) or, if a permissive policy were ever added carelessly,
-- exposes all 375 claims to every logged-in user. The grant is therefore the LAST statement here,
-- after the policy that makes it safe.
--
-- SELECT ONLY, DELIBERATELY. Phase 2 switched READS. Writes still go to the legacy tables — phase 3
-- part 2 has not happened — so `authenticated` gets no insert, update or delete here. Granting write
-- access to a table nothing writes to through RLS would be widening for nothing.

begin;

-- 1) The helper functions the legacy policies are built from must exist before anything depends on
--    them. They are all already used by live policies on the two legacy tables; this fails loudly
--    rather than creating a policy that silently evaluates to NULL (i.e. denies) if one is missing.
do $$
declare
  missing text;
begin
  select string_agg(fn, ', ')
    into missing
  from (
    select unnest(array[
      'phx_can_manage_payroll',
      'phx_can_manage_outstation',
      'phx_has_company_access',
      'phx_current_hr_id',
      'phx_visible_hr_ids',
      'phx_resigned_hr_ids'
    ]) as fn
  ) f
  where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = f.fn
  );

  if missing is not null then
    raise exception 'missing private helper function(s): % — the legacy expense policies are built on these', missing;
  end if;
end $$;

-- 2) The SELECT policy.
--
--    expense_claims replaces the UNION of two tables whose SELECT policies used DIFFERENT manage
--    predicates: outstation_expenses answered to private.phx_can_manage_payroll(), and
--    outstation_expense_requests to private.phx_can_manage_outstation(). Collapsing both into
--    "either predicate" would be a widening — an outstation manager would gain sight of rows only
--    payroll could see before.
--
--    So the policy stays source-aware, using the provenance columns the backfill already records.
--    On production today: 336 rows carry legacy_expense_id, 15 carry legacy_request_id, 24 carry
--    both (the same trip present in both legacy tables, which is exactly the pair the old union
--    deduplicated), and NONE carry neither. A row with both was visible through either table, so
--    either predicate granting it is not a widening — it is the same answer the union gave.
--
--    The employee branch is copied unchanged from both legacy policies, which are identical to each
--    other apart from the HR-ID column name (`hr_id` there, `employee_hr_id` here). Note the final
--    resigned-employee exclusion: a manager who would otherwise see a person's expenses must not see
--    them once that person has resigned. That clause is easy to drop by accident and it is the one
--    with a privacy consequence.
--
--    The `(select fn())` wrapping is copied from the live policies too. It is not noise: it makes
--    Postgres evaluate each helper ONCE per query instead of once per row.
drop policy if exists expense_claims_select_access on public.expense_claims;

create policy expense_claims_select_access
  on public.expense_claims
  for select
  to authenticated
  using (
    (select private.phx_has_company_access())
    -- Came from outstation_expenses → whoever managed payroll could see it.
    or (legacy_expense_id is not null and (select private.phx_can_manage_payroll()))
    -- Came from outstation_expense_requests → whoever managed outstation could see it.
    or (legacy_request_id is not null and (select private.phx_can_manage_outstation()))
    -- Raised in the new model with no legacy row behind it. None exist today, but the table accepts
    -- them, and both desks work the one approvals queue this feeds — which is also exactly what
    -- assertOutstationExpenseApprovalReviewAccess allows at the application layer.
    or (
      legacy_expense_id is null
      and legacy_request_id is null
      and ((select private.phx_can_manage_payroll()) or (select private.phx_can_manage_outstation()))
    )
    -- Your own, or someone in your hierarchy — but never a resigned employee's.
    or (
      (
        lower(coalesce(employee_hr_id, ''::text)) = (select lower(coalesce(private.phx_current_hr_id(), ''::text)))
        or lower(coalesce(employee_hr_id, ''::text)) in (select private.phx_visible_hr_ids())
      )
      and not (lower(coalesce(employee_hr_id, ''::text)) in (select private.phx_resigned_hr_ids()))
    )
  );

-- 3) RLS must actually be enforced, or the policy above is decoration. It is already on; this is the
--    assertion, not a change.
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.expense_claims'::regclass) then
    raise exception 'RLS is OFF on public.expense_claims — the policy would not be enforced';
  end if;
end $$;

-- 4) Only now the grant. Ordering matters for readability more than for atomicity (this is one
--    transaction), but a reader should never find a grant in this file ahead of the policy that
--    makes it safe.
grant select on public.expense_claims to authenticated;

-- 5) Prove the end state rather than assume it.
do $$
declare
  v_policies int;
  v_auth_select boolean;
  v_auth_write boolean;
begin
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename = 'expense_claims' and policyname = 'expense_claims_select_access';
  if v_policies <> 1 then
    raise exception 'expected exactly one expense_claims_select_access policy, found %', v_policies;
  end if;

  select has_table_privilege('authenticated', 'public.expense_claims', 'select') into v_auth_select;
  if not v_auth_select then
    raise exception 'authenticated still cannot select from expense_claims — the grant did not take';
  end if;

  -- The read switch is a READ switch. If this ever trips, someone widened the migration.
  select has_table_privilege('authenticated', 'public.expense_claims', 'insert')
      or has_table_privilege('authenticated', 'public.expense_claims', 'update')
      or has_table_privilege('authenticated', 'public.expense_claims', 'delete')
    into v_auth_write;
  if v_auth_write then
    raise exception 'authenticated has WRITE access to expense_claims — this migration grants SELECT only';
  end if;

  raise notice 'expense_claims: select policy in place, authenticated may read and may not write';
end $$;

commit;
