-- phoenix_crm_late_visits: a filed visit the person already logged again is closed by Phoenix itself, with its reason
--
-- WHAT THIS CHANGES: one new nullable column, public.phoenix_crm_late_visits.decision_reason, and the table's one
-- decision check rewritten so a row Phoenix closed by itself (no person decided it) may stand with that reason in
-- place of a decider. Nothing else moves: no row is rewritten here, no grant or policy changes.
-- WHY: owner, 27 Nov 2026, on three "No location" visits whose reps had logged the same doctor again with location
-- minutes later: show that it happened, show it rejected and why, and never count it. A copy of a visit already
-- counted is closed as rejected the moment Phoenix sees the counted one, and it moves to Decided with that reason.
-- ROLLBACK: a new migration that puts the old check back
--   (status = 'pending' or (decided_by_hr_id is not null and decided_at is not null))
-- after giving every row Phoenix closed a decided_by_hr_id, then drops decision_reason. Reading the reasons out first
-- keeps the explanation shown on the Decided tab.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_late_visits add column if not exists decision_reason text;

comment on column public.phoenix_crm_late_visits.decision_reason is
  'Why Phoenix closed this filed visit by itself, read on the Decided tab — the same visit logged again and counted. Null on a decision the Super Admin made. See src/lib/phoenix-crm/server/late-visit-duplicates.ts.';

-- The table's own unnamed decision check, found by what it says rather than a guessed name.
do $$
declare
  existing text;
begin
  for existing in
    select con.conname
    from pg_constraint con
    where con.conrelid = 'public.phoenix_crm_late_visits'::regclass
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%decided_by_hr_id IS NOT NULL%'
  loop
    execute format('alter table public.phoenix_crm_late_visits drop constraint %I', existing);
  end loop;
end
$$;

alter table public.phoenix_crm_late_visits
  add constraint phoenix_crm_late_visits_decided_check
  check (
    status = 'pending'
    or (decided_at is not null and (decided_by_hr_id is not null or (status = 'rejected' and decision_reason is not null)))
  );

notify pgrst, 'reload schema';

commit;
