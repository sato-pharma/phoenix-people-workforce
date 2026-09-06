-- Drop public.users -- the legacy homegrown authentication table -- and retire the eight dead RLS
-- policy disjuncts that reference it.
--
-- SAFE: empty, never written, nothing points at it, and no code reads it. Guarded by a fail-closed
-- precondition and dropped WITHOUT cascade. See the CASCADE section below -- that choice is the
-- whole reason this migration touches RLS at all.
--
-- This completes work begun on 2026-09-06: public.user_roles was dropped in PR #3364
-- (20260906193000). public.users was deliberately deferred because it needs the policy rewrite
-- below, which is a change to a security boundary on two LIVE tables and wanted its own decision.
-- Owner approved that rewrite (option A) on 2026-09-06.
--
-- WHAT IT IS. Created by 20260509030000_legacy_access_tables_branch_baseline.sql (now under
-- supabase/_migrations_archive/pre-baseline-2026-07-11/) with phoenix-rbac-access-control.sql.
-- It carries `username` and `password_hash` -- a homegrown authentication table -- plus `line`,
-- `manager_hr_id` and `sales_scope_override`, a homegrown sales-scope model. Superseded and unused.
--
-- WHAT REPLACED IT, measured on production (ozucdzovmcqvepbozvqf) 2026-09-06:
--   auth.users .............. 167 rows   the real authentication table
--   public.employees ........ 185 rows   the real people table
--   the role model .......... permissionMatrix[role] in TypeScript, not a database table
--
-- MEASURED BEFORE WRITING THIS, against pg_class / pg_stat / pg_constraint / pg_depend:
--   rows ............................ 0
--   n_tup_ins / n_tup_upd / n_tup_del  0 / 0 / 0   never written, ever
--   seq scans ....................... 342  every one returning zero
--   inbound foreign keys ............ 4    (was 6; user_roles supplied two and is now gone)
--   RLS policies referencing it ..... 8
--   application code references ..... 0    (positive control: the same search finds
--                                           employee_documents in 29 files, so the zero is real)
--
-- THE FOUR INBOUND FOREIGN KEYS. Every one of these columns is entirely NULL -- not one row in this
-- database references a user:
--   employee_documents.uploaded_by_user_id ...   0 non-null
--   employee_history.changed_by_user_id ......   0 non-null
--   platform_settings.updated_by_user_id .....   0 non-null
--   system_audit_logs.actor_user_id ..........   0 non-null  (1 row, a stale 2026-06 rollout marker
--                                                naming a vercel.app host; Vercel is decommissioned)
-- This migration drops the four constraints and KEEPS the columns: they are all-NULL and harmless,
-- and employee_documents is a LIVE feature (29 code files), so narrowing to the constraint keeps
-- this change off that table's data entirely. Dropping the now-plain uuid columns is a separate
-- decision, deliberately not taken here.
--
-- WHY `drop table` WITHOUT CASCADE, AND WHY THIS MIGRATION TOUCHES RLS. A first attempt on staging
-- failed with:
--
--   ERROR: 2BP01: cannot drop table users because other objects depend on it
--   DETAIL: policy emp_docs_delete_own on table employee_documents depends on table users
--           ... eight policies in total
--   HINT:  Use DROP ... CASCADE to drop the dependent objects too.
--
-- EIGHT RLS POLICIES on two LIVE tables reference public.users, and no catalogue sweep of views,
-- functions, triggers or foreign keys finds them -- policy expressions are a separate dependency
-- surface (pg_policy.polqual / polwithcheck). Following that HINT would have deleted all eight
-- SILENTLY, stripping row-level security from employee_documents. Never cascade here: the error is
-- the control working. Full account in docs/agents-session-traps.md, hook in AGENTS.md 2.1.
--
-- Every one of the eight has the same shape:
--     (<owner_column> = auth.uid())
--     OR (employee_hr_id = (select u.hr_id from users u where u.id = auth.uid()))
--
-- THE SECOND DISJUNCT IS ALREADY DEAD: public.users is empty, so the scalar subquery returns NULL,
-- `employee_hr_id = NULL` evaluates to NULL, and a NULL policy expression does not grant. It has
-- never granted anything and never could. This migration REWRITES the eight to keep the first
-- disjunct and drop only the dead half -- semantics preserved exactly, not changed.
--
-- AND THE WHOLE SET IS UNREACHABLE ANYWAY, which is what makes this safe rather than delicate:
-- `authenticated` holds NO privilege of any kind on employee_documents or employee_history --
-- measured; only service_role does. An RLS policy targeting a role that cannot touch the table
-- grants nothing by construction. Both tables are served through their own phx_*_service_role
-- policy, which this migration does not touch.
--
-- So the rewrite is observably neutral twice over. It is a rewrite rather than a plain drop so the
-- original intent -- "you may reach a row you uploaded" -- survives, should `authenticated` ever be
-- granted access to these tables in future.
--
-- REVERSIBILITY. Production has NO point-in-time recovery -- 7 daily physical backups, granularity
-- one day, restore unit the whole database. The table is EMPTY, so nothing can be lost, and its full
-- definition (columns, PK, unique email, three FKs to employees, four indexes, RLS, and the
-- phx_users_service_role / users_select_own / users_update_own policies) is preserved verbatim in
-- the tracked baseline supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql --
-- search it for `users`. Referenced rather than duplicated so there is one authoritative copy that
-- cannot drift. To restore the eight policies to their original form, re-add the second disjunct:
--   or (employee_hr_id = (select u.hr_id from users u where u.id = (select auth.uid())))

-- Fail closed. A DROP takes no WHERE clause, so this block is the precondition. It refuses if the
-- table has acquired a row; if any child FK column has acquired a non-null value, because dropping
-- the constraint would then silently orphan a real reference; and if anything OTHER than the eight
-- policies rewritten below has come to depend on public.users. pg_depend is used deliberately --
-- it sees every dependency surface at once, including the policy expressions a per-surface sweep
-- misses.
do $$
declare
  v_rows bigint;
  v_orphaning text;
  v_unexpected text;
begin
  if to_regclass('public.users') is null then
    raise notice 'public.users already absent - nothing to do';
    return;
  end if;

  select count(*) into v_rows from public.users;

  if v_rows <> 0 then
    raise exception
      'REFUSING TO DROP: public.users has % row(s); expected 0. Someone started using this table - investigate before dropping.',
      v_rows;
  end if;

  select string_agg(format('%s.%s has %s non-null value(s)', t.tbl, t.col, t.n), '; ')
    into v_orphaning
  from (
    select 'employee_documents' as tbl, 'uploaded_by_user_id' as col,
           (select count(uploaded_by_user_id) from public.employee_documents) as n
    union all
    select 'employee_history', 'changed_by_user_id',
           (select count(changed_by_user_id) from public.employee_history)
    union all
    select 'platform_settings', 'updated_by_user_id',
           (select count(updated_by_user_id) from public.platform_settings)
    union all
    select 'system_audit_logs', 'actor_user_id',
           (select count(actor_user_id) from public.system_audit_logs)
  ) t
  where t.n <> 0;

  if v_orphaning is not null then
    raise exception
      'REFUSING TO DROP: a child column now references a user, so dropping its foreign key would orphan real data -- %. Investigate before dropping.',
      v_orphaning;
  end if;

  select string_agg(n.nspname || '.' || c.relname || '.' || pol.polname, ', ' order by pol.polname)
    into v_unexpected
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~* '\musers\M'
      or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* '\musers\M')
    and not (n.nspname = 'public' and c.relname = 'users')
    and pol.polname not in (
      'emp_docs_select_own', 'emp_docs_insert_own', 'emp_docs_update_own', 'emp_docs_delete_own',
      'emp_hist_select_own', 'emp_hist_insert_own', 'emp_hist_update_own', 'emp_hist_delete_own');

  if v_unexpected is not null then
    raise exception
      'REFUSING TO DROP: unrecognised policies depend on public.users and would be destroyed -- %. Review them before dropping.',
      v_unexpected;
  end if;
end $$;

-- Release the four external references. The COLUMNS are deliberately kept.
alter table public.employee_documents drop constraint if exists employee_documents_uploaded_by_user_id_fkey;
alter table public.employee_history   drop constraint if exists employee_history_changed_by_user_id_fkey;
alter table public.platform_settings  drop constraint if exists platform_settings_updated_by_user_id_fkey;
alter table public.system_audit_logs  drop constraint if exists system_audit_logs_actor_user_id_fkey;

-- Rewrite the eight dependent policies WITHOUT the dead public.users disjunct. The surviving
-- expression is the half that could ever have granted; the removed half returned NULL against an
-- empty table. Role, command and using/with-check placement are preserved exactly.
drop policy if exists emp_docs_select_own on public.employee_documents;
create policy emp_docs_select_own on public.employee_documents
  for select to authenticated
  using (uploaded_by_user_id = (select auth.uid()));

drop policy if exists emp_docs_insert_own on public.employee_documents;
create policy emp_docs_insert_own on public.employee_documents
  for insert to authenticated
  with check (uploaded_by_user_id = (select auth.uid()));

drop policy if exists emp_docs_update_own on public.employee_documents;
create policy emp_docs_update_own on public.employee_documents
  for update to authenticated
  using (uploaded_by_user_id = (select auth.uid()))
  with check (uploaded_by_user_id = (select auth.uid()));

drop policy if exists emp_docs_delete_own on public.employee_documents;
create policy emp_docs_delete_own on public.employee_documents
  for delete to authenticated
  using (uploaded_by_user_id = (select auth.uid()));

drop policy if exists emp_hist_select_own on public.employee_history;
create policy emp_hist_select_own on public.employee_history
  for select to authenticated
  using (changed_by_user_id = (select auth.uid()));

drop policy if exists emp_hist_insert_own on public.employee_history;
create policy emp_hist_insert_own on public.employee_history
  for insert to authenticated
  with check (changed_by_user_id = (select auth.uid()));

drop policy if exists emp_hist_update_own on public.employee_history;
create policy emp_hist_update_own on public.employee_history
  for update to authenticated
  using (changed_by_user_id = (select auth.uid()))
  with check (changed_by_user_id = (select auth.uid()));

drop policy if exists emp_hist_delete_own on public.employee_history;
create policy emp_hist_delete_own on public.employee_history
  for delete to authenticated
  using (changed_by_user_id = (select auth.uid()));

-- No cascade: an unknown dependency must fail loudly, not disappear quietly.
drop table if exists public.users;
