-- ─────────────────────────────────────────────────────────────────────────────
-- Recruitment — give the candidate status a meaning, and give a decision a reason.
--
-- WHY THIS EXISTS
--
-- `ats_candidates.status` is free text with a default of 'Candidate Created'. Measured in
-- production on 2026-08-15:
--
--   status                                  n
--   --------------------------------------  ---
--   Candidate Created                       225
--   Not Eligible — Non-Egyptian (Dubai, UAE)  1
--
-- 225 of 226 rows carry the database default, which means the column records nothing: it cannot be
-- filtered, counted, or reported on, and the module has no way to answer the one question Talent
-- Acquisition actually asks — "which of these has nobody looked at yet". The 226th row is the whole
-- argument for the note: a real decision was made and the only place to put the reason was the
-- status itself.
--
-- The fixed vocabulary (new / shortlisted / sent_to_manager / rejected / hired) lives in
-- src/lib/recruitment/candidate-status.ts, NOT here. The column stays plain `text` with no CHECK
-- constraint, deliberately: adding a state or renaming a label is then a code change reviewed on a
-- PR, not a migration applied by hand to production. The API route is the enforcement point, and it
-- is the only path a browser can write through.
--
-- ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
--
-- It does NOT rewrite the 226 existing rows. That backfill is a separate, announced step run after
-- the code is deployed, and the ordering is the point: candidate-status.ts maps the legacy
-- 'Candidate Created' onto `new` at read time, so the new code is correct against old rows, whereas
-- old code reading new values would show a raw `new` in the status pill. Migration first, deploy
-- second, backfill third — never the other way round.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. the decision, and why ─────────────────────────────────────────────────

alter table public.ats_candidates
  add column if not exists status_note            text,
  add column if not exists status_changed_at      timestamptz,
  add column if not exists status_changed_by_hr_id text;

comment on column public.ats_candidates.status_note is
  'Free-text reason for the CURRENT status, typed by Talent Acquisition (e.g. "not an Egyptian national"). Overwritten by the next decision — the durable history is ats_candidate_status_events.';
comment on column public.ats_candidates.status_changed_at is
  'When the status last changed. Null means it has never been changed from the default since this column existed.';
comment on column public.ats_candidates.status_changed_by_hr_id is
  'HR_ID of whoever last changed the status. Null means "not recorded", never "system".';

-- The default a brand-new CV lands on. Inbound intake never sets a status explicitly, so this
-- default IS the status of every candidate the email and WhatsApp readers create — it must stay
-- equal to DEFAULT_CANDIDATE_STATUS in src/lib/recruitment/candidate-status.ts.
alter table public.ats_candidates alter column status set default 'new';

-- Phase 3 puts a received-date column, a date filter and a newest-first sort on the pool, and the
-- pool grew by 152 rows in the last 7 days. `recruitment_candidates_status_idx` already covers
-- status; created_at had nothing.
create index if not exists ats_candidates_created_at_idx
  on public.ats_candidates (created_at desc);

-- ── 2. the history the note would otherwise destroy ──────────────────────────
--
-- status_note holds the reason for the CURRENT status only. Reject someone in July with a reason,
-- change anything about them in August, and the July reason is gone. This table is what makes
-- "why did we turn this person down" answerable six months later.
--
-- candidate_id carries no foreign key, for the same reason marketing_request_events does not: a
-- candidate can be hard-deleted (deleteCandidate cascades applications, interviews and files), and
-- an audit row that dies with the record it describes cannot testify about the deletion.

create table if not exists public.ats_candidate_status_events (
  id           bigint generated always as identity primary key,
  -- No FK, on purpose — see above.
  candidate_id uuid        not null,
  from_status  text,
  to_status    text        not null,
  note         text,
  -- Best effort. NULL means "not recorded", and must never be rendered as "system".
  actor_hr_id  text,
  created_at   timestamptz not null default now()
);

comment on table public.ats_candidate_status_events is
  'Append-only history of every candidate status decision. candidate_id deliberately carries no FK so an event outlives a deleted candidate; actor_hr_id NULL means "not recorded", never "system".';

create index if not exists ats_candidate_status_events_candidate_idx
  on public.ats_candidate_status_events (candidate_id, created_at desc);

alter table public.ats_candidate_status_events enable row level security;

drop policy if exists phx_ats_candidate_status_events_service_role on public.ats_candidate_status_events;
create policy phx_ats_candidate_status_events_service_role
  on public.ats_candidate_status_events
  to service_role using (true) with check (true);

grant all on table public.ats_candidate_status_events to service_role;

-- ── 3. append-only enforcement ───────────────────────────────────────────────
-- Grants alone are not enough: service_role is the only writer and would otherwise be free to
-- rewrite history. A row, once written, is final.

create or replace function public.phx_ats_candidate_status_events_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  raise exception 'ats_candidate_status_events is append-only; % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

revoke execute on function public.phx_ats_candidate_status_events_immutable() from public, anon, authenticated;
grant execute on function public.phx_ats_candidate_status_events_immutable() to service_role;

drop trigger if exists ats_candidate_status_events_immutable on public.ats_candidate_status_events;
create trigger ats_candidate_status_events_immutable
  before update or delete on public.ats_candidate_status_events
  for each row execute function public.phx_ats_candidate_status_events_immutable();

-- TRUNCATE needs its OWN statement-level trigger and this is not belt-and-braces — without it
-- "append-only" is simply untrue. Proven on staging for marketing_request_events (see
-- 20260813150000): with UPDATE and DELETE correctly refused, `truncate table …` still emptied it,
-- because TRUNCATE fires no ROW triggers and revoking TRUNCATE from service_role does nothing to
-- the table OWNER — and migrations run as the owner.
drop trigger if exists ats_candidate_status_events_no_truncate on public.ats_candidate_status_events;
create trigger ats_candidate_status_events_no_truncate
  before truncate on public.ats_candidate_status_events
  for each statement execute function public.phx_ats_candidate_status_events_immutable();
