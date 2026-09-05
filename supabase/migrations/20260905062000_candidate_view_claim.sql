-- Recruitment / ATS — "somebody is reading this right now".
--
-- WHY. The owner and HR-010 share screening (owner decision, 2026-09-05). The change that shipped
-- with this file lets each of them SEE that the other has already read a CV, which stops the
-- duplicated work that has already happened. It cannot stop the collision that is happening in the
-- same minute: two people open the same CV at once, both read it, and one of the two readings is
-- wasted. A view row is written 2.5 seconds after the document renders and says only that somebody
-- HAS read it, never that somebody IS reading it.
--
-- WHAT THIS ADDS. One nullable timestamp on the existing per-(candidate, viewer) row. A claim is a
-- short lease, not a lock: it EXPIRES rather than being released, because the failure mode that
-- matters is a screener closing a laptop mid-CV, and a lock that outlives the person holding it
-- takes the queue away from everybody else. Nothing enforces the claim server-side — it is advisory
-- and the screen shows it — so a stale or ignored claim costs a duplicated read, never a lost one.
--
-- WHY NOT A NEW TABLE. `ats_candidate_views` already carries exactly one row per (candidate,
-- viewer) with a unique index on that pair, which is the same grain a claim needs. A second table
-- would need the same key, the same canonical-HR_ID CHECK, and its own pruning — three things that
-- can drift from the first.
--
-- SAFE AND REVERSIBLE. Nullable with no default, so every existing row reads "not claimed" and no
-- backfill is required. Dropping the column restores the previous behaviour exactly.

alter table public.ats_candidate_views
  add column if not exists claimed_until timestamptz;

comment on column public.ats_candidate_views.claimed_until is
  'Advisory short lease: this viewer has the CV open right now, until this instant. EXPIRES rather than being released, so a closed laptop cannot hold a CV away from the other screener. Nothing enforces it server-side; a stale claim costs a duplicated read, never a lost one. Added 2026-09-05 when screening became a two-person job.';

-- Only the live claims are ever read, and they are read per candidate for one screen. Partial, so
-- the index stays the size of "CVs open right now" rather than the size of the view history.
create index if not exists ats_candidate_views_claimed_idx
  on public.ats_candidate_views (candidate_id, claimed_until)
  where claimed_until is not null;
