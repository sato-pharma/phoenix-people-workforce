-- Recruitment / ATS — a district manager hands a CV back to the administrator.
--
-- The owner, 2026-09-01: *"make an option to tell them return this CV to the administrator because
-- area not match — or any other situation, they can return in this feedback to the admin. And when
-- they do this, the CV comes back in a folder based on the district manager who is sending it. And
-- this returned CV is not any more in the district manager folder."*
--
-- ── WHY A RETURN NEEDS A ROW, NOT A COLUMN ──────────────────────────────────────────────────────
--
-- The district folders are DERIVED, never stored (see src/lib/recruitment/district-manager-folders.ts).
-- A CV lands in a manager's folder because the applicant NAMED his area, or because an old CV's
-- governorate resolved to his region — nobody put it there by hand, so there is nothing to "remove".
-- A return is therefore a SUPPRESSION recorded beside the derivation: the placement rule still puts
-- the CV in the folder, and this table is what tells that rule to drop it for the ONE manager who
-- sent it back. The owner was explicit that it leaves only HIS folder — the same CV genuinely
-- belongs to the Nasr City folder on three lines at once, and a return by the Anti Infective manager
-- must not take it away from the CNS and Pedia managers who never objected to it.
--
-- ── WHY PER-MANAGER, AND WHY THE REPORT STILL COUNTS IT ─────────────────────────────────────────
--
-- manager_hr_id is the person whose folder it leaves. The silent Manager CV Engagement report
-- (loadAllDistrictBoards) does NOT read this table on purpose: a returned CV WAS received by him and
-- he DID act on it, so subtracting it would undercount his engagement — the very number the report
-- exists to show. Suppression is about decluttering his working folder, not about rewriting the
-- audit of what reached him. The two questions are answered by two code paths, and only the
-- manager-scoped one (listDistrictBoardsForManager) reads this table.
--
-- ── hr_id CASE, THE TRAP THIS SCHEMA HAS ALREADY WATCHED BITE ───────────────────────────────────
--
-- manager_hr_id is stored UPPER-CASE canonical, exactly as ats_candidate_views.viewer_hr_id is, and
-- for the identical reason: ats_candidates stores an id as lower-case 'b-10' while public.employees
-- stores 'B-10', and an un-normalised comparison silently matches nobody. A lower-case write with an
-- upper-case read would suppress the wrong nobody and leave every returned CV sitting in the folder
-- forever. One canonical case at the boundary, enforced by a CHECK; the TypeScript side writes
-- canonicalHrIdForDisplay(...) and reads with the same, and every in-memory key routes through
-- canonicalHrIdKey so the stored case never has to agree with the org tree's.
--
-- ── STATUS: THE QUEUE CLEARS, THE SUPPRESSION MAY OR MAY NOT ────────────────────────────────────
--
-- 'open'       — in the administrator's Returned CVs queue, and suppressed from the manager's folder.
-- 'resolved'   — the admin has dealt with it; it leaves the queue but STAYS suppressed, because the
--                manager's decision to return it was deliberate and re-showing it would re-ask a
--                question he already answered.
-- 'reinstated' — the admin sends it back to the manager: it leaves the queue AND stops suppressing,
--                so the derivation puts it back in his folder. Reserved here (the CHECK admits it)
--                so that action can be added later with no migration; v1 wires only 'resolved'.
--
-- Suppression = a row whose status is 'open' or 'resolved'. 'reinstated' does not suppress.
--
-- ── NOT APPLIED YET ─────────────────────────────────────────────────────────────────────────────
--
-- Applying a migration to production is one of the two protected actions in AGENTS.md §6 and needs
-- the owner's explicit approval in the conversation. This file is written and reviewed; it has been
-- run against NOTHING here. When approved it must land BEFORE the code deploy reaches production —
-- the loader reads this table, and a deploy that arrived first would 500 the My Candidates folder on
-- an unknown relation (a missing table answers PGRST205, which the loader degrades on, so in
-- practice the folder would silently show every CV again rather than crash — still the wrong order).
--
-- ADDITIVE. One new table, no existing row touched, nothing dropped. Reversible: drop the table.

begin;

create table if not exists public.ats_candidate_district_returns (
  id uuid primary key default gen_random_uuid(),
  -- The CV being handed back. Cascades on delete exactly as ats_candidate_views does: if the
  -- candidate is gone, the suppression is moot and keeping it would be an orphan pointing nowhere.
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  -- Whose folder it leaves. Upper-case canonical; the server derives it from the caller's own
  -- session, never from the request body, so it is always the manager who actually pressed Return.
  manager_hr_id text not null,
  -- A snapshot of the manager's name for the admin queue, so that screen is a plain read with no
  -- join to a directory that a leaver would drop out of. Frozen on purpose, like manager_notified_name.
  manager_name text,
  -- Where the CV sat when it was returned — the organogram seat and the area folder it was in. All
  -- snapshots, all for the admin's context ("returned from the Anti Infective · Cairo, Nasr City
  -- folder"); none is trusted for anything but display.
  seat_id text,
  seat_label text,
  line_name text,
  region_name text,
  area_name text,
  -- Why. 'area_not_match' is the owner's named case; 'other' carries a free-text reason_note. The
  -- vocabulary is pinned in the database as well as at the API boundary, the same belt-and-braces
  -- the folder-kind CHECK uses, because a half-known reason is a queue row an admin cannot triage.
  reason_code text not null,
  reason_note text,
  -- The queue lifecycle. See the header: 'open' is in the queue and suppressing, 'resolved' has left
  -- the queue but still suppresses, 'reinstated' (reserved) neither.
  status text not null default 'open',
  returned_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_hr_id text,
  resolution_note text,
  constraint ats_candidate_district_returns_hr_id_upper check (manager_hr_id = upper(manager_hr_id)),
  constraint ats_candidate_district_returns_hr_id_present check (length(btrim(manager_hr_id)) > 0),
  constraint ats_candidate_district_returns_reason_known check (reason_code in ('area_not_match', 'other')),
  constraint ats_candidate_district_returns_status_known check (status in ('open', 'resolved', 'reinstated')),
  -- A resolved or reinstated row carries when it happened; an open one does not. The same complete-
  -- or-empty shape as ats_candidates_background_confirmation_complete, and for the same reason: a row
  -- two queries disagree about is how a returned CV gets lost.
  constraint ats_candidate_district_returns_resolution_paired check (
    (status = 'open' and resolved_at is null)
    or (status in ('resolved', 'reinstated') and resolved_at is not null)
  )
);

comment on table public.ats_candidate_district_returns is
  'A district manager''s "hand this CV back to the administrator" — a per-manager SUPPRESSION beside the derived district folders, not a move. The placement rule (district-manager-folders.ts) drops a CV from ONLY this manager''s folder while it carries an open/resolved row here; other lines that share the area keep it. The silent engagement report deliberately does NOT read this table. manager_hr_id is upper-case canonical, same as ats_candidate_views.viewer_hr_id.';

comment on column public.ats_candidate_district_returns.status is
  'open = in the admin Returned CVs queue and suppressing the CV from the manager''s folder; resolved = handled, out of the queue, still suppressing; reinstated = sent back to the manager, out of the queue, no longer suppressing. Suppression = status in (open, resolved).';

-- One OPEN return per manager per CV. Partial so a later resolved/reinstated history does not block
-- a fresh return, and unique so a double-press or a two-tab race cannot write the row twice.
create unique index if not exists ats_candidate_district_returns_open_unique
  on public.ats_candidate_district_returns (manager_hr_id, candidate_id)
  where status = 'open';

-- The manager's own folder load: "which CVs has THIS manager returned?", filtered to the suppressing
-- statuses. This is read on every My Candidates page render for a district manager.
create index if not exists ats_candidate_district_returns_manager_idx
  on public.ats_candidate_district_returns (manager_hr_id)
  where status in ('open', 'resolved');

-- The candidate's side: "has this manager returned this one CV?", for the per-CV access check.
create index if not exists ats_candidate_district_returns_candidate_idx
  on public.ats_candidate_district_returns (candidate_id);

-- The administrator's queue: the open ones, newest first.
create index if not exists ats_candidate_district_returns_queue_idx
  on public.ats_candidate_district_returns (status, returned_at desc);

-- RLS on with no grants to authenticated/anon, matching the rest of the recruitment schema: every
-- read goes through the service-role client, so a policy-less RLS-enabled table is the correct
-- closed default. A browser must never reach these rows directly — who returned which CV, and why,
-- is HR-internal and feeds a Super-Admin-only queue.
alter table public.ats_candidate_district_returns enable row level security;

commit;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────────────────────────
-- Purely additive. Dropping the table restores the previous shape exactly; it DISCARDS every return
-- recorded in the meantime, so read the count first and expect 0 if reverting before anyone has used
-- the feature:
--
--   select status, count(*) from public.ats_candidate_district_returns group by 1;
--
-- begin;
--   drop table if exists public.ats_candidate_district_returns;
-- commit;
