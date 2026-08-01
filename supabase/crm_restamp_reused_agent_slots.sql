-- CRM identity re-stamp — ONE-OFF DATA FIX. NOT a migration.
--
-- ############################################################################################
-- APPLIED TO PRODUCTION (ozucdzovmcqvepbozvqf) 2026-08-01, on explicit owner approval.
-- Kept in the repo as the auditable record of what was run and how to reverse it.
--
--   re-stamped   1,163 visits + 1,063 check-ins  slot 1391  B-85    -> AI-0003
--                  379 visits +   195 check-ins  slot 1536  PD-0003 -> B-164
--                      0 double-partner rows (neither slot ever appears as a double partner)
--   verified     0 rows still mis-stamped; 0 rows left on either leaver
--                post-exit attributions platform-wide: 203 -> 13 (the residual slots below)
--                AI-0003 July visits 0 -> 27; B-164 July visits 0 -> 163
--                both slots now resolve to ACTIVE employees, so neither the static nor the
--                live half of the departed-agent exclusion hides them any more
--   backups      the 2026-08-01 run wrote these into `public`, which left them anon-readable
--                until RLS was enabled by hand the same day. They still hold that run's
--                rollback data and are still where the ROLLBACK section below points:
--                  public.crm_restamp_backup_20260801           (1,542 visit rows)
--                  public.crm_restamp_checkins_backup_20260801  (1,258 check-in rows)
--                Step 0 now writes to a sealed schema instead — see the note there.
--
-- Re-running is safe (every statement is idempotent) but should be unnecessary.
-- ############################################################################################
--
-- ============================================================================================
-- WHAT IS WRONG RIGHT NOW (verified against production ozucdzovmcqvepbozvqf on 2026-08-01)
-- ============================================================================================
--
-- Whoever administers iReports360 hands a departing rep's CRM account to their replacement rather
-- than creating a new one. The Phoenix roster keeps `employees.crm_id` pointing at the person who
-- LEFT, so tier 2 of the identity waterfall stamps the replacement's work with the leaver's hr id.
-- The departed-agent exclusion then hides anything belonging to a leaver — so the new rep's work is
-- invisible on Team Calendar, Field Workforce Compliance, the portal, and every scoped read.
--
--   crm slot 1391  "Soad.Atef ( Cairo East 1 / A )"    1,163 rows stamped B-85    (Tayseer, left 2026-06-02)
--   crm slot 1536  "Essam.Youssef ( Dokki / P )"         379 rows stamped PD-0003 (Mayar,   left 2026-06-30)
--
-- The correct owners are already recorded as tier-1 identity overrides (written 2026-07-31):
--   1391 -> AI-0003 (Soad Atef,  active, no crm_id on file)
--   1536 -> B-164   (Essam Mohamed Youssef Elsayed, active; his roster crm_id is 1477, an old slot)
--
-- The overrides fixed FUTURE syncs. They did not rewrite rows already stored — the Phase 0a backfill
-- that was supposed to do that never ran (the CRON_SECRET rotation 401'd every cron at the time).
-- This script is that missing step.
--
-- ============================================================================================
-- WHY A DATE WINDOW IS *NOT* NEEDED (this was checked, and the original plan's assumption was wrong)
-- ============================================================================================
--
-- The plan assumed slot 1536 held two people's work split by date (Mayar's June + Essam's July), and
-- therefore needed date-scoped overrides. Production says otherwise:
--
--   select agent_crm_id, count(distinct agent_name) ... group by agent_crm_id having count(distinct agent_name) > 1
--
-- returns exactly ONE slot across all ~111k visits (1470), and its two "names" are the same person —
-- one row simply lost the name prefix. Every other slot, including 1391 and 1536, has carried ONE
-- name for its entire history:
--
--   slot 1391 -> "Soad.Atef ( Cairo East 1 / A )"   for all 1,163 rows, 2026-01-01 .. 2026-07-28
--   slot 1536 -> "Essam.Youssef ( Dokki / P )"      for all   379 rows, 2026-05-16 .. 2026-07-30
--
-- So the work under each slot has ALWAYS belonged to its current owner, and an unscoped re-stamp is
-- correct for the whole history. No CRM slot has ever been shared by two people, which is also why
-- date-windowed identity overrides were not built.
--
-- ============================================================================================
-- SAFETY
-- ============================================================================================
--
-- * Idempotent — re-running changes nothing once applied.
-- * Bounded — touches only the two named slots, and only rows still stamped with the leaver's id.
-- * Reversible — the exact inverse is at the bottom, and step 0 snapshots the before-state.
-- * Does NOT touch `employees`. The leavers keep their roster `crm_id`; the tier-1 override plus the
--   new post-exit guard both take precedence, and clearing it is blocked anyway (employeePayload
--   throws "Use the resignation workflow…" for a resigned employee).
-- * Run the whole thing in ONE transaction; check each RAISE NOTICE before COMMIT.

begin;

-- ── Step 0. Snapshot the before-state so the change is auditable and reversible. ──────────────
-- BOTH mutated tables are snapshotted. An earlier draft covered only visits, which would have left
-- the check-in updates in steps 4 with no restore path.
--
-- The snapshots live in their own dated schema, NOT in `public`. `public` is the only schema
-- PostgREST exposes and the one where Supabase grants `anon` SELECT on new tables by default, so a
-- snapshot there is readable with the public anon key until someone remembers to enable RLS. The
-- first version of this script did exactly that: 2,800 rows of agent names, HR IDs and visit dates
-- were anon-readable until RLS was applied by hand on 2026-08-01. See
-- docs/security/backup-table-placement.md.
--
-- RE-RUN NOTE: the original `public.crm_restamp_backup_20260801` and
-- `public.crm_restamp_checkins_backup_20260801` still exist (RLS on, zero policies) and hold the
-- rollback data for the run that already happened. This script now writes elsewhere, so it will
-- NOT find or update them — drop them separately once the re-attribution has settled.
create schema if not exists crm_restamp_backup_20260801;
revoke all on schema crm_restamp_backup_20260801 from anon, authenticated;

create table if not exists crm_restamp_backup_20260801.visits as
select id, crm_visit_id, visit_date, agent_crm_id, agent_name, agent_hr_id, double_crm_id, double_hr_id
from public.ireports360_visits
where agent_crm_id in (1391, 1536)
   or double_crm_id in (1391, 1536);

create table if not exists crm_restamp_backup_20260801.checkins as
select id, crm_checkin_id, check_date, agent_crm_id, agent_hr_id
from public.ireports360_checkins
where agent_crm_id in (1391, 1536);

-- ── Step 1. Confirm the overrides this re-stamp relies on are actually present. ───────────────
-- Fails loudly rather than re-stamping toward a value nobody approved.
do $$
declare missing int;
begin
  select count(*) into missing
  from (values (1391, 'AI-0003'), (1536, 'B-164')) as expected(crm_id, hr_id)
  where not exists (
    select 1 from public.ireports360_crm_identity_resolutions r
    where r.crm_id = expected.crm_id and r.status = 'mapped' and r.mapped_hr_id = expected.hr_id
  );
  if missing > 0 then
    raise exception 'Aborting: % expected identity override(s) missing. Write the overrides first.', missing;
  end if;
end $$;

-- ── Step 2. Re-stamp the PRIMARY agent. ──────────────────────────────────────────────────────
update public.ireports360_visits
set agent_hr_id = 'AI-0003', updated_at = now()
where agent_crm_id = 1391 and agent_hr_id is distinct from 'AI-0003';

update public.ireports360_visits
set agent_hr_id = 'B-164', updated_at = now()
where agent_crm_id = 1536 and agent_hr_id is distinct from 'B-164';

-- ── Step 3. Re-stamp the DOUBLE-VISIT partner side. ───────────────────────────────────────────
-- Same slots appear as the accompanying manager/partner on other reps' rows; leaving these stale
-- would keep double-visit credit pointing at the departed employee.
update public.ireports360_visits
set double_hr_id = 'AI-0003', updated_at = now()
where double_crm_id = 1391 and double_hr_id is distinct from 'AI-0003';

update public.ireports360_visits
set double_hr_id = 'B-164', updated_at = now()
where double_crm_id = 1536 and double_hr_id is distinct from 'B-164';

-- ── Step 4. Check-ins carry the same agent slot and the same stale stamp. ─────────────────────
update public.ireports360_checkins
set agent_hr_id = 'AI-0003', updated_at = now()
where agent_crm_id = 1391 and agent_hr_id is distinct from 'AI-0003';

update public.ireports360_checkins
set agent_hr_id = 'B-164', updated_at = now()
where agent_crm_id = 1536 and agent_hr_id is distinct from 'B-164';

-- ── Step 5. Verify BEFORE committing. ─────────────────────────────────────────────────────────
-- Expect: agent_hr_id AI-0003 for 1391, B-164 for 1536, and ZERO rows still on B-85 / PD-0003.
do $$
declare stale int;
begin
  select count(*) into stale
  from public.ireports360_visits
  where (agent_crm_id = 1391 and agent_hr_id is distinct from 'AI-0003')
     or (agent_crm_id = 1536 and agent_hr_id is distinct from 'B-164');
  raise notice 'visits still mis-stamped (expect 0): %', stale;
end $$;

-- Post-exit attributions remaining anywhere (expect only the small residual cases: B-162 / B-111 /
-- B-176, which are separate slots needing their own identity decision — NOT fixed by this script).
do $$
declare remaining int;
begin
  select count(*) into remaining
  from public.ireports360_visits v
  join public.employees e on e.hr_id = v.agent_hr_id
  where e.last_working_date is not null and v.visit_date > e.last_working_date;
  raise notice 'visits still attributed past an exit date (was 203, expect 13): %', remaining;
end $$;

commit;

-- ============================================================================================
-- ROLLBACK (only if the verification above looked wrong AFTER a commit)
-- ============================================================================================
-- These point at the ORIGINAL 2026-08-01 backups in `public`, because those are the ones
-- holding the rows that run actually overwrote. A later re-run snapshots into
-- crm_restamp_backup_20260801.visits / .checkins instead — roll back from whichever pair
-- matches the run you are undoing.
--
-- update public.ireports360_visits v
-- set agent_hr_id = b.agent_hr_id, double_hr_id = b.double_hr_id, updated_at = now()
-- from public.crm_restamp_backup_20260801 b
-- where v.id = b.id;
--
-- update public.ireports360_checkins c
-- set agent_hr_id = b.agent_hr_id, updated_at = now()
-- from public.crm_restamp_checkins_backup_20260801 b
-- where c.id = b.id;
--
-- NOTE: a rollback only holds until the next sync touches these rows. The tier-1 identity
-- overrides remain in ireports360_crm_identity_resolutions, so the sync re-applies AI-0003/B-164
-- on its own. To genuinely revert, remove those override rows FIRST.
--
-- Drop the backups only once the re-stamp has been confirmed good for a full sync cycle:
-- drop table public.crm_restamp_backup_20260801;
-- drop table public.crm_restamp_checkins_backup_20260801;
--
-- ============================================================================================
-- AFTERWARDS
-- ============================================================================================
-- The three residual slots (B-162 10 rows, B-111 2, B-176 1) are the same class at small scale:
-- somebody is working an account whose roster owner has left. They are deliberately NOT auto-fixed
-- here — each needs a human to confirm WHO the account belongs to now, via
-- /admin/crm -> Unmapped Agents. From this change onward the post-exit guard stops stamping them
-- with the leaver's id, so they surface there as an explicit decision instead of vanishing.
