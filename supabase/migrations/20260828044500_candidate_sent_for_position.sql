-- Recruitment / ATS — the POSITION a CV was sent for, not just the manager it was sent to.
--
-- 20260827213000 froze the MANAGER's own seat onto the send: "Taha Mohamed Taha · District Sales
-- Manager · Giza". That answers "who is holding this CV", and the owner's follow-up the same night
-- made clear it does not answer the question he actually has:
--
--   "he wants to hire Nasr City Medical Rep. He goes to a folder which is called Nasr City Medical
--    Reps ... automated foldering based on the area, so he can look at the same page when he wants
--    a certain position."
--
-- A manager's seat and the seat he is hiring FOR are different things, and one manager holds
-- several of the second. Measured in production 2026-08-28: 35 open vacancies across 34 areas, and
-- Nasr City alone carries TWO Medical Representative seats — Anti Infective reporting to Momen
-- Abdelhady Mohamed Shehata, and Pedia reporting to Ahmed Mohamed Nagy. Grouping on the manager
-- merges vacancies; grouping on area+title alone merges those two Nasr City seats into one folder
-- that belongs to neither manager. The LINE is therefore part of the identity, not decoration.
--
-- Additive. Nothing existing changes meaning, and every current write path keeps working untouched
-- if this migration has not run yet — hiring-manager-notify degrades to a send with no position,
-- exactly as it already degrades for the seat columns.

-- ---------------------------------------------------------------------------
-- What the candidate was sent FOR.
-- ---------------------------------------------------------------------------
--
-- The vacancy id is a real foreign key so a folder can be traced back to the seat on the org
-- chart, and ON DELETE SET NULL because a vacancy being filled or cancelled must never delete the
-- record that a CV was once sent for it. The four text columns are frozen COPIES rather than a
-- join, for the reason the manager seat columns already are: a vacancy that closes, moves line, or
-- gets renamed must not silently rewrite the folder a recruiter filed something under six weeks
-- ago. They are also the only thing a FREE-TYPED position has — the owner asked for both a picked
-- vacancy and a typed one (2026-08-28), so vacancy_id is null on the typed ones and the text still
-- names the folder.
alter table public.ats_candidates
  add column if not exists sent_for_vacancy_id bigint
    references public.position_vacancies (id) on delete set null,
  add column if not exists sent_for_job_title text,
  add column if not exists sent_for_area text,
  add column if not exists sent_for_line text,
  add column if not exists sent_for_region text;

comment on column public.ats_candidates.sent_for_vacancy_id is
  'The open vacancy this CV was sent for, when the recruiter picked one from the organogram. NULL for a free-typed position, and set to NULL rather than cascading if the vacancy is later removed — the send happened either way.';
comment on column public.ats_candidates.sent_for_job_title is
  'The job title the candidate was sent FOR — not the notified manager''s own title. Frozen at send time so a renamed or closed vacancy cannot re-file an old send under a different folder.';
comment on column public.ats_candidates.sent_for_area is
  'The area of the position being hired for, e.g. Nasr City. Frozen at send time for the same reason.';
comment on column public.ats_candidates.sent_for_line is
  'The line of the position being hired for. Part of the folder identity, not decoration: Nasr City carries two Medical Representative seats on different lines reporting to different managers, and without the line they collapse into one folder belonging to neither.';
comment on column public.ats_candidates.sent_for_region is
  'The region of the position being hired for. Frozen at send time; shown as folder context, never used as the folder key.';

-- Deliberately NO backfill. The 24 sends already on record were made before a position could be
-- chosen, and there is no evidence anywhere on the row saying which vacancy each was meant for —
-- the notified manager holds several. Inventing one would put real candidates in a folder nobody
-- filed them under, which is worse than the honest answer the UI gives instead: they group under
-- "No position given" until somebody re-files them.

-- The folder question asked from the vacancy's side — "who have we sent for this seat?" — reads
-- this. Partial because only sent-for rows can answer it, which today is a small minority of 435.
create index if not exists ats_candidates_sent_for_vacancy_idx
  on public.ats_candidates (sent_for_vacancy_id, manager_notified_at desc)
  where sent_for_vacancy_id is not null;
