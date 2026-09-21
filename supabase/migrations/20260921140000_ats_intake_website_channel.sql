-- Recruitment / ATS — allow a third intake channel: "website".
--
-- ats_cv_intake_events.channel has, since 20260724130000, been constrained to ('email','whatsapp').
-- The public careers-site application form (www.satopharma.com/careers -> POST /api/public/apply)
-- calls the SAME ingestInboundCv path the mailbox poller and the WhatsApp worker use, so an
-- applicant who fills the form lands in the exact same Candidates pipeline. That path stamps the
-- intake event with channel = 'website', which the existing CHECK would reject — so a real
-- applicant's CV would throw at claimIntakeEvent and never become a candidate.
--
-- Purely widening: every existing value ('email', 'whatsapp') still passes, so no row is affected
-- and nothing needs backfilling. The queue table (ats_inbound_intake_queue) is deliberately NOT
-- touched — the website upload already has the CV bytes in hand at request time, so it ingests
-- directly and never enqueues.

alter table public.ats_cv_intake_events
  drop constraint if exists ats_cv_intake_events_channel_check;

alter table public.ats_cv_intake_events
  add constraint ats_cv_intake_events_channel_check
  check (channel = any (array['email'::text, 'whatsapp'::text, 'website'::text]));
