-- WHAT. One new table, `hiring_pack_forms_layout`: the papers each HR Forms package (new hire,
-- leaver) walks through, in order — one row per package.
--
-- WHY. Owner, 2026-11-27: "create a tab in HR Forms where I can rearrange the forms that appear,
-- remove a form, add a form I want to appear — move it from another paper to new hire, or from new
-- hire to another paper." Until now the order was compiled in `src/lib/hiring-pack/hr-forms-wizard.ts`;
-- the Control tab stores it here instead. "Another paper" is every paper on neither list, so it needs
-- no row of its own.
--
-- ONE ROW PER PACKAGE, so a save writes exactly the package it names and "put back the standard order"
-- is deleting the row (no row = the compiled order). `steps` is deliberately NOT pinned to a list of
-- paper keys: `forms-layout-store.ts` cleans every row through `cleanPackageSteps` on read and the
-- route cleans it again before writing, so an unknown key is inert; pinning it in SQL would mean a
-- migration every time a paper is added to the system.
--
-- ROLLBACK. Purely additive — no existing row is touched. Dropping the table returns HR Forms to the
-- compiled order, which `forms-layout-store.ts` already falls back to when the table is missing. It
-- discards the arrangement, so read it first:
--
--   select package_key, steps, updated_at, updated_by_hr_id from public.hiring_pack_forms_layout;
--
--   begin;
--     drop table if exists public.hiring_pack_forms_layout;
--   commit;

begin;

create table if not exists public.hiring_pack_forms_layout (
  -- The package whose papers this row orders. "Another paper" is derived, never stored.
  package_key text primary key,
  -- The papers in order: built-in paper keys, plus `exitForm` (the resignation request and the mutual
  -- termination agreement as ONE step) on the leaver list. An empty array is a package with no papers.
  steps text[] not null default '{}'::text[],
  updated_at timestamptz not null default now(),
  -- Who arranged it, in the stored (upper) form every actor column here uses; not constrained, so
  -- hrIdForStorage's raw fallback can never turn a save into a 500.
  updated_by_hr_id text,
  constraint hiring_pack_forms_layout_package_known check (package_key in ('newHire', 'leaver'))
);

comment on table public.hiring_pack_forms_layout is
  'The HR Forms Control tab: the papers the new-hire and leaver packages walk through, in order, one row per package. No row = the compiled order in src/lib/hiring-pack/hr-forms-wizard.ts. Another paper = every paper on neither list. Written by the Super Admin only (app/api/hiring-pack/forms-layout).';

comment on column public.hiring_pack_forms_layout.steps is
  'Paper keys in walking order; exitForm stands for the two exit forms as one step. Cleaned by cleanPackageSteps on every read and write — an unknown key is dropped, never trusted.';

-- RLS on with no browser grants, matching the rest of this schema: every read and write goes through
-- the service-role client behind the route's own checks.
alter table public.hiring_pack_forms_layout enable row level security;
revoke all on table public.hiring_pack_forms_layout from anon, authenticated;
grant select, insert, update, delete on table public.hiring_pack_forms_layout to service_role;

commit;
