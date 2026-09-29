-- add_probation_milestone_email_policy
--
-- WHAT THIS CHANGES:
--   1. Widens email_notification_policies_type_check to accept a tenth notification type,
--      'probation_milestone'.
--   2. Inserts that policy row, ENABLED, addressed to the caller's own explicit recipient
--      ('candidate' mode) with the shared HR inbox off.
--   Nothing existing is modified. The 'probation' row keeps enabled = false exactly as the owner
--   left it on 2026-07-19.
--
-- WHY:
--   Owner instruction 2026-09-29: the probation module sends its Day 30 / 60 / 75 emails to
--   Yasmeena Elsafory (HR-009) alone, with Omar Gawish (B-10) on BCC.
--   These milestone emails deliberately do NOT ride the 'probation' policy. That policy is off by
--   the owner's own decision and still governs the legacy per-manager probation reminders, which
--   remain wired to the 5-minute notification cron — flipping it on to deliver three milestone
--   emails would restart roughly 500 manager reminders a month at the same time. A separate type
--   gives the milestones their own admin toggle without touching that one.
--
-- ROLLBACK:
--   delete from public.email_notification_policies where notification_type = 'probation_milestone';
--   alter table public.email_notification_policies drop constraint email_notification_policies_type_check;
--   alter table public.email_notification_policies add constraint email_notification_policies_type_check
--     check (notification_type = any (array['probation','contract_renewal','birthday','offer',
--       'resignation','leave','password_reset','user_created','general']));
--   Fully reversible — one added row and one widened CHECK, no data is rewritten.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This is neither: it adds one row.

begin;

-- 'leave' is carried over deliberately: production already holds a 'leave' row, so dropping it
-- from the list would make the constraint unsatisfiable against existing data.
alter table public.email_notification_policies
  drop constraint if exists email_notification_policies_type_check;

alter table public.email_notification_policies
  add constraint email_notification_policies_type_check
  check (notification_type = any (array[
    'probation'::text,
    'probation_milestone'::text,
    'contract_renewal'::text,
    'birthday'::text,
    'offer'::text,
    'resignation'::text,
    'leave'::text,
    'password_reset'::text,
    'user_created'::text,
    'general'::text
  ]));

insert into public.email_notification_policies (
  notification_type,
  label,
  description,
  enabled,
  recipient_mode,
  recipient_modes,
  include_hr_inbox,
  target_titles,
  target_lines,
  template_subject,
  template_title,
  template_greeting,
  template_body_text,
  template_closing_text,
  template_preview_text,
  updated_at,
  updated_by
) values (
  'probation_milestone',
  'Probation milestones',
  'Probation Day 30 / 60 / 75 milestone emails — To Yasmeena Elsafory, BCC Omar Gawish.',
  true,
  'candidate',
  array['candidate']::text[],
  false,
  array[]::text[],
  array[]::text[],
  '{subject}',
  '{title}',
  'Dear Phoenix Team,',
  '{summary}',
  'Open the live report to review this milestone.',
  'Probation milestone update from Phoenix Workforce.',
  now(),
  'B-10'
)
on conflict (notification_type) do nothing;

commit;
