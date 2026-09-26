-- milestone_notice_marks — give the latch a PRIMARY KEY
--
-- WHAT THIS CHANGES: one constraint, on one table. The unique constraint
-- `milestone_notice_marks_unique (seen_by_hr_id, derived_on, subject_hr_id, period_spec)` becomes the
-- PRIMARY KEY over the same four columns, in the same order. No column is added, dropped or retyped;
-- no row is read or written.
--
-- WHY: the nightly `Migration Drift Check` has been RED since this table shipped on 2026-09-23, on
-- BOTH projects, and this is the whole of it on staging:
--
--   [schema-shape] ERROR missing_primary_key: 1 table(s) have no primary key: milestone_notice_marks.
--
-- The migration history itself was green on both — "every migration outside the grace window is
-- accounted for" — which is exactly the gap `check:schema-shape` exists to close: a table can be
-- applied everywhere and still be the wrong shape. `scripts/check-schema-shape.ts` names the cost it
-- is guarding against: a table with no primary key silently blocks any later migration that adds a
-- foreign key REFERENCING it, which is how the 2026-07-11 fault surfaced.
--
-- WHY THE KEY IS THESE FOUR COLUMNS AND NOT A NEW `id`: the table already declares this exact tuple
-- as its identity, all four columns `not null`, and the original migration
-- (20260923212006_milestone_card_prints_and_notice_marks.sql) spends a whole header on why identity is
-- `derived_on` — the arithmetic's date — rather than the typed `milestone_on`: keying on the typed
-- date would let one keystroke mint a second occasion and restart the reminder for somebody already
-- congratulated. Adding a surrogate `id` would add a second notion of identity beside that one. A
-- primary key is a unique constraint plus `not null`, and the `not null`s are already there, so this
-- is the same guarantee under the name the tooling reads.
--
-- WHY IT IS A DROP-THEN-ADD AND NOT `add primary key using index`: Postgres refuses
-- `ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY USING INDEX` when the index is already owned by a
-- constraint ("index is already associated with a constraint"), and this index is owned by
-- `milestone_notice_marks_unique`. Both statements run inside one transaction, so the table is never
-- without a uniqueness guarantee at any point another session could observe.
--
-- NOTHING IN THE APP CHANGES. `src/lib/milestones/ledger.ts` upserts with
-- `onConflict: "seen_by_hr_id,derived_on,subject_hr_id,period_spec"` — PostgREST resolves that to any
-- unique index over those columns, and a primary key is one. It names columns, never the constraint,
-- so the rename cannot reach it. The covering read index
-- `milestone_notice_marks_viewer_window_idx (seen_by_hr_id, derived_on)` is untouched.
--
-- ROLLBACK:
--   begin;
--   alter table public.milestone_notice_marks drop constraint milestone_notice_marks_pkey;
--   alter table public.milestone_notice_marks
--     add constraint milestone_notice_marks_unique
--     unique (seen_by_hr_id, derived_on, subject_hr_id, period_spec);
--   commit;
--
-- Verification after apply (this is what the drift check asks):
--   select count(*) from pg_constraint
--    where conrelid = 'public.milestone_notice_marks'::regclass and contype = 'p';   -- 1
--   select count(*) from public.milestone_notice_marks;                              -- unchanged

begin;
set local lock_timeout = '5s';

-- Guarded both ways so the file replays: if a primary key is already there this whole block is a
-- no-op, and the drop only fires when the old unique constraint is still the thing holding identity.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.milestone_notice_marks'::regclass and contype = 'p'
  ) then
    raise notice 'milestone_notice_marks already has a primary key — nothing to do';
    return;
  end if;

  alter table public.milestone_notice_marks
    drop constraint if exists milestone_notice_marks_unique;

  alter table public.milestone_notice_marks
    add constraint milestone_notice_marks_pkey
    primary key (seen_by_hr_id, derived_on, subject_hr_id, period_spec);
end;
$$;

comment on constraint milestone_notice_marks_pkey on public.milestone_notice_marks is
  'One viewer, one occasion. `derived_on` is the ARITHMETIC''s date, never the typed `milestone_on` — keying on the typed date would mint a second occasion from one keystroke and restart the reminder for somebody already congratulated (owner, 2026-09-23). Promoted from the identical unique constraint on 2026-09-27 so the table has the primary key `check:schema-shape` requires.';

notify pgrst, 'reload schema';
commit;
