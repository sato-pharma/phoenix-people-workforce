-- Finance Team is `Finance Manager` by role, plus Adel El Sayed (OF-0002) by name.
--
-- `Financial Advisor` was seeded alongside Finance Manager in 20260911120000. It is a live
-- PhoenixRole but NOBODY HOLDS IT — 0 active app_auth_users rows — so it added no recipient and
-- made the list read on screen as though it addressed an audience that does not exist.
--
-- MEMBERSHIP IS UNCHANGED BY CONSTRUCTION. A role nobody holds contributes nobody, so removing it
-- cannot drop anyone: the list resolved to B-185 + OF-0002 before and resolves to B-185 + OF-0002
-- after. Verified against production on 2026-09-11.
--
-- Why OF-0002 stays a NAMED member rather than being given the role: his job title is "Financial
-- Advisor" but his app role is Employee, and that is not a defect. `Financial Advisor` grants
-- strictly LESS than Employee — no outstation, expenses, payroll, sales, coaching or probation
-- access, and leave without update — so "correcting" the role to match the title would remove his
-- ability to submit an outstation request. A role is a bundle of functions, never a restatement of
-- a job title.
--
-- Applied to production 2026-09-11; this file exists so a rebuilt environment reaches the same
-- state instead of re-seeding the empty role, and so the repo and production ledgers agree.
--
-- Guarded on the role still being present, so a re-run cannot overwrite a later edit.
begin;

update public.distribution_lists
set roles = array['Finance Manager']::text[],
    updated_at = now(),
    updated_by = 'migration:finance_team_roles'
where list_key = 'finance_team'
  and roles @> array['Financial Advisor']::text[];

commit;
