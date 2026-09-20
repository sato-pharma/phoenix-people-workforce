-- add_ats_files_upload_origin
--
-- WHAT THIS CHANGES: adds a nullable `upload_origin` text column to `public.ats_files`, recording
-- which in-app path uploaded a CV: `interview_calendar`, `ats_upload` or `whatsapp_inbox`. Nothing
-- is backfilled — every existing row keeps `null`, which means "arrived through inbound intake",
-- exactly the behaviour those rows have today.
--
-- WHY: the CV cabinet files a CV by the CHANNEL it arrived on, read from `ats_cv_intake_events`.
-- A CV uploaded inside Phoenix has no intake record, so `cabinetRedFlagFor` flagged it
-- `source_unknown` and parked it under `Red flags/Source unknown`. Measured on production
-- 2026-09-21: all 5 CVs ever uploaded by a person sat there, 4 of them CVs the owner attached
-- himself when booking an interview. The channel is not unknown at all — it is the app — but
-- nothing on the file said so. Deliberately NOT a new `ats_cv_intake_events.channel` value: that
-- column is typed `"email" | "whatsapp" | null` across intake analytics, the 6h digest, WhatsApp
-- health and the source-context readers, and a third value would disturb the intake counts the
-- owner reads.
--
-- ROLLBACK: alter table public.ats_files drop column upload_origin;
--   Dropping it loses the recorded origins, which cannot be reconstructed — the rows then read as
--   inbound intake again, which is how they read before this migration.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
--
-- Additive and non-destructive: one nullable column, no backfill, no grant change, no row touched.

begin;

alter table public.ats_files
  add column if not exists upload_origin text;

comment on column public.ats_files.upload_origin is
  'Which in-app path uploaded this file: interview_calendar, ats_upload, whatsapp_inbox. NULL means it arrived through inbound intake (email or WhatsApp), where ats_cv_intake_events carries the channel instead.';

commit;
