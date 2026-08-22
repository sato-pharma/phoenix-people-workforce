-- ─────────────────────────────────────────────────────────────────────────────
-- Area consolidation ledger — merging a legacy area into the one it actually means.
--
-- The owner's instruction (2026-08-22), in plain words: "I want you to shift any bulk from them.
-- I want me to be able to, in the system itself, I check if confirmed, I press the button, and it
-- goes. I don't want you to do any of this critical sensitive work."
--
-- That is the whole design brief. Repointing employees, teams and customers from one area to
-- another is bulk work on live org data, and it must not happen because an agent decided to run an
-- UPDATE. It happens because the Super Admin looked at a named, itemized list on screen and pressed
-- a button. These two tables are what make that safe.
--
-- WHY A LEDGER AND NOT JUST AN UPDATE.
--
--   1. REVERT. A consolidation touches many rows across many tables. Undo is only possible if the
--      system recorded each row's PREVIOUS area, one row at a time. `area_consolidation_moves` is
--      that record — it is not a log, it is the undo buffer, and reverting reads it back.
--   2. PROOF. `audit_logs` records that a consolidation happened. This records exactly WHAT moved,
--      so the owner can answer "which employees changed area last Tuesday" without guessing.
--   3. IDEMPOTENCE. The partial unique index below makes a second live consolidation of the same
--      source area impossible at the database level, so a double-click cannot double-move.
--
-- WHY `public.areas` IS NEVER TOUCHED HERE. Consolidating moves the ROWS that point at an area; it
-- does not delete, rename or deactivate the area itself. Areas are never deleted in this
-- repository — see AGENTS.md and the SoS rules. A consolidated source area simply ends up with
-- nothing pointing at it, which is reversible; a deleted one would not be.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.area_consolidations (
  id uuid primary key default gen_random_uuid(),

  -- The legacy area being emptied, and the current area its rows belong to.
  source_area_id bigint not null
    references public.areas (id) on delete restrict,
  target_area_id bigint not null
    references public.areas (id) on delete restrict,

  -- Denormalized on purpose. `areas` rows can be renamed; the ledger must keep saying what the
  -- owner actually saw on screen at the moment he pressed the button.
  source_area_code text not null,
  source_area_name text not null,
  target_area_code text not null,
  target_area_name text not null,

  status text not null default 'applied'
    check (status = any (array['applied'::text, 'reverted'::text])),

  -- A per-table count snapshot, e.g. {"employees": 3, "teams": 1}. Cheap to read for a summary
  -- without walking every move row.
  moved_counts jsonb not null default '{}'::jsonb,

  applied_by_hr_id text not null,
  applied_at timestamptz not null default now(),
  apply_notes text,

  reverted_by_hr_id text,
  reverted_at timestamptz,
  revert_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- An area cannot be consolidated into itself; that would be a no-op that still looks like an
  -- event in the ledger.
  constraint area_consolidation_source_is_not_target check (source_area_id <> target_area_id),

  -- A reverted row must name who reverted it and when. Without this, a half-written revert leaves
  -- a row that claims to be undone by nobody.
  constraint area_consolidation_revert_complete check (
    (status = 'applied' and reverted_by_hr_id is null and reverted_at is null)
    or
    (status = 'reverted' and reverted_by_hr_id is not null and reverted_at is not null)
  )
);

-- One live consolidation per source area. A second press while the first is still applied is
-- refused by the database, not merely by the route handler.
create unique index if not exists area_consolidation_one_live_per_source
  on public.area_consolidations (source_area_id)
  where status = 'applied';

create index if not exists area_consolidation_target_idx
  on public.area_consolidations (target_area_id);

create index if not exists area_consolidation_applied_at_idx
  on public.area_consolidations (applied_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- The undo buffer. One row per row moved.
--
-- `row_pk` is text because the tables that point at an area do not agree on a key type: `employees`
-- is keyed by `hr_id` (text), `teams` / `positions` / `employee_history` / `position_vacancies` by
-- bigint, and `marketing_customers` / `marketing_pharmacies` / `marketing_requests` /
-- `coaching_reports` by uuid. Storing the key as text keeps one ledger instead of nine, and revert
-- casts back per table.
--
-- `previous_area_id` is nullable because `area_id` is nullable on every one of those tables except
-- `teams` — a row that was moved from NULL must be restorable to NULL, not to zero.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.area_consolidation_moves (
  id uuid primary key default gen_random_uuid(),

  consolidation_id uuid not null
    references public.area_consolidations (id) on delete cascade,

  table_name text not null,
  row_pk text not null,
  previous_area_id bigint,

  created_at timestamptz not null default now(),

  -- The same row cannot be recorded twice inside one consolidation. Without this, a retried apply
  -- could write a second move row whose `previous_area_id` is the NEW area — which would make
  -- revert restore the row to where it already is, silently losing the original value.
  constraint area_consolidation_move_unique unique (consolidation_id, table_name, row_pk)
);

create index if not exists area_consolidation_move_consolidation_idx
  on public.area_consolidation_moves (consolidation_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Housekeeping, matching the conventions used by the rest of this schema.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_area_consolidation_updated_at()
returns trigger
language plpgsql
parallel safe
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_area_consolidation_updated_at on public.area_consolidations;
create trigger trg_area_consolidation_updated_at
  before update on public.area_consolidations
  for each row execute function public.set_area_consolidation_updated_at();

-- Service-role only. Nothing in the browser reads or writes these directly; the API routes do,
-- behind a Super-Admin-only gate.
alter table public.area_consolidations enable row level security;
alter table public.area_consolidation_moves enable row level security;

revoke all on public.area_consolidations from anon, authenticated;
revoke all on public.area_consolidation_moves from anon, authenticated;

comment on table public.area_consolidations is
  'Ledger of legacy-area merges performed by the Super Admin from the Area Consolidation screen. Never written by an agent or a background job.';
comment on table public.area_consolidation_moves is
  'Undo buffer for public.area_consolidations: one row per moved row, carrying its previous area_id so a revert restores the exact prior state.';
