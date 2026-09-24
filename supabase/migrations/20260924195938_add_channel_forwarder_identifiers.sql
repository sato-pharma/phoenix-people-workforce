-- add_channel_forwarder_identifiers
--
-- WHAT THIS CHANGES:
--   Adds a nullable text[] column `forwarder_identifiers` to public.ats_job_post_channels, and
--   seeds the two live relay handsets onto the PX-FORWARDED catch-all channel.
--
--   Each entry is a relay/forwarder WhatsApp number. When a forwarded CV arrives from that number
--   carrying NO on-CV advert code (the caption/filename path added in #4329 found nothing), intake
--   attributes it to the channel that owns the number. The on-CV code always wins; this only fills
--   code-less forwards. Forward-only — no historical rows are re-stamped.
--
-- WHY:
--   ~95% of CVs reach recruitment as a forward from two dedicated relay handsets, which drop the
--   applicant's code-bearing greeting. The owner chose (2026-09-24) to attribute each relay to its
--   own advert channel, starting both on the PX-FORWARDED catch-all and refining later in the UI.
--
-- ROLLBACK:
--   alter table public.ats_job_post_channels drop column if exists forwarder_identifiers;
--   (The seed update is undone by dropping the column; no other table is touched.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is additive (a new nullable column) and a two-row seed — neither destructive nor bulk.

begin;

alter table public.ats_job_post_channels
  add column if not exists forwarder_identifiers text[];

comment on column public.ats_job_post_channels.forwarder_identifiers is
  'Relay/forwarder WhatsApp numbers whose code-less forwarded CVs are attributed to this channel. '
  'The on-CV advert code (caption/filename/greeting) always takes precedence; matched by 9-digit tail.';

-- Seed the two live relay handsets onto the PX-FORWARDED catch-all (owner decision 2026-09-24).
-- Keyed on code, so this is a no-op on any environment where that channel does not exist (staging).
update public.ats_job_post_channels
   set forwarder_identifiers = array['+201280955558', '+201159888247'],
       updated_at = now()
 where code = 'PX-FORWARDED';

commit;
