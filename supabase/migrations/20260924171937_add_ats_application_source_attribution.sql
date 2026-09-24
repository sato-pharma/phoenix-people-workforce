-- add_ats_application_source_attribution
--
-- WHAT THIS CHANGES:
--   Adds three additive, nullable columns to public.ats_applications:
--     attributed_channel_code  text        — the manually-tagged source advert (a PX- code from
--                                            ats_job_post_channels); the effective source-of-hire
--                                            when the automatic tracked-link code did not survive
--                                            intake (a forwarded WhatsApp CV drops the applicant's
--                                            own message, the only place the code lives).
--     attributed_by_hr_id      text        — who tagged it.
--     attributed_at            timestamptz — when.
--
-- WHY:
--   "Which advert produced this HIRE" had no answer: the tracked code is captured only on
--   ats_cv_intake_events (keyed to the candidate) and the hire only as
--   ats_applications.converted_employee_hr_id — nothing joined the two ends, and the automatic
--   code survives on almost no intake. This column lets HR attribute a hire to the real advert,
--   overriding the (usually absent) automatic code, so source-of-hire reads end to end.
--
-- ROLLBACK:
--   alter table public.ats_applications
--     drop column if exists attributed_channel_code,
--     drop column if exists attributed_by_hr_id,
--     drop column if exists attributed_at;
--   (Additive and nullable — dropping the columns is the whole undo; no data is coerced or lost
--    from existing columns. No backfill, so nothing to reverse.)
--
-- No foreign key to ats_job_post_channels.code on purpose: it matches
-- ats_cv_intake_events.source_channel_code, which also carries none; channels are retired
-- (is_active=false), never deleted, so a code stays resolvable, and the value is validated against
-- the live directory in application code before it is written.
--
-- Not destructive and not bulk: three nullable columns, no row is read or rewritten.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.ats_applications
  add column if not exists attributed_channel_code text,
  add column if not exists attributed_by_hr_id text,
  add column if not exists attributed_at timestamptz;

comment on column public.ats_applications.attributed_channel_code is
  'Manually-tagged source advert (a PX- code from ats_job_post_channels). The effective source-of-hire = this ?? the earliest surviving source_channel_code across the candidate''s ats_cv_intake_events. Null when nobody has tagged it and no tracked code survived.';

commit;

-- Timestamp 20260924171937 was minted to sort after every migration already on main.
