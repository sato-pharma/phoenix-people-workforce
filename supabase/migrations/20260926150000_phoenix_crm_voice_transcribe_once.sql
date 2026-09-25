-- Phoenix CRM voice — one transcription per recording.
--
-- WHAT. Adds one nullable column, `transcribed_at`, to `public.phoenix_crm_voice_uploads`. It records
-- the moment a recording was written out by the server speech path (`voice-transcribe.ts`), and is
-- CLAIMED there with `update ... where transcribed_at is null` so a single recording is transcribed at
-- most once.
--
-- WHY. `/api/phoenix-crm/voice/transcribe` gated only on "his own slot, inside the two-hour window" and
-- then called Groq. The same owned path could be re-POSTed any number of times inside that window — each
-- a fresh paid call — which the window's own header calls "a cost and abuse rule" it was meant to stop.
-- This column is the row lock that makes the claim atomic: transcription now sets it, and a resubmission
-- of an already-written-out path is refused with no call. It is INDEPENDENT of `used_at` (attached to a
-- visit, set by the save's `phoenix_crm_take_voice`); a recording can be transcribed before it is saved,
-- and a failed transcription releases the claim (sets the column back to null).
--
-- SAFETY. Additive and nullable, with no default and no backfill, so it is neither destructive nor bulk:
-- existing rows read null (never transcribed by this path), and code deployed before this column existed
-- is unaffected — it selected and never referenced the new column. Apply BEFORE the reading code ships so
-- the column is present when the new transcribe path runs. `notify pgrst` makes PostgREST see it at once.
--
-- ROLLBACK. `alter table public.phoenix_crm_voice_uploads drop column if exists transcribed_at;`
-- (drops only this column and its recorded claim timestamps; nothing else depends on it.)
--
-- Production has NO PITR — 7 daily backups are the whole recovery story — but an additive nullable column
-- needs none: the rollback above is exact and immediate.

begin;

set local lock_timeout = '5s';

alter table public.phoenix_crm_voice_uploads
  add column if not exists transcribed_at timestamptz;

notify pgrst, 'reload schema';

commit;
