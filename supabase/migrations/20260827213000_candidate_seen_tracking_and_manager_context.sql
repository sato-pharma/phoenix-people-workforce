-- Recruitment / ATS — "have I seen this CV before?", and who a candidate was actually sent to.
--
-- Two problems, one migration, because they are the same screening session:
--
-- 1. SEEN IS NOT DECIDED. Until now the only mark a candidate could carry was a status —
--    shortlisted, rejected, sent_to_manager. Reading a CV and moving on without judging it wrote
--    NOTHING, so the queue honestly offered it again next time. Measured in production
--    2026-08-27: 366 of 434 candidates sat at status 'new' with status_changed_at IS NULL, and the
--    owner (the only person who has ever screened here — 53 of 61 attributed decisions are his)
--    reported re-reading the same CVs every session. He was right, and the system had no way to
--    know better.
--
-- 2. A SEND RECORDS A NAME AND NOTHING ELSE. manager_notified_hr_id/_name say who, but not what
--    they do or where. So the pushed candidates could not be grouped by the manager's title or
--    area — the recruiter sees a flat list and cannot tell the Giza District Sales Manager's pile
--    from the National Sales Manager's.
--
-- Both are additive. No existing column changes meaning, nothing is dropped, and every write path
-- keeps working untouched if this migration has not run yet.

-- ---------------------------------------------------------------------------
-- 1. Who has looked at whom.
-- ---------------------------------------------------------------------------
--
-- A TABLE, not a column on ats_candidates, and that is deliberate. "Have I seen this" is a
-- question about a PERSON, and a single seen_at column answers "has anyone seen this" — which is
-- the same answer only while exactly one human screens. That is true today and is precisely the
-- kind of thing that stops being true without anyone announcing it; the day Talent Acquisition
-- screens beside the owner, a shared marker would tell each of them the other's reading was their
-- own. The table costs one extra join and can never be wrong in that way.
--
-- viewer_hr_id is stored UPPER-CASE canonical. This is not tidiness either: ats_candidates stores
-- the owner's id as lower-case 'b-10' while public.employees stores 'B-10', and a join between
-- them silently returns nobody. That trap is what this feature would reproduce — a lower-case
-- write and an upper-case read would mark every CV unseen forever, which is the exact bug being
-- fixed here. One canonical case at the storage boundary, enforced by a CHECK.
create table if not exists public.ats_candidate_views (
  candidate_id uuid not null references public.ats_candidates (id) on delete cascade,
  viewer_hr_id text not null,
  -- The first time is what "you have seen this before" is answered from; the last time is what
  -- gets shown, because "seen 3 weeks ago" and "seen an hour ago" mean different things to a
  -- person deciding whether to read it again.
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Opened four times and still undecided is a signal in itself — it usually means the CV is
  -- genuinely borderline, not that it was missed.
  view_count integer not null default 1,
  constraint ats_candidate_views_pkey primary key (candidate_id, viewer_hr_id),
  constraint ats_candidate_views_hr_id_upper check (viewer_hr_id = upper(viewer_hr_id)),
  constraint ats_candidate_views_hr_id_present check (length(btrim(viewer_hr_id)) > 0),
  constraint ats_candidate_views_count_positive check (view_count > 0)
);

comment on table public.ats_candidate_views is
  'Per-person "I have read this CV" marks for the screening queue. Separate from ats_candidates.status: seen is not decided, and a CV read but not judged must still be recallable as read. viewer_hr_id is upper-case canonical — ats_candidates stores lower-case hr ids and employees stores upper-case, so an un-normalised join returns nobody.';

-- The queue's own question, asked once per screening session: "which of these 434 have I already
-- read?". Ordered by last_seen_at so "what did I look at last night" is the same index.
create index if not exists ats_candidate_views_viewer_idx
  on public.ats_candidate_views (viewer_hr_id, last_seen_at desc);

-- The candidate's side: "who has read this one?", for a future shared-screening view.
create index if not exists ats_candidate_views_candidate_idx
  on public.ats_candidate_views (candidate_id);

-- RLS on with no grants to authenticated/anon. This matches the rest of the recruitment schema:
-- visibility in this app is application-scoped and every read goes through the service-role
-- client, so a policy-less RLS-enabled table is the correct closed default rather than an
-- oversight. A browser must never reach these rows directly — who has read which CV is
-- HR-internal.
alter table public.ats_candidate_views enable row level security;

-- ---------------------------------------------------------------------------
-- 2. What the manager a candidate was sent to actually is.
-- ---------------------------------------------------------------------------
--
-- Stamped AT SEND TIME rather than joined on render, for the same reason manager_notified_name
-- already is: the history must keep saying what the recruiter actually saw. A manager who moves
-- from Giza to Cairo next month does not retroactively change where last week's CVs were sent,
-- and a leaver whose employee row is archived must not turn 8 recorded sends into blanks.
alter table public.ats_candidates
  add column if not exists manager_notified_job_title text,
  add column if not exists manager_notified_area text,
  add column if not exists manager_notified_region text;

comment on column public.ats_candidates.manager_notified_job_title is
  'The job title the notified manager held AT THE MOMENT OF THE SEND. Frozen on purpose — a later promotion must not rewrite what the recruiter saw.';
comment on column public.ats_candidates.manager_notified_area is
  'The area the notified manager owned at the moment of the send. Frozen for the same reason.';
comment on column public.ats_candidates.manager_notified_region is
  'The region the notified manager owned at the moment of the send. Frozen for the same reason.';

-- Backfill the sends that already happened. Twenty-four of them at 2026-08-27 22:55 Cairo, to 5
-- managers who are all still active — but the count is deliberately NOT what this UPDATE keys on,
-- because it moved by three rows in the hours between writing this file and pushing it. Every
-- manager involved is still in the directory, so the live employee row IS what the recruiter saw,
-- and this is a faithful reconstruction rather than a guess. Rows whose manager cannot be resolved
-- are left NULL: an unknown title is shown as unknown, never invented.
--
-- The join is on upper(hr_id) against upper(manager_notified_hr_id) precisely because of the
-- case mismatch described above — an `=` on the raw columns matches nothing and would silently
-- backfill zero rows while reporting success.
update public.ats_candidates as c
set
  manager_notified_job_title = nullif(btrim(e.job_title), ''),
  manager_notified_area = nullif(btrim(e.area_name), ''),
  manager_notified_region = nullif(btrim(e.region_name), '')
from public.employees as e
where c.manager_notified_hr_id is not null
  and upper(btrim(e.hr_id)) = upper(btrim(c.manager_notified_hr_id))
  and c.manager_notified_job_title is null
  and c.manager_notified_area is null
  and c.manager_notified_region is null;

-- Grouping the recruiter's "sent to" list, and the manager's own inbox, both read these.
create index if not exists ats_candidates_manager_notified_group_idx
  on public.ats_candidates (manager_notified_hr_id, manager_notified_at desc)
  where manager_notified_hr_id is not null;
