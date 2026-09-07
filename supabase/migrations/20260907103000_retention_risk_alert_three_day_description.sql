-- The retention-risk threshold moved from five consecutive working days to THREE, and the audience
-- row's description is what /admin/notification-recipients shows the owner when he opens it. Left
-- alone it would describe a rule the system no longer applies.
--
-- Owner, 2026-09-07: "if an employee not submitting any crm records for 3 days until the current
-- day or 3 vacation days until the current only be shown only for med reps".
--
-- WHY FIVE WAS TOO SLOW, measured rather than argued. The two reps the board caught that morning
-- had stopped working on 31 August. Counting from 1 September with the Friday bridged, the fifth
-- working day was the 6th, so the earliest the sweep could speak was 07:40 on the 7th — and HR
-- recorded both resignations at 03:37 that same morning. The warning lost to the paperwork by four
-- hours. At three days it would have spoken on the 5th.
--
-- An UPDATE, not a re-seed: 20260907061500 is already applied and is the record of what the
-- constraint and the row looked like when it ran. Editing an applied migration rewrites history.
--
-- Byte-matched to DEFAULT_NOTIFICATION_ROLE_POLICIES in role-recipients.ts, which is also the
-- fallback the read path uses when the row is missing — so the two cannot disagree. Roles and
-- `enabled` are deliberately untouched: the owner picked those four and nothing here changes them.
begin;

update public.notification_role_policies
   set description = 'Who is told when a MEDICAL REP reaches three consecutive working days of recorded leave, or three consecutive working days with no CRM entry of any kind, and has not been seen since (owner, 2026-09-07: medical reps only, three days, still away). Defaults to HR Operations, HR Advisory, Super Admin and SFE Manager — the owner picked all four on 2026-09-06. The person''s own line manager is added per alert by the sweep itself and is deliberately NOT a role here: it is one named manager per subject, not everyone holding a manager role.'
 where notification_key = 'retention_risk_alert';

commit;
