-- Drop the one foreign key from a live table into the retired deductions-governance backup schema.
--
-- WHAT
--   public.private_calendar_no_activity_clarifications.deduction_candidate_id carries
--   `private_calendar_no_activity_clarif_deduction_candidate_id_fkey`, which REFERENCES
--   deductions_governance_backup_20260830.deduction_candidates(id). This drops that constraint and
--   nothing else. No row is read, changed or deleted; the column and its 15 non-null values stay.
--
-- WHY
--   20260830140000_retire_deductions_governance_surface.sql archived the dead SINGULAR
--   `deduction_*` tables with ALTER ... SET SCHEMA and deliberately left this one inbound FK in
--   place, because a SET SCHEMA does not rewrite the referencing table. That was right for the
--   move and wrong as an end state: it makes an "archive" load-bearing. Anything that drops
--   the schema would either fail on this FK or, with CASCADE, take the constraint off a live table
--   as a side effect. scripts/audit-backup-schemas.mjs already treats the schema as PINNED because
--   of it, so the schema could never pass its retention.
--
-- WHY IT IS DROPPED AND NOT RE-POINTED
--   The obvious fix, pointing it at the live PLURAL table `public.deductions_candidates`, is
--   impossible and was checked against production on 2026-10-09: of the 15 non-null values, 15 exist
--   in the backup table and 0 exist in the live one. The two modules have separate id spaces
--   (206 archived rows, 2,248 live), so a re-point could only be created NOT VALID and would
--   describe a relationship that is false. Nulling the 15 values would destroy the only record of
--   which governance candidate each clarification answered. So the history is kept as a plain uuid
--   and the column is commented to say what it is.
--
-- WHY THIS IS SAFE
--   - Nothing in src/, tests/ or scripts/ reads or writes this table or names the constraint; the
--     30 Aug migration records the table as dead in code. The only `deduction_candidate_id` in src
--     belongs to attendance_annual_balance_charges, a different table with its own FK.
--   - PostgREST cannot embed across this FK anyway: the target schema is not exposed.
--   - Dropping an FK takes ACCESS EXCLUSIVE on the child and the parent. Both are tiny and idle
--     (92 rows; an archive), and `lock_timeout` makes it give up rather than queue behind a query.
--
-- RE-APPLY / OTHER DATABASES
--   If the constraint is already gone, or points anywhere other than the backup schema (a database
--   that never ran the 30 Aug retirement), this does nothing and says so; it never fails there.
--   It only RAISES if, afterwards, ANY foreign key from outside the backup schema still points
--   into it, because that is the condition this file exists to end.
--
-- ROLLBACK (valid while the backup table and those 15 ids exist, which this file does not touch)
--   alter table public.private_calendar_no_activity_clarifications
--     add constraint private_calendar_no_activity_clarif_deduction_candidate_id_fkey
--     foreign key (deduction_candidate_id)
--     references deductions_governance_backup_20260830.deduction_candidates (id);

do $$
declare
  v_def   text;
  v_left  integer;
begin
  set local lock_timeout = '5s';

  select pg_get_constraintdef(c.oid)
    into v_def
    from pg_constraint c
   where c.conrelid = 'public.private_calendar_no_activity_clarifications'::regclass
     and c.conname  = 'private_calendar_no_activity_clarif_deduction_candidate_id_fkey';

  if v_def is null then
    raise notice 'clarifications FK already absent - nothing to drop';
  elsif v_def not like '%deductions_governance_backup_20260830.deduction_candidates%' then
    raise notice 'clarifications FK does not point into the backup schema (%), leaving it alone', v_def;
  else
    alter table public.private_calendar_no_activity_clarifications
      drop constraint private_calendar_no_activity_clarif_deduction_candidate_id_fkey;
    raise notice 'dropped clarifications FK that was: %', v_def;
  end if;

  comment on column public.private_calendar_no_activity_clarifications.deduction_candidate_id is
    'Historical id of a row in the RETIRED deductions-governance table '
    'deductions_governance_backup_20260830.deduction_candidates (the old singular module, archived '
    '2026-08-30). It is NOT a key into the live public.deductions_candidates: the two id spaces are '
    'separate and none of the 15 non-null values exists there. No foreign key since 2026-10-09 '
    '(20261009213000), so the archive schema can be retired on its own.';

  -- The condition this file exists to end: nothing outside the backup schema may still depend on it.
  select count(*)
    into v_left
    from pg_constraint c
    join pg_class tgt on tgt.oid = c.confrelid
    join pg_namespace tn on tn.oid = tgt.relnamespace
    join pg_class src on src.oid = c.conrelid
   where c.contype = 'f'
     and tn.nspname = 'deductions_governance_backup_20260830'
     and src.relnamespace <> tn.oid;

  if v_left > 0 then
    raise exception 'refusing: % foreign key(s) from outside deductions_governance_backup_20260830 still point into it', v_left;
  end if;
end
$$;
