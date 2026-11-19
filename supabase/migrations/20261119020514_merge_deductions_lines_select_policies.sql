-- merge_deductions_lines_select_policies
--
-- WHAT THIS CHANGES: on each of the two deductions line tables, the two permissive
--   SELECT policies for `authenticated` become ONE policy whose USING clause is the
--   two old clauses joined by OR:
--     public.daily_deductions_lines:
--       daily_deductions_lines_admin_select + daily_deductions_lines_self_read
--         -> daily_deductions_lines_read
--     public.deductions_publication_lines:
--       deductions_publication_lines_admin_select + deductions_publication_lines_self_read
--         -> deductions_publication_lines_read
--   The insert, update and delete policies on both tables are not touched.
-- WHY: the Supabase performance advisor (multiple_permissive_policies, WARN) flags
--   both tables, because Postgres runs every permissive policy for the same role
--   and action on every row it reads. Permissive policies already combine with OR,
--   so one policy holding `admin OR self` lets exactly the same rows through: the
--   Super Admin still reads every line, and an employee still reads only their own
--   lines under a published snapshot (active lines only, and for the daily table
--   only a snapshot that is not superseded). Nobody gains or loses a row.
-- ROLLBACK: drop the two *_read policies and re-create the four originals exactly:
--   create policy daily_deductions_lines_admin_select on public.daily_deductions_lines
--     for select to authenticated using (public.current_access_can_manage_employees());
--   create policy daily_deductions_lines_self_read on public.daily_deductions_lines
--     for select to authenticated using (
--       private.phx_can_access_employee(employee_hr_id)
--       and exists (select 1 from public.daily_deductions_publications p
--                   where p.id = daily_deductions_lines.publication_id
--                     and p.status = 'published' and p.superseded_at is null));
--   create policy deductions_publication_lines_admin_select on public.deductions_publication_lines
--     for select to authenticated using (public.current_access_can_manage_employees());
--   create policy deductions_publication_lines_self_read on public.deductions_publication_lines
--     for select to authenticated using (
--       private.phx_can_access_employee(employee_hr_id)
--       and deductions_publication_lines.line_status = 'active'
--       and exists (select 1 from public.deductions_publications p
--                   where p.id = deductions_publication_lines.publication_id
--                     and p.status = 'published'));
--   (origins: 20260725130500_deductions_module_publish.sql,
--    20260922091615_deductions_self_read_active_lines_only.sql,
--    20260922103738_daily_deductions_module.sql)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Not destructive or bulk: it replaces four SELECT policies with two and touches no data rows.

begin;

-- daily_deductions_lines ------------------------------------------------------

drop policy if exists daily_deductions_lines_admin_select on public.daily_deductions_lines;
drop policy if exists daily_deductions_lines_self_read on public.daily_deductions_lines;
drop policy if exists daily_deductions_lines_read on public.daily_deductions_lines;
create policy daily_deductions_lines_read
  on public.daily_deductions_lines for select to authenticated
  using (
    public.current_access_can_manage_employees()
    or (
      private.phx_can_access_employee(employee_hr_id)
      and exists (
        select 1 from public.daily_deductions_publications p
        where p.id = daily_deductions_lines.publication_id
          and p.status = 'published'
          and p.superseded_at is null
      )
    )
  );

-- deductions_publication_lines ------------------------------------------------

drop policy if exists deductions_publication_lines_admin_select on public.deductions_publication_lines;
drop policy if exists deductions_publication_lines_self_read on public.deductions_publication_lines;
drop policy if exists deductions_publication_lines_read on public.deductions_publication_lines;
create policy deductions_publication_lines_read
  on public.deductions_publication_lines for select to authenticated
  using (
    public.current_access_can_manage_employees()
    or (
      private.phx_can_access_employee(employee_hr_id)
      and deductions_publication_lines.line_status = 'active'
      and exists (
        select 1 from public.deductions_publications p
        where p.id = deductions_publication_lines.publication_id
          and p.status = 'published'
      )
    )
  );

-- Guard: each table ends with exactly one SELECT policy, still has its insert,
-- update and delete policies where it had them, and keeps RLS on.
do $$
declare
  t text;
  n int;
begin
  foreach t in array array['daily_deductions_lines', 'deductions_publication_lines'] loop
    select count(*) into n from pg_policies
      where schemaname = 'public' and tablename = t and cmd = 'SELECT';
    if n <> 1 then
      raise exception '% has % SELECT policies after the merge, expected 1', t, n;
    end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'RLS is off on %', t;
    end if;
  end loop;
  select count(*) into n from pg_policies
    where schemaname = 'public' and tablename = 'daily_deductions_lines'
      and policyname in ('daily_deductions_lines_admin_insert',
                         'daily_deductions_lines_admin_update',
                         'daily_deductions_lines_admin_delete');
  if n <> 3 then
    raise exception 'daily_deductions_lines lost a write policy: % of 3 remain', n;
  end if;
end $$;

commit;
