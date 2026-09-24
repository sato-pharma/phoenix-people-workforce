-- add_channel_apply_whatsapp_number
--
-- WHAT THIS CHANGES:
--   Adds a nullable text column `apply_whatsapp_number` to public.ats_job_post_channels, and points
--   the "WhatsApp apply line" channel (PX-WAL) at 01159888247.
--
--   A channel's tracked apply link normally sends applicants to the one company-wide apply number
--   (RECRUITMENT_APPLY_WHATSAPP_NUMBER). This per-channel override lets a channel send them to a
--   different WhatsApp apply line instead — the company runs two. NULL means "use the company-wide
--   default", so every other channel is unaffected.
--
-- WHY:
--   The owner runs two WhatsApp apply lines (01098500699 and 01159888247). The WhatsApp apply line
--   channel represents the second, so applicants who reach it through that channel's tracked link
--   should be sent to 01159888247, not the shared default (owner decision 2026-09-24).
--
-- ROLLBACK:
--   alter table public.ats_job_post_channels drop column if exists apply_whatsapp_number;
--   (The seed update is undone by dropping the column; no other table is touched.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This change is additive (a new nullable column) and a one-row seed — neither destructive nor bulk.

begin;

alter table public.ats_job_post_channels
  add column if not exists apply_whatsapp_number text;

comment on column public.ats_job_post_channels.apply_whatsapp_number is
  'Per-channel WhatsApp apply number: the number this channel''s tracked apply link sends applicants to. '
  'NULL falls back to the company-wide RECRUITMENT_APPLY_WHATSAPP_NUMBER. Normalised to a wa.me number at link-build time.';

-- Point the WhatsApp apply line channel at its own line (owner decision 2026-09-24).
-- Keyed on code, so this is a no-op on any environment where that channel does not exist (staging).
update public.ats_job_post_channels
   set apply_whatsapp_number = '01159888247',
       updated_at = now()
 where code = 'PX-WAL';

commit;
