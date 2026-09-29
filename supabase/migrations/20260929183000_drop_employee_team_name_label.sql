-- ---------------------------------------------------------------------------
-- The fourth and last denormalized label on public.employees: team_name.
--
-- Measured on production 2026-09-29, across all 198 employees:
--
--     team_name   0 populated        team_id   152 populated
--
-- The deadest of the four. Nothing has ever written it: 0 of 107 active employees carried one when
-- the organogram's Team column was found blank for everybody on 2026-09-09 (105 had a real link),
-- and 0 of 198 carry one now. Every surface that showed a team therefore showed an empty one, while
-- the team assigned correctly in the data model was unreadable in the one module you would look in.
--
-- WHAT DEPENDS ON IT: nothing.
--   * pg_depend reports 0 entries for this column — with public.employees.hr_id (99 entries) as the
--     positive control in the same query, so the empty result means empty rather than broken.
--   * No view selects it (team_id is referenced by v_active_organogram and
--     v_payroll_eligible_employees; the label is not).
--   * 🔴 A FUNCTION BODY IS INVISIBLE TO pg_depend, SO THE BODIES WERE SEARCHED AS TEXT AS WELL.
--     One matched — public.fn_get_employee_directory_paginated — and it is a FALSE POSITIVE worth
--     recording: it emits `t.name as team_name` from `left join public.teams t on t.id = fe.team_id`.
--     It reads the LINK and only names the label as an output alias. Anchor such a search to the
--     table, never to the bare column name.
--
-- ORDER: the app stopped naming the column first, and that shipped and was confirmed serving before
-- this ran. PostgREST answers a missing column with an ERROR and fails the WHOLE read, and this is
-- the exact select that proved it hours earlier — `reports/organogram-au-source.ts` named
-- `department_name` in the same 16-column list and took every occupant's name off the chart.
-- ---------------------------------------------------------------------------

-- 🔴 GUARDED, BECAUSE A PRE-IMAGE READS THE COLUMN THE MIGRATION IS ABOUT TO DROP. The `drop column`
-- below carries IF EXISTS, but `select ... team_name` does not and cannot: a missing column is a
-- parse-time 42703, so this file fails outright on any database that lacks it. That is not
-- hypothetical — applying this file to STAGING on 2026-09-29 errored with `column "team_name" does
-- not exist`, because staging's employees has line_name and team_id but none of the other three, and
-- replaying it against production after the drop errors identically.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'employees' and column_name = 'team_name'
  ) then
    execute $sql$
      create table if not exists public.employees_team_label_preimage_20260929 as
      select hr_id, full_name, team_id, team_name
      from public.employees
    $sql$;
  end if;
end $$;

alter table public.employees drop column if exists team_name;
