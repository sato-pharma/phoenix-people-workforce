-- Phoenix CRM — settling a location-integrity case, without destroying the evidence.
--
-- WHAT THIS ADDS
--   Four columns on public.phoenix_crm_location_integrity: settled_at, settled_by, settled_note and
--   settled_flags. Nothing else. No row is ever deleted and no flag is ever rewritten.
--
-- WHY IT IS FOUR COLUMNS AND NOT A STATUS
--   The board's own header carried the reason it had no settle button for a fortnight: "the table has
--   no resolution column, so the only way to clear a flag today is to delete the row — and deleting
--   evidence because a second reading disagreed is how the record of what the detector actually did
--   disappears." A status enum would have been the same mistake one step along: it says a case is
--   closed without saying WHAT was closed, so a detector that files a NEW flag on the same subject
--   tomorrow lands on a row already marked done and is never looked at.
--
--   🔴 settled_flags IS THE WHOLE DESIGN. A case counts as settled only while settled_flags still
--   equals the row's current flags. The filers upsert on (subject_kind, subject_id, source), so a
--   fresh finding REPLACES flags in place — and the moment it does, the stored settlement no longer
--   describes what the row says, the case reopens by itself, and it is back in the counters. That is
--   why not one filer changes in this migration's PR: none of them has to know settling exists.
--
-- WHO MAY WRITE THEM
--   The Super Admin alone, through the application (canSettleIntegrityCases). Grants here are
--   unchanged — the table is postgres + service_role only, the app reads it with the service-role
--   client, and no browser role can reach it.
--
-- THE CHECK
--   All four together or all four empty. A half-written settlement — a note with no author, an author
--   with no flags — would be a case the board could neither show as settled nor show as standing, and
--   a reader would have to guess which. The database refuses it instead.
--
-- SAFETY
--   Additive and reversible. Four nullable columns on a table holding 11 non-test rows in production
--   today; every existing row stays exactly as it is, unsettled, and every reader that does not know
--   about these columns is unaffected.
--
-- ROLLBACK
--   alter table public.phoenix_crm_location_integrity
--     drop constraint if exists phoenix_crm_location_integrity_settled,
--     drop column if exists settled_flags,
--     drop column if exists settled_note,
--     drop column if exists settled_by,
--     drop column if exists settled_at;

alter table public.phoenix_crm_location_integrity
  add column if not exists settled_at timestamptz,
  add column if not exists settled_by text,
  add column if not exists settled_note text,
  add column if not exists settled_flags text[];

comment on column public.phoenix_crm_location_integrity.settled_at is
  'When the Super Admin settled this case, in UTC. Null = never settled, or reopened since.';
comment on column public.phoenix_crm_location_integrity.settled_by is
  'The HR id of the person who settled it. The board prints his NAME, never this code.';
comment on column public.phoenix_crm_location_integrity.settled_note is
  'Why it was settled, required, kept for ever. Never shown to the rep — nothing on this table is.';
comment on column public.phoenix_crm_location_integrity.settled_flags is
  'The flags as they stood when it was settled. The case counts as settled only while this still equals flags, so a NEW finding on the same subject reopens it with no filer knowing settling exists.';

-- All four or none. A partial settlement is a case nobody can read a verdict off.
alter table public.phoenix_crm_location_integrity
  drop constraint if exists phoenix_crm_location_integrity_settled;
alter table public.phoenix_crm_location_integrity
  add constraint phoenix_crm_location_integrity_settled
  check (
    (settled_at is null and settled_by is null and settled_note is null and settled_flags is null)
    or (settled_at is not null and settled_by is not null and settled_note is not null and settled_flags is not null)
  );
