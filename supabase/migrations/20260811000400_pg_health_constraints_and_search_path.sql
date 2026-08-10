-- Schema integrity, from the 2026-08-10 production Postgres health audit.
--
-- 1. Validate three CHECK constraints that were created NOT VALID and never validated.
--    A NOT VALID constraint polices new rows only; existing rows were never verified
--    against it, so the guarantee the schema appears to make is not actually held.
--    Counted first on production: 0 violating rows out of 109 coaching_reports and
--    0 of 0 field_workforce_compliance_decisions, so validation cannot fail here.
--
--    realtime.messages_payload_exclusive is deliberately NOT touched: it belongs to
--    Supabase's managed realtime schema, and we do not own its lifecycle.
--
-- 2. Pin search_path on the functions the security advisor flagged as role-mutable.
--
--    DELIBERATE EXCEPTION - public.phx_fold_customer_name keeps its mutable search_path.
--    A SQL function carrying a SET clause can no longer be inlined by the planner, and
--    that function is now evaluated once per customer row inside the closing classifier
--    (72,914 times on a single CNS call). It is IMMUTABLE, SECURITY INVOKER, and
--    executable by neither anon nor authenticated, so a mutable search_path buys an
--    attacker nothing here while pinning it would measurably slow the money path.
--    phx_resolve_directory_pharmacy IS pinned - it is the one SECURITY DEFINER of the set.

-- ── 1. validate what the schema already claims ──────────────────────────────────
alter table public.coaching_reports
  validate constraint coaching_reports_zone_check;
alter table public.field_workforce_compliance_decisions
  validate constraint field_workforce_decisions_source_check;
alter table public.field_workforce_compliance_decisions
  validate constraint field_workforce_decisions_status_check;

-- ── 2. pin search_path where it costs nothing ───────────────────────────────────
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'phx_resolve_directory_pharmacy',   -- SECURITY DEFINER: the one that matters
        'phx_contract_note',
        'early_birds_candidates_guard_frozen'
      )
      and p.proconfig is null                -- only those with no SET clause yet
  loop
    execute format('alter function %s set search_path = public, pg_temp', r.sig);
  end loop;
end $$;
