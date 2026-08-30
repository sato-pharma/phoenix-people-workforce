-- ─────────────────────────────────────────────────────────────────────────────
-- Recruitment — a manager's comment on a CV that was pushed to someone below them.
--
-- WHY THIS EXISTS
--
-- The owner, 2026-08-30: "I want the National Sales Manager to have the authority to filter for one
-- of the district managers reporting to him and see the CVs and candidates in his portal ... and
-- can also give a comment on the CV itself."
--
-- Measured in production the same morning: 36 CVs have been pushed to 9 managers, and 10 of them sit
-- with managers beneath one National Sales Manager (a-12) — 7 with a DSM, 2 with a regional manager,
-- 1 with a DSM two levels down. Today the NSM cannot see any of those, and has nowhere to say
-- anything about them.
--
-- ── WHY A NEW TABLE, RATHER THAN ats_candidate_status_events ─────────────────
--
-- The obvious move is to reuse the decision history, and it is wrong. `to_status` on that table is
-- NOT NULL, so a comment would have to name a status it did not change — every comment would write
-- a false transition into the one table that exists to answer "why did we reject them in July".
-- A comment is not a decision, and the two must stay legible apart.
--
-- ── WHY THIS ONE IS NOT APPEND-ONLY, UNLIKE ITS SIBLINGS ─────────────────────
--
-- ats_candidate_status_events, marketing_request_events and the rest are immutable by trigger,
-- because they record what the SYSTEM did. This records what a PERSON typed, and this codebase has
-- already been bitten by writing a human judgement with no correction path: a marketing licence
-- verdict is write-once at approval, and once the request is decided not even a Super Admin can fix
-- a wrong one — it is simply displayed, wrong, on a register, indefinitely.
--
-- So the rule here is deliberately split:
--
--   • UPDATE is refused. A comment's text is never silently rewritten under a reader who has
--     already acted on it — that is the property the immutable siblings exist to protect.
--   • DELETE is allowed, and the application permits it only to the comment's own author. Retracting
--     something you said is a correction path; editing it in place is a rewrite of the record.
--
-- author_name and author_job_title are stored AS AT THE MOMENT OF WRITING, not joined at read time.
-- HR_IDs get reused when a seat is refilled and titles change under people, so resolving the author
-- later would eventually attribute one manager's words to their successor.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.ats_candidate_comments (
  id                bigint generated always as identity primary key,
  -- No foreign key, matching ats_candidate_status_events: a candidate can be hard-deleted, and a
  -- record of what a manager said should not vanish with the row it was about.
  candidate_id      uuid        not null,
  -- NULL means "not recorded", and must never be rendered as "system".
  author_hr_id      text,
  author_name       text,
  author_job_title  text,
  body              text        not null,
  created_at        timestamptz not null default now(),
  -- An empty comment is not a comment. The length ceiling matches the status note the same screens
  -- already use, so a manager cannot type something on one card that the other would refuse.
  constraint ats_candidate_comments_body_not_blank check (btrim(body) <> ''),
  constraint ats_candidate_comments_body_length check (char_length(body) <= 2000)
);

comment on table public.ats_candidate_comments is
  'What a manager said about a CV pushed to somebody in their team. UPDATE is refused by trigger; DELETE is allowed and the application restricts it to the author. author_* columns are stamped at write time, never joined at read time, because HR_IDs are reused when a seat is refilled.';
comment on column public.ats_candidate_comments.author_hr_id is
  'HR_ID of whoever wrote it. NULL means "not recorded", never "system".';
comment on column public.ats_candidate_comments.author_name is
  'The author''s name AS AT the moment of writing. Deliberately denormalised — see the table comment.';

create index if not exists ats_candidate_comments_candidate_idx
  on public.ats_candidate_comments (candidate_id, created_at desc);

alter table public.ats_candidate_comments enable row level security;

drop policy if exists phx_ats_candidate_comments_service_role on public.ats_candidate_comments;
create policy phx_ats_candidate_comments_service_role
  on public.ats_candidate_comments
  to service_role using (true) with check (true);

grant all on table public.ats_candidate_comments to service_role;

-- Deliberately NO grant to anon or authenticated. Visibility in this app is application-scoped —
-- every read goes through the service-role client behind a route that has already checked the
-- viewer's place in the org — and these rows carry a manager's private opinion of a job applicant.

-- ── UPDATE is refused; DELETE is not ─────────────────────────────────────────
-- Grants alone would leave service_role free to rewrite a comment in place. The trigger is what
-- makes "never silently rewritten" true rather than merely intended.

create or replace function public.phx_ats_candidate_comments_no_update()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'ats_candidate_comments cannot be edited; delete and write a new comment instead'
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.phx_ats_candidate_comments_no_update() from public, anon, authenticated;
grant execute on function public.phx_ats_candidate_comments_no_update() to service_role;

drop trigger if exists ats_candidate_comments_no_update on public.ats_candidate_comments;
create trigger ats_candidate_comments_no_update
  before update on public.ats_candidate_comments
  for each row execute function public.phx_ats_candidate_comments_no_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
--
--   drop trigger if exists ats_candidate_comments_no_update on public.ats_candidate_comments;
--   drop function if exists public.phx_ats_candidate_comments_no_update();
--   drop table if exists public.ats_candidate_comments;
--
-- Dropping the table destroys every comment written since it was applied — it is a new table with
-- no other reader, so nothing else breaks, but the words are gone. Take a copy first if any exist.
-- ─────────────────────────────────────────────────────────────────────────────
