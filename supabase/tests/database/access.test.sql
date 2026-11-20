-- Who the database lets in: pgTAP access tests.
--
-- Runs every Monday inside the throwaway database that the schema restore check has just rebuilt from
-- supabase/schema/production.sql (.github/workflows/schema-restore-check.yml, step "Access tests").
-- `node scripts/db-access-tests.mjs` runs it; it refuses any database that is not on the runner itself.
-- Account: docs/security/schema-restore-check.md, "The access tests".
--
-- WHAT IT ADDS. Every other access check here reads TEXT: the migration files, or the grants and
-- policies as a catalog lists them. This one signs in. It puts made-up people in the database, signs
-- in as each of them the way the browser does (role `authenticated` with a signed-in user id), and
-- counts the salary and employee rows the database actually hands back. A policy that is written
-- correctly but resolves wrongly — a helper that returns the wrong role, a scope that widens — shows
-- up here and nowhere else.
--
-- IT CHANGES NOTHING. One transaction, rolled back at the end: the fixture people, the pgTAP extension
-- and the helper all vanish. The fixture rows are written with session_replication_role = replica, so
-- no trigger fires and no foreign key is asked for (the database is otherwise empty).
--
-- THE MADE-UP PEOPLE. HR ids start "T-" and user ids 00000000-0000-4000-8000-0000000000NN.
--   T-REP1  Medical Rep, reports to T-DM1          T-DM1  District Manager (team of T-REP1, T-LEFT)
--   T-REP2  Medical Rep, reports to T-DM2          T-DM2  District Manager (team of T-REP2)
--   T-LEFT  Medical Rep, RESIGNED, reported to T-DM1
--   T-FIN   Finance Manager    T-CEO  CEO    T-SA  Super Admin    T-HRO  HR Operations
--   ...0099 a signed-in user with no access profile at all
-- Salary rows (salary_records) exist for T-REP1, T-REP2 and T-LEFT; compensation rows
-- (employee_compensation) for T-REP1 and T-REP2.
--
-- WHEN ONE GOES RED. The live production policy changed, or the baseline file no longer matches it.
-- Read which line failed, then decide whether the access change was meant. A meant change updates the
-- expected number here in the same PR as its migration; an unmeant one is a security bug.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public;

select plan(46);

-- ─── The fixture ────────────────────────────────────────────────────────────────────────────────

set local session_replication_role = replica;

insert into public.employees (hr_id, full_name, employment_status, manager_hr_id) values
  ('T-REP1', 'Test Rep One', 'active', 'T-DM1'),
  ('T-REP2', 'Test Rep Two', 'active', 'T-DM2'),
  ('T-LEFT', 'Test Rep Resigned', 'resigned', 'T-DM1'),
  ('T-DM1', 'Test District Manager One', 'active', null),
  ('T-DM2', 'Test District Manager Two', 'active', null),
  ('T-FIN', 'Test Finance Manager', 'active', null),
  ('T-CEO', 'Test Chief Executive', 'active', null),
  ('T-SA', 'Test Super Admin', 'active', null),
  ('T-HRO', 'Test HR Operations', 'active', null);

insert into public.user_access_profiles (auth_user_id, hr_id, role, phoenix_role, manager_hr_id) values
  ('00000000-0000-4000-8000-000000000001', 'T-REP1', 'employee', 'Medical Rep', 'T-DM1'),
  ('00000000-0000-4000-8000-000000000002', 'T-REP2', 'employee', 'Medical Rep', 'T-DM2'),
  ('00000000-0000-4000-8000-000000000003', 'T-LEFT', 'employee', 'Medical Rep', 'T-DM1'),
  ('00000000-0000-4000-8000-000000000011', 'T-DM1', 'employee', 'District Manager', null),
  ('00000000-0000-4000-8000-000000000012', 'T-DM2', 'employee', 'District Manager', null),
  ('00000000-0000-4000-8000-000000000021', 'T-FIN', 'employee', 'Finance Manager', null),
  ('00000000-0000-4000-8000-000000000031', 'T-CEO', 'employee', 'CEO', null),
  ('00000000-0000-4000-8000-000000000041', 'T-SA', 'employee', 'Super Admin', null),
  ('00000000-0000-4000-8000-000000000051', 'T-HRO', 'employee', 'HR Operations', null);

insert into public.salary_records (batch_id, hr_id) values
  ('00000000-0000-4000-9000-000000000001', 'T-REP1'),
  ('00000000-0000-4000-9000-000000000001', 'T-REP2'),
  ('00000000-0000-4000-9000-000000000001', 'T-LEFT');

insert into public.employee_compensation (employee_hr_id) values ('T-REP1'), ('T-REP2');

set local session_replication_role = origin;

-- Signs in as `p_user` the way PostgREST does (role authenticated, the user id in the JWT claims), runs
-- one count, and signs out. A null user is a browser that is signed in to nothing it can match.
create function pg_temp.rows_seen_by(p_user uuid, p_count_sql text) returns bigint
  language plpgsql as $fn$
declare
  seen bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.hr_id', '', true);
  execute 'set local role authenticated';
  execute p_count_sql into seen;
  execute 'reset role';
  return seen;
end;
$fn$;

-- The same as the anonymous browser key: role anon, nobody signed in.
create function pg_temp.run_as_anon(p_sql text) returns void
  language plpgsql as $fn$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  execute p_sql;
  execute 'reset role';
end;
$fn$;

-- The same as rows_seen_by, for a statement that must be refused.
create function pg_temp.run_as(p_user uuid, p_sql text) returns void
  language plpgsql as $fn$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
end;
$fn$;

-- ─── 1. Salaries (salary_records) — who sees which pay row ──────────────────────────────────────

select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 1::bigint,
  'a Medical Rep sees exactly one salary row');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.salary_records where hr_id = 'T-REP1'$$), 1::bigint,
  'a Medical Rep sees their own salary');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.salary_records where hr_id = 'T-REP2'$$), 0::bigint,
  'a Medical Rep cannot see a colleague''s salary');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000003',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 0::bigint,
  'a resigned employee who can still sign in sees no salary, their own included');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000011',
  $$select count(*) from public.salary_records where hr_id = 'T-REP1'$$), 1::bigint,
  'a District Manager sees the salary of someone on their team');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000011',
  $$select count(*) from public.salary_records where hr_id = 'T-REP2'$$), 0::bigint,
  'a District Manager cannot see the salary of another manager''s rep');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000011',
  $$select count(*) from public.salary_records where hr_id = 'T-LEFT'$$), 0::bigint,
  'a District Manager cannot see a resigned team member''s salary');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000012',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 1::bigint,
  'the other District Manager sees only their own rep''s salary');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000051',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 0::bigint,
  'HR Operations signed in through the browser sees no salary rows');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000099',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 0::bigint,
  'a signed-in user with no access profile sees no salary rows');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000021',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 3::bigint,
  'the Finance Manager sees every salary row');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000031',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 3::bigint,
  'the CEO sees every salary row');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000041',
  $$select count(*) from public.salary_records where hr_id like 'T-%'$$), 3::bigint,
  'the Super Admin sees every salary row');

-- ─── 2. Compensation (employee_compensation) ────────────────────────────────────────────────────

select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.employee_compensation where employee_hr_id like 'T-%'$$), 1::bigint,
  'a Medical Rep sees only their own compensation');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.employee_compensation where employee_hr_id = 'T-REP2'$$), 0::bigint,
  'a Medical Rep cannot see a colleague''s compensation');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000011',
  $$select count(*) from public.employee_compensation where employee_hr_id like 'T-%'$$), 1::bigint,
  'a District Manager sees only their own team''s compensation');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000051',
  $$select count(*) from public.employee_compensation where employee_hr_id like 'T-%'$$), 0::bigint,
  'HR Operations signed in through the browser sees no compensation');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000021',
  $$select count(*) from public.employee_compensation where employee_hr_id like 'T-%'$$), 2::bigint,
  'the Finance Manager sees all compensation');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000031',
  $$select count(*) from public.employee_compensation where employee_hr_id like 'T-%'$$), 2::bigint,
  'the CEO sees all compensation');

-- ─── 3. Employee records (employees) and access profiles (user_access_profiles) ─────────────────

select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.employees where hr_id like 'T-%'$$), 1::bigint,
  'a Medical Rep sees only their own employee record');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000011',
  $$select count(*) from public.employees where hr_id like 'T-%'$$), 2::bigint,
  'a District Manager sees their own record and their active team, not the resigned one');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000021',
  $$select count(*) from public.employees where hr_id like 'T-%'$$), 1::bigint,
  'the Finance Manager sees only their own employee record');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000031',
  $$select count(*) from public.employees where hr_id like 'T-%'$$), 9::bigint,
  'the CEO sees every employee record');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from public.user_access_profiles where hr_id like 'T-%'$$), 1::bigint,
  'a Medical Rep sees only their own access profile');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000031',
  $$select count(*) from public.user_access_profiles where hr_id like 'T-%'$$), 1::bigint,
  'the CEO sees only their own access profile');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000041',
  $$select count(*) from public.user_access_profiles where hr_id like 'T-%'$$), 9::bigint,
  'the Super Admin sees every access profile');

-- ─── 4. The role helpers every policy calls ─────────────────────────────────────────────────────
-- private.phx_current_role() is the role NAME (from phoenix_role); public.current_access_role() is the
-- short access code (employee, manager, finance, company_reader, super_admin) from the profile's role.

select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from (select 1 where private.phx_current_role() = 'Medical Rep') x$$), 1::bigint,
  'a Medical Rep resolves to the Medical Rep role');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from (select 1 where public.current_access_can_manage_payroll()) x$$), 0::bigint,
  'a Medical Rep cannot manage payroll');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000001',
  $$select count(*) from (select 1 where public.current_access_can_manage_employees()) x$$), 0::bigint,
  'a Medical Rep cannot manage employees');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000021',
  $$select count(*) from (select 1 where public.current_access_can_manage_payroll()) x$$), 1::bigint,
  'the Finance Manager can manage payroll');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000021',
  $$select count(*) from (select 1 where public.current_access_can_manage_employees()) x$$), 0::bigint,
  'the Finance Manager cannot manage employees');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000031',
  $$select count(*) from (select 1 where public.current_access_is_super_admin()) x$$), 0::bigint,
  'the CEO is not a Super Admin');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000041',
  $$select count(*) from (select 1 where public.current_access_is_super_admin()) x$$), 1::bigint,
  'the Super Admin is a Super Admin');
select is(pg_temp.rows_seen_by('00000000-0000-4000-8000-000000000099',
  $$select count(*) from (select 1 where private.phx_current_role() = 'Employee' and public.current_access_role() = 'employee') x$$), 1::bigint,
  'a signed-in user with no access profile falls back to the plain Employee role');

-- ─── 5. Writes from the browser are refused, even for the Super Admin ───────────────────────────

select throws_ok(
  $$select pg_temp.run_as('00000000-0000-4000-8000-000000000041', 'insert into public.salary_records (batch_id, hr_id) values (''00000000-0000-4000-9000-000000000002'', ''T-SA'')')$$,
  '42501'::char(5), null::text, 'the browser cannot add a salary row, even signed in as the Super Admin');
select throws_ok(
  $$select pg_temp.run_as('00000000-0000-4000-8000-000000000041', 'update public.employee_compensation set payment_mode = payment_mode')$$,
  '42501'::char(5), null::text, 'the browser cannot change compensation, even signed in as the Super Admin');
select throws_ok(
  $$select pg_temp.run_as('00000000-0000-4000-8000-000000000041', 'delete from public.employees where hr_id = ''T-REP1''')$$,
  '42501'::char(5), null::text, 'the browser cannot delete an employee, even signed in as the Super Admin');

-- ─── 6. The anonymous browser key reads nothing ─────────────────────────────────────────────────

select throws_ok($$select pg_temp.run_as_anon('select count(*) from public.salary_records')$$,
  '42501'::char(5), null::text, 'the anonymous key cannot read salaries');
select throws_ok($$select pg_temp.run_as_anon('select count(*) from public.employees')$$,
  '42501'::char(5), null::text, 'the anonymous key cannot read employee records');
select throws_ok($$select pg_temp.run_as_anon('select count(*) from public.v_employee_portal_payslips')$$,
  '42501'::char(5), null::text, 'the anonymous key cannot read the payslip view');

-- ─── 7. Whole-database rules (asked of the permission engine itself, not of the grant text) ─────

select is_empty($$
  select n.nspname || '.' || c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private', 'recovery', 'internal', 'analytics', 'au')
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))
$$, 'the anonymous key holds no privilege on any table or view');

select is_empty($$
  select n.nspname || '.' || c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private', 'recovery', 'internal', 'analytics', 'au')
    and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
      or has_table_privilege('authenticated', c.oid, 'DELETE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))
$$, 'a signed-in browser can write to no table or view');

select is_empty($$
  select c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and has_table_privilege('authenticated', c.oid, 'SELECT') and not c.relrowsecurity
$$, 'every table a signed-in browser can read has row-level security switched on');

select is_empty($$
  select n.nspname
  from pg_namespace n
  where n.nspname in ('private', 'recovery', 'internal', 'analytics', 'au')
    and has_schema_privilege('anon', n.oid, 'USAGE')
$$, 'the anonymous key cannot reach any schema but public');

select is_empty($$
  select n.nspname || '.' || p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private', 'recovery', 'internal', 'analytics', 'au')
    and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')
$$, 'every function that runs with its owner''s rights pins its search_path');

select set_eq($$
  select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'EXECUTE')
$$, array[
  'current_access_can_manage_employees()',
  'current_access_can_manage_payroll()',
  'current_access_can_see_employee(text,text)',
  'current_access_hr_id()',
  'current_access_is_company_reader()',
  'current_access_is_finance()',
  'current_access_is_hr()',
  'current_access_is_super_admin()',
  'current_access_role()',
  'current_access_scope()',
  'current_phoenix_role()'
], 'a signed-in browser may call only the eleven role helpers among the owner-rights functions');

select * from finish();

rollback;
