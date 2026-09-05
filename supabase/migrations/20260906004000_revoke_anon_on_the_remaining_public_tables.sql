-- Take the `anon` role off the 15 public tables that still granted it full CRUD.
--
-- Scope note up front: this revokes `anon` ONLY. `authenticated` is deliberately untouched --
-- see "WHY authenticated IS NOT TOUCHED" below. That is not an oversight or a half-measure.
--
-- BACKGROUND. While labelling and then dropping the empty legacy sales-target tables (#3315,
-- #3317, #3321) it turned out those two sat in a group of 17 public tables where `anon` held
-- DELETE and TRUNCATE. Dropping the two left 15. Measured on production 2026-09-06: of 326
-- public tables, `anon` could SELECT on 21 and DELETE/TRUNCATE on these 15.
--
-- THIS CHANGES NOTHING OBSERVABLE. Every one of the 15 already denies `anon` at the RLS layer,
-- by one of three mechanisms, all verified against pg_policy on production:
--
--   (a) 7 payroll tables -- payroll_copilot_adjustments, payroll_copilot_flags,
--       payroll_copilot_runs, payroll_copilot_vacation_settlements,
--       payroll_copilot_expense_decisions, payroll_recurring_adjustments,
--       payroll_statutory_config -- carry 4 policies each, and every one of them targets
--       `authenticated`, gated on current_access_can_manage_employees(). There is no `anon`
--       policy, so RLS yields `anon` nothing.
--
--   (b) 6 tables -- ats_candidate_cv_extractions, ats_cv_intake_events,
--       ats_email_intake_cursors, notification_role_policies, payroll_resignation_candidates,
--       push_subscriptions -- carry a single `service_role` policy, same shape as the two
--       tables already retired.
--
--   (c) source_of_sales_customer_map has RLS enabled and ZERO policies (so nothing reaches it
--       except a BYPASSRLS role), and report_it_dashboard_access carries a `deny_all` policy
--       (using: false) applying to PUBLIC, which includes `anon` explicitly.
--
-- WHY THE GRANT STILL MATTERED. RLS is the only thing standing between `anon` and these rows.
-- Turning RLS off on any one of them -- a one-line change someone could make while debugging --
-- would have immediately exposed the grant underneath: SELECT, INSERT, UPDATE, DELETE and
-- TRUNCATE, on payroll adjustments, CV extractions, and a 67,203-row customer map. Removing the
-- grant means RLS is no longer load-bearing on its own for the `anon` role.
--
-- WHY `authenticated` IS NOT TOUCHED. On group (a) it is genuinely load-bearing: those 28
-- policies exist precisely so an authenticated admin session can act, and revoking the grant
-- would silently disable a designed access path over real payroll data while every policy still
-- read as present and correct. Groups (b) and (c) would be safe, but mixing a safe revoke and an
-- unsafe one into a single sweep is how the unsafe half gets waved through -- so `authenticated`
-- is left for a separate, per-table decision.
--
-- NO CLIENT-SIDE EXPOSURE PATH EXISTS EITHER. There is no browser Supabase client in this
-- repository. NEXT_PUBLIC_SUPABASE_ANON_KEY is referenced in exactly three places, all
-- server-side: getSupabaseUserClient() (whose callers immediately hydrate a session onto it via
-- .auth.setSession, making it an `authenticated` client), getSupabaseAuthBridgeClient() (used
-- only for .auth.signInWithPassword, never for table reads), and an env-presence check in
-- app/api/readyz. Confirmed: anon and authenticated both have rolbypassrls = false, while
-- service_role and postgres have it true -- which is how the app reads source_of_sales_customer_map
-- at all despite that table having no policies.
--
-- Reversible by re-granting. Idempotent: revoking an absent privilege is a no-op.

revoke all on table public.ats_candidate_cv_extractions      from anon;
revoke all on table public.ats_cv_intake_events              from anon;
revoke all on table public.ats_email_intake_cursors          from anon;
revoke all on table public.notification_role_policies        from anon;
revoke all on table public.payroll_copilot_adjustments       from anon;
revoke all on table public.payroll_copilot_expense_decisions from anon;
revoke all on table public.payroll_copilot_flags             from anon;
revoke all on table public.payroll_copilot_runs              from anon;
revoke all on table public.payroll_copilot_vacation_settlements from anon;
revoke all on table public.payroll_recurring_adjustments     from anon;
revoke all on table public.payroll_resignation_candidates    from anon;
revoke all on table public.payroll_statutory_config          from anon;
revoke all on table public.push_subscriptions                from anon;
revoke all on table public.report_it_dashboard_access        from anon;
revoke all on table public.source_of_sales_customer_map      from anon;

-- Prove the intent held, and that nothing else moved. Fails the migration if either is false.
do $$
declare
  v_anon_left int;
  v_authed_payroll int;
begin
  select count(*) into v_anon_left
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and has_table_privilege('anon', c.oid, 'DELETE');

  if v_anon_left <> 0 then
    raise exception 'expected 0 public tables leaving anon with DELETE, found %', v_anon_left;
  end if;

  -- authenticated must STILL hold its grant on the payroll copilot tables
  select count(*) into v_authed_payroll
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relname in ('payroll_copilot_adjustments','payroll_copilot_flags','payroll_copilot_runs',
                      'payroll_copilot_vacation_settlements','payroll_copilot_expense_decisions',
                      'payroll_recurring_adjustments','payroll_statutory_config')
    and has_table_privilege('authenticated', c.oid, 'SELECT');

  if v_authed_payroll <> 7 then
    raise exception 'authenticated must retain SELECT on all 7 payroll tables, found %', v_authed_payroll;
  end if;
end $$;
