-- medical_insurance_starts_22_november
--
-- WHAT THIS CHANGES: the Libano-Suisse policy year moves one week forward, from 15 November 2026 to
--   14 November 2027 to 22 November 2026 to 21 November 2027 (owner, 2026-11-19: "medical insurance will be
--   started 22 nov 2026"; the end, by his multiple-choice answer: "21 Nov 2027", a full year). Every member
--   whose cover started before 22 November now starts on 22 November, because cover never starts before the
--   policy does (the register's own rule, `service.ts`). A row already ended before 22 November (cover taken
--   off on the policy's first day) keeps that shape: it starts and ends on 22 November, the new first day.
--   Nothing else moves: a joiner who starts on or after 22 November keeps their own day, and no row is added
--   or deleted. On 2026-11-19 production held 138 rows to move (137 from 15 November, 1 from 18 November;
--   5 of them ended on 15 November) and no bill, no plan decision; nobody's age band changes in the week.
--   Applied that day to staging and production: 139 rows now start on 22 November, 1 on 1 December.
-- WHY: the insurer's start date moved; the pricing, the opening statement, the joiners' daily charges and
--   the movements all read the policy row and each member's start day.
-- ROLLBACK: the pre-image is in medical_insurance_backup_20261119 (policies_dates, members_dates):
--   update public.medical_insurance_policies p set starts_on = b.starts_on, ends_on = b.ends_on
--     from medical_insurance_backup_20261119.policies_dates b where b.id = p.id;
--   update public.medical_insurance_members m set coverage_starts_on = b.coverage_starts_on,
--     coverage_ends_on = b.coverage_ends_on
--     from medical_insurance_backup_20261119.members_dates b where b.id = m.id;
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

create schema if not exists medical_insurance_backup_20261119;
revoke all on schema medical_insurance_backup_20261119 from public, anon, authenticated;

create table if not exists medical_insurance_backup_20261119.policies_dates as
  select id, starts_on, ends_on from public.medical_insurance_policies;
create table if not exists medical_insurance_backup_20261119.members_dates as
  select id, coverage_starts_on, coverage_ends_on from public.medical_insurance_members;
revoke all on table medical_insurance_backup_20261119.policies_dates from public, anon, authenticated;
revoke all on table medical_insurance_backup_20261119.members_dates from public, anon, authenticated;

do $$
begin
  -- Only the policy as it was signed moves; on a database without it (or already moved) nothing happens.
  update public.medical_insurance_policies
     set starts_on = date '2026-11-22', ends_on = date '2027-11-21'
   where insurer = 'Libano-Suisse Takaful Egypt'
     and starts_on = date '2026-11-15'
     and ends_on = date '2027-11-14';
  if not found then
    raise notice 'medical_insurance_starts_22_november: no policy from 15 November 2026 to move';
    return;
  end if;

  -- One statement, so each row's end is moved with its start and the end-after-start check holds.
  update public.medical_insurance_members
     set coverage_starts_on = date '2026-11-22',
         coverage_ends_on = case when coverage_ends_on < date '2026-11-22' then date '2026-11-22' else coverage_ends_on end
   where coverage_starts_on < date '2026-11-22';
end
$$;

commit;
