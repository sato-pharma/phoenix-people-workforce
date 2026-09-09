-- Recruitment / ATS — "I will call" and "Skip" on a CV in a manager's portal.
--
-- The owner, 2026-09-09: *"on every cv i want the phone number to be hidden and the download to be
-- blocked of the cv and have 2 buttons on every cv — I will call and Skip. If the manager choose
-- skip then he is skipped normally, and if pressed I will call then every other manager receiving
-- this CV when open the same CV shows that Ahmed will call this CV, or reserved."*
--
-- ── WHY ONE TABLE HOLDS TWO DIFFERENT SHAPES ────────────────────────────────────────────────────
--
-- A CLAIM is per CANDIDATE. That is the whole feature: one manager says he will call, and every
-- other manager reading the same CV is told who. Two claims on one candidate would defeat it.
--
-- A SKIP is per (CANDIDATE, MANAGER). The same CV genuinely reaches several managers — a recruiter
-- may send one person to two of them, and a district folder is DERIVED from the area the applicant
-- asked for, so a Nasr City CV sits in three managers' folders at once. One manager passing must
-- leave it in front of the other two, exactly as ats_candidate_district_returns already works.
--
-- Two shapes, one table, because they are the same act read two ways — what this manager did about
-- this CV — and a manager who claims and later skips must not end up holding both. The unique index
-- on (candidate_id, manager_hr_id) makes his row single and lets a skip overwrite his own claim in
-- one write; the PARTIAL unique index on (candidate_id) WHERE action = 'will_call' is what makes the
-- claim single across everybody. Two separate tables would need a transaction to keep those two
-- facts agreeing, and would still drift the first time somebody wrote to only one of them.
--
-- ── THE PARTIAL INDEX IS THE RACE GUARD, NOT THE READ ABOVE IT ──────────────────────────────────
--
-- Two managers pressing within the same second both read "nobody has claimed this" and both insert.
-- The index lets exactly one through; the loser is told who won and his screen redraws. A check-then-
-- insert with no index behind it is the version of this that reserves one CV to two people, and it
-- fails precisely on the busy CV where it matters.
--
-- ── hr_id CASE ─────────────────────────────────────────────────────────────────────────────────
--
-- manager_hr_id is stored UPPER-CASE canonical, with a CHECK, exactly as
-- ats_candidate_district_returns.manager_hr_id and ats_candidate_views.viewer_hr_id are. ats_candidates
-- stores 'b-10' where public.employees stores 'B-10', and an un-normalised comparison here would
-- suppress nobody's folder and reveal nobody's phone number, silently. One canonical case at the
-- boundary; every in-memory key routes through canonicalHrIdKey.
--
-- ── WHAT THIS TABLE DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────
--
-- It does not touch the candidate's status. A claim is an intention to phone somebody, not a verdict
-- (owner, 2026-09-09: "only reserves; he answers after the call"), so ats_candidates.status, the
-- recruiter's pool filters and the manager-feedback queue all read exactly as they did. Skip on a CV
-- a recruiter SENT to a manager still goes through the existing decision route and still records
-- "Not interested" with the manager's reason — that path is unchanged and is not this table's job.
--
-- ── APPLIED ON PROD ────────────────────────────────────────────────────────────────────────────
--
-- NOT YET APPLIED at the time of writing. The reading code degrades on a missing table (PGRST205,
-- which is what a missing TABLE answers — never 42P01) to "nobody has claimed anything", which is
-- the pre-claim screen: phone hidden, both buttons offered, a press answered with "that could not be
-- recorded". Quiet and honest, so the deploy may land first — but apply this promptly after, because
-- until it exists no manager can reserve anything.
--
-- ADDITIVE. One new table, no existing row touched, nothing dropped. Reversible: drop the table.

begin;

create table if not exists public.ats_candidate_call_actions (
  id uuid primary key default gen_random_uuid(),
  -- The CV. Cascades on delete exactly as ats_candidate_district_returns does: with the candidate
  -- gone the reservation is moot, and keeping it would be an orphan pointing nowhere.
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  -- The manager who acted. Upper-case canonical; the server derives it from the caller's own session
  -- and never from the request body, so it is always the person who actually pressed the button.
  manager_hr_id text not null,
  -- A snapshot of his name, frozen at the moment he acted, so another manager's screen reads
  -- "Ahmed Gawish will call this candidate" as a plain select with no join to a directory a leaver
  -- drops out of. Same reasoning as ats_candidate_district_returns.manager_name.
  manager_name text,
  -- 'will_call' — he has reserved this candidate and is the only person who may see the phone number.
  -- 'skipped'   — he has passed; the CV leaves HIS folder and nobody else's.
  action text not null,
  -- Free text he may leave with a skip. Nothing reads it today; it exists so a manager's reason has
  -- somewhere to go the first time somebody asks for one, rather than a second migration.
  note text,
  acted_at timestamptz not null default now(),
  constraint ats_candidate_call_actions_hr_id_upper check (manager_hr_id = upper(manager_hr_id)),
  constraint ats_candidate_call_actions_hr_id_present check (length(btrim(manager_hr_id)) > 0),
  constraint ats_candidate_call_actions_action_known check (action in ('will_call', 'skipped'))
);

comment on table public.ats_candidate_call_actions is
  'What one manager did about one CV in his portal: will_call (he reserved it — the ONLY way the candidate''s phone number is revealed, and every other manager reading the same CV is told his name) or skipped (he passed — the CV leaves only HIS derived district folder, exactly like ats_candidate_district_returns). One row per (candidate, manager); a partial unique index on candidate_id where action = will_call is what keeps a claim single across everybody. Does not touch ats_candidates.status.';

comment on column public.ats_candidate_call_actions.action is
  'will_call = reserved by this manager, phone revealed to him alone, notice shown to every other reader. skipped = this manager passed; suppresses the CV from his district folders only and releases any claim he held.';

-- ONE ROW PER MANAGER PER CV. Also the conflict target the writes upsert on, which is what lets a
-- skip overwrite that manager's own earlier claim in a single statement instead of a delete plus an
-- insert that can half-apply.
create unique index if not exists ats_candidate_call_actions_manager_candidate_unique
  on public.ats_candidate_call_actions (candidate_id, manager_hr_id);

-- ONE CLAIM PER CV, ACROSS EVERYBODY. Partial, so any number of managers may skip the same CV while
-- exactly one may reserve it. This index IS the race guard — see the header.
create unique index if not exists ats_candidate_call_actions_one_claim
  on public.ats_candidate_call_actions (candidate_id)
  where action = 'will_call';

-- The page load: "who has claimed any of these CVs?", asked once per My Candidates render with every
-- candidate id on the page.
create index if not exists ats_candidate_call_actions_claim_lookup_idx
  on public.ats_candidate_call_actions (candidate_id)
  where action = 'will_call';

-- The folder load: "which CVs has THIS manager skipped?", read alongside his returns on every render
-- for a manager holding a district seat.
create index if not exists ats_candidate_call_actions_manager_skips_idx
  on public.ats_candidate_call_actions (manager_hr_id)
  where action = 'skipped';

-- RLS on with no grants to authenticated/anon, matching the rest of the recruitment schema: every
-- read goes through the service-role client, so a policy-less RLS-enabled table is the correct closed
-- default. A browser must never reach these rows directly — the claim is what gates a candidate's
-- phone number, so a row readable from the client would hand out the thing the feature hides.
alter table public.ats_candidate_call_actions enable row level security;

commit;

-- ── ROLLBACK ───────────────────────────────────────────────────────────────────────────────────
-- Purely additive. Dropping the table restores the previous shape exactly; it DISCARDS every claim
-- and skip recorded in the meantime, which un-hides nothing (the phone stays hidden — with no claims
-- to read, no viewer is the holder) but does put every skipped CV back into its manager's folder.
-- Read the count first:
--
--   select action, count(*) from public.ats_candidate_call_actions group by 1;
--
-- begin;
--   drop table if exists public.ats_candidate_call_actions;
-- commit;
