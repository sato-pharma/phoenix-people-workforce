-- public.sensitive_data_access_audit is INERT. Label it, and narrow the grants it should never
-- have had.
--
-- MEASURED ON PRODUCTION (ozucdzovmcqvepbozvqf) 2026-09-06, against pg_class / pg_proc / pg_trigger
-- rather than the migration ledger:
--
--   rows in public.sensitive_data_access_audit ........ 0
--   n_tup_ins (tuples ever inserted) ................. 0      pg_stat, never reset
--   identity sequence is_called ...................... false  last_value 1
--   seq_scan (times it has been READ) ................ 192    every one returning zero
--   functions whose body references the table ........ 1      private.log_sensitive_data_access
--   triggers referencing it .......................... 0
--
-- The sequence is the load-bearing proof: is_called = false means nextval has never been drawn, so
-- no row was ever written -- not even one later deleted. It also survives a stats reset, which
-- n_tup_ins does not.
--
-- WHY IT IS EMPTY, AND WHY THAT IS NOT "NOTHING CAN WRITE IT". There IS a live write path, and it
-- is not a trigger -- Postgres has no SELECT trigger, so this control was never built as one. The
-- writer is wired into a VIEW: public.v_employee_locations_masked calls
-- private.log_sensitive_data_access_event() in its WHERE clause, once per row returned. Selecting
-- that view IS the audit.
--
-- Nothing selects that view. There are zero application references to it; the only mentions in the
-- repository are two test files that assert on the SQL SOURCE TEXT, never on behaviour
-- (tests/rls-gap-closure.test.ts, tests/scripts/phoenix-production-rls-gap-closure.ts). Meanwhile
-- nine application files read the base table public.employee_locations (144 rows) DIRECTLY through
-- the service-role client, which is how most of this app reads (AGENTS.md 8: visibility here is
-- application-scoped, not RLS-scoped). The masked view is bypassed, so the audit is bypassed.
--
-- Scope is exactly one table. v_employee_locations_masked is the ONLY view in the entire database
-- that calls the writer, so this is a one-of-one control, not a half-finished rollout.
--
-- THE CONTROL WORKS -- it is untravelled, not broken. Verified on STAGING (cifwmndunmlxjhyjugxa)
-- on 2026-09-06, deliberately not on production, because writing a row there would have destroyed
-- the very evidence recorded above. Calling the writer directly returned true and wrote a correct
-- row; the probe row was then deleted and the sequence reset, and staging reads 0 rows /
-- is_called false / last_value 1 exactly as before. Also measured there: selecting the view as a
-- caller with no auth context returned 0 of 136 rows and logged nothing, because
-- private.phx_can_access_employee() returned false and the AND short-circuited. So this control
-- could only ever have recorded SUCCESSFUL reads, never denied attempts.
--
-- WHY A COMMENT AND NOT A WIRE-UP OR A DROP. An empty audit table is indistinguishable from a clean
-- audit trail: anyone asking "who has been reading salary or residence data?" gets zero rows and a
-- confident, authoritative, WRONG "nobody". That false signal is the defect -- not the empty table.
-- A table COMMENT shows in \d+, in the Supabase table editor and in every schema browser, so it
-- reaches the reader at the moment they are looking at the wrong thing. Same remedy and the same
-- reasoning as 20260905233500 for public.sales_targets.
--
-- Put to the owner on 2026-09-06 as wire / retire / label, with the cost of each. He chose label,
-- and asked for the grant narrowing in the same change. NOTE WHAT LABELLING LEAVES OPEN, since it
-- is a policy question and not an oversight: public.audit_logs (14,560 rows in the last 7 days)
-- records ACTIONS and WRITES, not READS. Nobody can currently answer who read employee residence
-- data. The comment makes that gap visible instead of disguising it as a clean audit trail.
--
-- THE GRANT HALF. The file that created this table (supabase/20260511_rls_gap_closure.sql) granted
-- only `select, insert` to authenticated. Production had drifted wider -- authenticated held
-- SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER and TRUNCATE, and so did service_role. RLS
-- denies DELETE (there is no delete policy among the three), but ROW-LEVEL SECURITY DOES NOT APPLY
-- TO TRUNCATE AT ALL, and there is no BEFORE TRUNCATE guard. This migration removes update, delete
-- and truncate from both roles and keeps INSERT, so it stays compatible with wiring the control up
-- later. anon already held nothing; the revoke below is explicit so a future blanket grant cannot
-- quietly re-open it.
--
-- WHAT THIS DOES NOT ACHIEVE, stated plainly. A revoke NARROWS reachable privilege; it does not
-- make the table append-only. Per AGENTS.md 2.1, a revoke never binds the table OWNER, and TRUNCATE
-- fires no ROW triggers -- a genuine append-only guarantee needs a STATEMENT-level BEFORE TRUNCATE
-- trigger, which is deliberately NOT added here because the owner chose to label this control
-- rather than invest in it. That trigger remains an available follow-up, not an oversight. The
-- surplus privilege was never reachable from the browser in any case: PostgREST exposes no TRUNCATE
-- verb, so it would have taken a direct Postgres connection as one of those roles.
--
-- REVERSIBILITY. Fully reversible, and destroys nothing:
--   comment on table public.sensitive_data_access_audit is null;
--   comment on view public.v_employee_locations_masked is null;
--   comment on function private.log_sensitive_data_access(text, text, text, text) is null;
--   comment on function private.log_sensitive_data_access_event(text, text, text, text) is null;
--   grant update, delete, truncate on table public.sensitive_data_access_audit
--     to authenticated, service_role;

-- Fail closed. Every claim in the comments below is a measurement, so refuse the whole migration if
-- reality has moved: if the table has gained a row, or the sequence has been drawn, then something
-- now writes this audit and the comment would be a lie. The existence checks are here so a missing
-- object reports itself clearly instead of failing on a bare COMMENT.
do $$
declare
  v_rows bigint;
  v_seq_called boolean;
begin
  if to_regclass('public.sensitive_data_access_audit') is null then
    raise exception 'REFUSING: public.sensitive_data_access_audit does not exist.';
  end if;

  if to_regclass('public.v_employee_locations_masked') is null then
    raise exception 'REFUSING: public.v_employee_locations_masked does not exist - the documented write path is gone.';
  end if;

  if to_regprocedure('private.log_sensitive_data_access(text,text,text,text)') is null
     or to_regprocedure('private.log_sensitive_data_access_event(text,text,text,text)') is null then
    raise exception 'REFUSING: the private.log_sensitive_data_access* writer functions are missing.';
  end if;

  select count(*) into v_rows from public.sensitive_data_access_audit;
  select is_called into v_seq_called from public.sensitive_data_access_audit_id_seq;

  if v_rows <> 0 or v_seq_called then
    raise exception
      'REFUSING: sensitive_data_access_audit holds % row(s) and its sequence is_called=%; expected 0 and false. Something now WRITES this audit, so the "inert" comments would be false. Re-measure before labelling.',
      v_rows, v_seq_called;
  end if;
end $$;

comment on table public.sensitive_data_access_audit is
  'INERT -- 0 rows, ever, and the identity sequence has never been called. THIS TABLE IS NOT '
  'EVIDENCE THAT NOBODY HAS READ SENSITIVE DATA; it is evidence that its write path is never '
  'travelled. That path is public.v_employee_locations_masked, whose WHERE clause calls '
  'private.log_sensitive_data_access_event() per row -- and no application code selects that view. '
  'Nine files read public.employee_locations directly through the service-role client instead. The '
  'writer is functional (verified on staging 2026-09-06), just unused. Do NOT answer "who read '
  'employee data?" from this table: public.audit_logs records actions and writes, not reads, so '
  'that question currently has no source. Owner decision 2026-09-06: label, do not wire or drop.';

comment on view public.v_employee_locations_masked is
  'THE WRITE PATH FOR public.sensitive_data_access_audit -- selecting this view inserts one audit '
  'row per row returned, via private.log_sensitive_data_access_event() in its WHERE clause. NOTHING '
  'SELECTS IT: application code reads public.employee_locations directly, so the audit table has '
  'stayed empty since 2026-05. Two things to know before using it. (1) It WRITES on SELECT, so a '
  'read inside a read-only transaction will error, and a full scan costs one audit row per row '
  'returned. (2) The audit call sits behind private.phx_can_access_employee() in an AND and '
  'short-circuits, so only SUCCESSFUL reads are ever logged -- a denied read records nothing.';

comment on function private.log_sensitive_data_access(text, text, text, text) is
  'Writes public.sensitive_data_access_audit. Functional but untravelled -- the table has never '
  'received a row. Its only caller is private.log_sensitive_data_access_event().';

comment on function private.log_sensitive_data_access_event(text, text, text, text) is
  'Boolean wrapper over private.log_sensitive_data_access(), shaped to be called from a view WHERE '
  'clause. Its only caller is public.v_employee_locations_masked, which no application code '
  'selects. Always returns true; it is used for its side effect.';

-- Narrow the grants to what an audit table should carry. INSERT is kept on purpose so the control
-- stays wireable. Kept on one line so no line begins with a destructive keyword.
revoke update, delete, truncate on table public.sensitive_data_access_audit from authenticated, service_role;

-- anon already holds nothing here; explicit so a future blanket grant cannot silently re-open it.
revoke all on table public.sensitive_data_access_audit from anon;
