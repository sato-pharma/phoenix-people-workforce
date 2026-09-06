-- Drop public.user_roles -- the legacy RBAC join table. Nothing depends on it.
--
-- SAFE: empty, never written, and pg_depend reports ZERO dependent objects. Guarded by a fail-closed
-- precondition below and dropped without cascade.
--
-- WHAT IT IS. Created by 20260509030000_legacy_access_tables_branch_baseline.sql (now under
-- supabase/_migrations_archive/pre-baseline-2026-07-11/) as the join table of a homegrown RBAC
-- model: user_id, role_id, assigned_by_user_id, assigned_at. That model was superseded. The live
-- role model is permissionMatrix[role] in TypeScript, not a database join table.
--
-- MEASURED ON PRODUCTION (ozucdzovmcqvepbozvqf) 2026-09-06, against pg_class / pg_stat / pg_depend:
--   rows ............................ 0
--   n_tup_ins / n_tup_upd / n_tup_del  0 / 0 / 0   never written, ever
--   seq scans ....................... 46   every one returning zero
--   inbound foreign keys ............ 0    nothing points at it
--   dependent objects in pg_depend .. 0    nothing at all depends on it
--   application code references ..... 0    (positive control: the same search finds
--                                           employee_documents in 29 files, so the zero is real)
--
-- HOW THE DEPENDENCY CHECK WAS DONE, because the obvious method is not sufficient. Enumerating
-- views, functions, triggers and foreign keys MISSES RLS POLICIES -- policy expressions are a
-- separate dependency surface (pg_policy.polqual / polwithcheck). That gap was found the hard way
-- on 2026-09-06: an attempt to drop public.users in this same session failed on staging with
--
--   ERROR: 2BP01: cannot drop table users because other objects depend on it
--   DETAIL: policy emp_docs_delete_own on table employee_documents depends on table users ...
--
-- EIGHT policies on two LIVE tables reference public.users, and none of the per-surface queries had
-- found them. Had that migration said `cascade` -- the form Postgres itself suggests in its hint --
-- all eight would have been deleted SILENTLY, stripping row-level security from employee_documents,
-- a live feature with 29 code files. So this migration asks pg_depend instead, which sees every
-- surface at once, and it verifies the query with a POSITIVE CONTROL: run against public.users the
-- same query returns 6 constraints and 8 policies, so the empty result for user_roles is a real
-- zero and not a broken query.
--
-- PUBLIC.USERS IS DELIBERATELY NOT DROPPED HERE. It is equally dead (0 rows, never written, 342 seq
-- scans, carries a legacy `password_hash` column), but dropping it also requires rewriting those
-- eight policies -- a change to a security boundary on two live tables. That was put to the owner
-- and deferred on 2026-09-06; it is a separate decision and belongs in its own migration.
--
-- ONE SIDE EFFECT WORTH KNOWING: this removes the ONLY foreign key into public.roles. public.roles
-- keeps its 18 seeded rows and is not touched.
--
-- REVERSIBILITY. Production has NO point-in-time recovery -- 7 daily physical backups, granularity
-- one day, restore unit the whole database. The table is EMPTY, so nothing can be lost, and its
-- full definition (columns, primary key, three foreign keys, two indexes, RLS and the
-- phx_user_roles_service_role policy) is preserved verbatim in the tracked baseline migration
-- supabase/migrations/20260711135352_phoenix_production_schema_baseline.sql -- search it for
-- `user_roles`. Restoring means replaying that definition; it is not reproduced here so that there
-- is exactly one authoritative copy rather than two that can drift.

-- Fail closed. A DROP takes no WHERE clause, so this block is the precondition: refuse if the table
-- has acquired a row, or if anything has come to depend on it since this was written.
do $$
declare
  v_rows bigint;
  v_deps text;
begin
  if to_regclass('public.user_roles') is null then
    raise notice 'public.user_roles already absent - nothing to do';
    return;
  end if;

  select count(*) into v_rows from public.user_roles;

  if v_rows <> 0 then
    raise exception
      'REFUSING TO DROP: public.user_roles has % row(s); expected 0. Someone started using this table - investigate before dropping.',
      v_rows;
  end if;

  select string_agg(d.classid::regclass::text || ' oid ' || d.objid::text, ', ')
    into v_deps
  from pg_depend d
  where d.refobjid = 'public.user_roles'::regclass
    and d.deptype not in ('i', 'a')
    and not (d.classid = 'pg_class'::regclass and d.objid = 'public.user_roles'::regclass);

  if v_deps is not null then
    raise exception
      'REFUSING TO DROP: something now depends on public.user_roles and would be destroyed -- %. Review before dropping.',
      v_deps;
  end if;
end $$;

-- No cascade: an unknown dependency must fail loudly, not disappear quietly.
drop table if exists public.user_roles;
