-- Recruitment / ATS — one CV can be sent to SEVERAL managers, and each of them keeps it.
--
-- Owner's instruction, 2026-08-30: "yes a CV can go to two managers".
--
-- WHAT WAS BROKEN. A send was recorded in single columns on the candidate row itself —
-- manager_notified_hr_id / _at / _name / _area / _job_title / _region, plus the sent_for_* position.
-- One column holds one value, and the write is a plain UPDATE, so sending the same CV to a second
-- manager did not add a manager: it OVERWROTE the first one. The candidate then vanished from the
-- first manager's "My Candidates" with no error, no audit row and nothing to look at afterwards —
-- the send trail was the thing being overwritten, so it could not record its own loss.
--
-- Measured in production the morning this was written: Salim Salim Abdo Ibrahim Gomaa was sent
-- Sara Osama AbdAlfattah at 01:44:22 Cairo on 2026-08-30 and received the alert for her. The same
-- CV was sent to Hany Saad Mohamed Omar 31 seconds later, at 01:44:53, and the column moved with
-- her. Salim's list read ZERO candidates while his notification still named her — he clicks it and
-- finds an empty page. That is one confirmed case out of 39 sends; it is not rare by luck, only by
-- how few sends have been made so far.
--
-- WHY A TABLE AND NOT MORE COLUMNS. "Sent to" is a many-to-many between a CV and the people asked
-- to look at it, and the number of them is not known in advance. A second set of columns buys one
-- more manager and re-creates the identical bug on the third. A row per (CV, manager) is the shape
-- the data actually has.
--
-- THE POSITION TRAVELS WITH THE SEND, not with the CV. Two managers can be sent the same person for
-- two different seats — that is the ordinary case for a Medical Representative CV that fits Tanta
-- and Mansoura — so sent_for_* is stored HERE, per send, not once on the candidate. Reading it off
-- the candidate row would file one manager's copy under the other manager's vacancy.
--
-- THE MANAGER'S OWN SEAT IS FROZEN HERE TOO, for the reason it was frozen on the candidate row: a
-- manager who moves area next month did not retroactively change where last week's CV went, and an
-- archived leaver must not turn a recorded send into a blank.
--
-- THE OLD COLUMNS STAY, and the write path keeps filling them (last send wins). Three other
-- readers use them — the 6-hourly CV intake digest, the stale-send nudge, and the recruiter's own
-- "who has this been sent to" line — and this migration is not the place to move those. They are
-- also what makes the change safe to roll back: dropping this table returns the system to exactly
-- today's behaviour, minus the fan-out.
--
-- REVERSIBLE BY CONSTRUCTION. `drop table public.ats_candidate_manager_sends` and nothing else is
-- touched. No column is altered, nothing is deleted, no existing row is rewritten.

begin;

create table if not exists public.ats_candidate_manager_sends (
  id uuid primary key default gen_random_uuid(),

  -- ON DELETE CASCADE, matching the other ats_* children: a send is a fact ABOUT a candidate and
  -- has no meaning once the candidate row is gone. Note the standing repo rule that a cascade runs
  -- as the table OWNER and is not stopped by a write REVOKE — that is intended here, this table
  -- holds no independent record worth stranding.
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,

  -- STORED CANONICAL — lower case, per canonicalHrIdKey() in src/lib/hr-id.ts — and this is the one
  -- column in the ats_* family that is.
  --
  -- HR_IDs elsewhere in this database are MIXED CASE ('B-12', 'b-10', 'PD-0001') because each was
  -- stored however the screen that wrote it happened to carry it, and that has already cost real
  -- money here: a bare .eq against a mixed-case id hid 28% of one report's rows. Canonicalising on
  -- the way IN makes the uniqueness below a plain two-column index, which is what lets the write be
  -- a single upsert — a unique index on lower(manager_hr_id) is an EXPRESSION index, and PostgREST
  -- cannot name an expression index as an ON CONFLICT target, so the write would fail outright.
  --
  -- Readers are unaffected either way: hrIdLookupKeys() already includes the lower-cased form, so
  -- `.in('manager_hr_id', hrIdLookupKeys(x))` matches whatever spelling the caller holds. The
  -- original spelling is not lost — ats_candidates.manager_notified_hr_id still carries it, and the
  -- person is displayed from manager_name, never from an id.
  manager_hr_id text not null,
  manager_name text,
  manager_area text,
  manager_job_title text,
  manager_region text,

  -- The vacancy this manager was asked to fill with this CV. Nullable throughout: a send with no
  -- position is a legitimate send and is what every send looked like before 2026-08-28.
  -- BIGINT to match ats_candidates.sent_for_vacancy_id exactly (checked against production before
  -- applying, where it reads bigint): declaring integer here would narrow the column the backfill
  -- reads from, and the FK-less pair would drift the first time a vacancy id crossed 2^31.
  sent_for_area text,
  sent_for_job_title text,
  sent_for_line text,
  sent_for_region text,
  sent_for_vacancy_id bigint,

  sent_at timestamptz not null default now(),
  -- Who pressed send. Nullable exactly like status_changed_by_hr_id — a dev-preview session carries
  -- no HR_ID, and refusing the send over that would be worse than not knowing.
  sent_by_hr_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A manager is asked once. Re-sending the same CV to the same person updates the existing row
-- (moving sent_at and the position) rather than stacking duplicates in their list — the recruiter
-- re-sending is correcting or re-pointing, not adding a second person to review.
--
-- PLAIN COLUMNS, deliberately: this index is the ON CONFLICT target of the app's upsert, and
-- PostgREST can only name plain columns there. Case-insensitivity is achieved by canonicalising the
-- value on the way in (see the column comment) rather than by wrapping it in lower() here.
create unique index if not exists ats_candidate_manager_sends_unique
  on public.ats_candidate_manager_sends (candidate_id, manager_hr_id);

-- The manager's own inbox is the hot read — "everything sent to me, newest first" — and it is the
-- query behind every My Candidates page load.
create index if not exists ats_candidate_manager_sends_manager_idx
  on public.ats_candidate_manager_sends (manager_hr_id, sent_at desc);

comment on table public.ats_candidate_manager_sends is
  'Recruitment: one row per (candidate, manager) send. Replaces the single manager_notified_* columns on ats_candidates, which could only hold the LAST manager and silently removed a CV from the previous manager''s list. Owner 2026-08-30: "yes a CV can go to two managers". See src/lib/recruitment/manager-sends.ts.';
comment on column public.ats_candidate_manager_sends.manager_hr_id is
  'HR_ID stored CANONICAL (lower case, per canonicalHrIdKey in src/lib/hr-id.ts) — unlike every other HR_ID column here, which are mixed case. Read it through hrIdLookupKeys(), which includes the lower-cased form; never a bare eq on a caller-supplied spelling.';
comment on column public.ats_candidate_manager_sends.sent_for_vacancy_id is
  'The vacancy this manager was sent the CV for. Per SEND, not per candidate: two managers can be sent the same person for two different seats.';

-- ---------------------------------------------------------------------------
-- Backfill — every send currently recorded on a candidate row.
-- ---------------------------------------------------------------------------
--
-- This carries the 39 sends that survive today. It CANNOT recover a send that was already
-- overwritten: the column that held it is the column that was overwritten, so those are gone from
-- the database entirely and are only visible where a notification row still names the candidate.
-- Salim's (above) is repaired separately, by hand, from that evidence — not here, because a
-- migration must not invent rows from a join it cannot justify to a reader.
insert into public.ats_candidate_manager_sends (
  candidate_id, manager_hr_id, manager_name, manager_area, manager_job_title, manager_region,
  sent_for_area, sent_for_job_title, sent_for_line, sent_for_region, sent_for_vacancy_id,
  sent_at
)
select
  -- lower(), matching canonicalHrIdKey's own normalisation. That helper additionally maps one
  -- legacy alias ('aaa' -> 'aa') which cannot be expressed here; it is harmless either way, because
  -- hrIdLookupKeys yields BOTH spellings on every read, so a row written under either is found.
  c.id, lower(c.manager_notified_hr_id), c.manager_notified_name, c.manager_notified_area,
  c.manager_notified_job_title, c.manager_notified_region,
  c.sent_for_area, c.sent_for_job_title, c.sent_for_line, c.sent_for_region, c.sent_for_vacancy_id,
  c.manager_notified_at
from public.ats_candidates c
where c.manager_notified_hr_id is not null
  and c.manager_notified_at is not null
on conflict do nothing;

commit;
