-- The owner's own arrangement of his own sidebar.
--
-- WHY. Modules Control was retired (#2505) because it solved a problem nobody had: it was a
-- TARGETING matrix — target_type in ('user','role','position','line') — deciding what OTHER people
-- see, and it could only reorder or disable whole modules by module_id. The actual ask, verbatim
-- 2026-08-28: "I don't mean in anyone account. I mean in my own account", and "move everything
-- anywhere". One target, finer granularity: any PAGE into any module, or up into the utility strip.
--
-- So this table is deliberately the opposite shape. There is no target_type, no role column, no
-- position or line. One row per person, holding that person's own arrangement, and the only person
-- who can read or write a row is that person.
--
-- NOT A PERMISSION STORE. The layout rearranges the set of links a viewer was ALREADY gated into
-- by getSections; applyPersonalLayout can only emit hrefs present in that input, so a layout can
-- never grant access to anything (see src/lib/navigation/personal-layout.ts, and the registered
-- test tests/navigation-personal-layout.test.ts which pins that invariant). Navigation was never
-- the security boundary in this app — assertPermission in the route handler is — and this does not
-- make it one. A row here is cosmetic: worst case, a corrupted layout shows the wrong menu order.
--
-- SAFE IN BOTH DIRECTIONS, so the deploy order does not matter. The reader treats a missing table
-- exactly like a missing row (see loadPersonalLayout), and a missing row means "no layout saved",
-- which renders the code-defined sidebar unchanged. Shipping the code before this migration
-- degrades to today's behaviour rather than to an error.

create table if not exists public.nav_personal_layout (
  -- Lowercased hr_id. Stored already-normalised and CHECKed rather than merely normalised in the
  -- app, because hr_id casing is genuinely inconsistent in this database: activity_events.hr_id is
  -- mixed case, and the direct-order tables carry both spellings — a plain .eq() on the raw value
  -- once hid 28% of reps' own orders. A row that can only exist in one casing cannot repeat that.
  hr_id      text primary key,
  -- The whole PersonalNavigationLayout as one document: {version, strip[], sections[], hidden[]}.
  -- Deliberately one jsonb rather than a row-per-item table. There is exactly one writer (the owner
  -- saving his own arrangement) and it always writes the arrangement whole, so rows-per-item would
  -- buy nothing and add a partial-write failure mode: half a saved layout is a broken sidebar,
  -- while half a saved document cannot exist.
  layout     jsonb not null,
  updated_at timestamptz not null default now(),
  constraint nav_personal_layout_hr_id_lowercase check (hr_id = lower(hr_id)),
  -- Cheap structural floor. The app validates the full shape with isPersonalNavigationLayout before
  -- rendering; this only guarantees the column holds an object with a version, so a malformed write
  -- fails at the database rather than becoming a render-time surprise.
  constraint nav_personal_layout_is_object check (jsonb_typeof(layout) = 'object'),
  constraint nav_personal_layout_has_version check (layout ? 'version')
);

alter table public.nav_personal_layout enable row level security;

-- Application-scoped visibility, service_role only at the database — the same pattern as every
-- other table here. Nothing in the browser reads this directly; the API route resolves the caller's
-- own hr_id server-side and never accepts one from the request body.
drop policy if exists phx_nav_personal_layout_service_role on public.nav_personal_layout;
create policy phx_nav_personal_layout_service_role
  on public.nav_personal_layout
  for all
  to service_role
  using (true)
  with check (true);

grant select, insert, update, delete on public.nav_personal_layout to service_role;

comment on table public.nav_personal_layout is
  'One person''s own sidebar arrangement. Cosmetic only: the layout reorders links the viewer was already permitted to see and can never introduce one (see applyPersonalLayout). Deliberately NOT the retired sidebar_module_assignments, which targeted other users by role/position/line.';

comment on column public.nav_personal_layout.hr_id is
  'Lowercased hr_id of the person this layout belongs to, CHECK-enforced. Always lower() the value before querying — hr_id casing is inconsistent across this database.';

comment on column public.nav_personal_layout.layout is
  'PersonalNavigationLayout document: {version, strip[], sections[], hidden[]}. hrefs only, no permissions. An unrecognised version is ignored by the reader, which falls back to the code-defined sidebar rather than rendering a layout it cannot interpret.';
