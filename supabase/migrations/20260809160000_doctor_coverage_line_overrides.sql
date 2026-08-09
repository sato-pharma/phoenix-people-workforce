-- Doctor Coverage — per-viewer LINE overrides.
--
-- A line-scoped viewer (Product Manager, Group Product Manager, National Sales Manager) is scoped
-- to the single line on their employee record. That is right for most of them and wrong for at
-- least one: owner instruction 2026-08-09, "ahmed sharaf should see pedia and anti infective".
-- Ahmed Sharaf (B-155) is recorded on Pedia only, but manages brands across two lines.
--
-- Changing his employee record would be the wrong fix — his line really is Pedia, and that field
-- feeds payroll, org structure and every other module. So the override lives here, scoped to this
-- board alone, and is editable from the settings page so the next change needs no deploy.
--
-- SHAPE: { "<canonical hr id>": [<line_id>, ...] }, e.g. {"b155": [1, 2]}.
-- The key is the hr id canonicalised the same way access control does (normalizeHrIdForAccess:
-- lowercased, non-alphanumerics stripped), so "B-155", "b-155" and "B155" all resolve to one entry.
-- Line ids as of 2026-08-09: 1 = Anti Infective, 2 = Pedia, 3 = CNS, 4 = Head Office.
--
-- An override only ever REPLACES which lines a line-scoped viewer sees. It cannot widen a
-- team-scoped or self-scoped viewer, and it cannot grant access to someone whose role has none —
-- the role check runs first and is unchanged.
--
-- Safety: additive, idempotent, defaults to '{}' so no viewer's scope changes until seeded.

begin;

alter table public.doctor_coverage_config
  add column if not exists line_overrides jsonb not null default '{}'::jsonb;

-- Seed the one override the owner asked for: Ahmed Sharaf (B-155) covers Anti Infective + Pedia.
update public.doctor_coverage_config
   set line_overrides = coalesce(line_overrides, '{}'::jsonb) || '{"b155": [1, 2]}'::jsonb
 where id;

comment on column public.doctor_coverage_config.line_overrides is
  'Per-viewer line scope for Doctor Coverage: {"<canonical hr id>": [line_id, ...]}. Replaces the line on the employee record for line-scoped roles only; never widens a team/self scope or grants access to a role that has none.';

notify pgrst, 'reload schema';

commit;
