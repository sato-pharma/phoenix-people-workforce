-- Each reader's candidate-pool column layouts, saved to their account (owner, 2026-10-19 —
-- "Columns follow you").
--
-- WHY. The pool's columns are the WhatsApp bot's questions, and a reader chooses which show and in
-- what order, per view ("all", or one role family). That choice lived in one browser's storage, so a
-- layout set up at a desk was missing on the phone. One row per person, holding every view.
--
-- COSMETIC ONLY. A layout names column keys; the pool shows only columns that exist for the view
-- (applyPoolColumnLayout drops anything else), so a row here can never reveal a candidate, an answer
-- or a question the reader could not already see. The route gates it on candidates:read.
--
-- SAFE IN BOTH DIRECTIONS. The reader treats a missing table exactly like a missing row
-- (loadPoolColumnLayouts), and a missing row means "nothing saved", so the code may ship first.

create table if not exists public.ats_pool_column_layouts (
  -- Lowercased hr_id (or login id for an account without one), CHECK-enforced: hr_id casing is
  -- inconsistent in this database, and a row that can only exist in one casing cannot be missed.
  hr_id      text primary key,
  -- { "<view>": ["<column key>", ...], ... } — the app validates the full shape
  -- (isPoolColumnLayouts) before every write; this only guarantees an object.
  layouts    jsonb not null,
  updated_at timestamptz not null default now(),
  constraint ats_pool_column_layouts_hr_id_lowercase check (hr_id = lower(hr_id)),
  constraint ats_pool_column_layouts_is_object check (jsonb_typeof(layouts) = 'object')
);

alter table public.ats_pool_column_layouts enable row level security;

-- Application-scoped visibility, service_role only at the database — nothing in the browser reads
-- this directly; the API route resolves the caller's own key from the session.
drop policy if exists phx_ats_pool_column_layouts_service_role on public.ats_pool_column_layouts;
create policy phx_ats_pool_column_layouts_service_role
  on public.ats_pool_column_layouts
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.ats_pool_column_layouts from anon, authenticated;
grant select, insert, update, delete on public.ats_pool_column_layouts to service_role;

comment on table public.ats_pool_column_layouts is
  'One reader''s own candidate-pool column layouts, every view in one document. Cosmetic only: names column keys, never data.';
