-- Recruitment — push a candidate to a manager WITHOUT inventing a position first.
--
-- Measured in production 2026-08-15: 221 candidates exist and 214 of them have never left the pool,
-- because the only way to put someone in front of a manager was to attach them to a requisition,
-- and a requisition needs a job title, a line, an area, a seat and an owner. The owner's ask is
-- three steps -- receive the CV, let the AI read it, push the person to the District Manager -- and
-- creating a position is not one of them.
--
-- The application-level send records itself in ats_application_events, which is keyed on an
-- application and therefore unusable for a candidate who has none. Rather than add a second event
-- table for one fact, the candidate carries its own last-send stamp: who was told, their name as it
-- read at the time, and when.
--
-- Deliberately THREE plain columns and not an events table:
--   * the pipeline's existing stamp is already "most recent send wins" (newest-first, first-wins),
--     so per-send history was never displayed and would be storage nobody reads;
--   * it costs zero extra queries -- the candidate list already selects these rows, so the stamp
--     arrives with the candidate instead of a second round trip to Frankfurt for all 221 of them.
--
-- manager_notified_name is denormalised ON PURPOSE. It is the name as shown when the send happened;
-- if that person is later renamed or leaves, the history must still read as what the recruiter saw,
-- and it also means rendering the stamp never has to join employees.

alter table public.ats_candidates
  add column if not exists manager_notified_hr_id text,
  add column if not exists manager_notified_name  text,
  add column if not exists manager_notified_at    timestamptz;

comment on column public.ats_candidates.manager_notified_hr_id is
  'HR_ID of the manager this candidate was last pushed to directly (no requisition involved). Null = never pushed.';
comment on column public.ats_candidates.manager_notified_name is
  'The manager''s display name AS AT the moment of the send -- deliberately denormalised so history reads as what the recruiter saw.';
comment on column public.ats_candidates.manager_notified_at is
  'When the last direct push to a manager succeeded. Written only after delivery, never before.';

-- Partial: the overwhelming majority of rows are null (214 of 221 candidates have never been
-- pushed anywhere), and the only query that uses this asks "who has been sent to me".
create index if not exists ats_candidates_manager_notified_hr_id_idx
  on public.ats_candidates (manager_notified_hr_id)
  where manager_notified_hr_id is not null;
