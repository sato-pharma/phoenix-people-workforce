-- outstation_template_description_submission_only
--
-- WHAT THIS CHANGES: the admin-facing DESCRIPTION of the "Outstation / Expense" email template
--   (public.email_templates, template_key 'outstation') now names the one email it actually sends:
--   the submission notice, to the employee, copied to their manager. One row, one text column plus
--   updated_at. No subject, body, recipient rule or send changes.
-- WHY: owner, 2026-09-19 — "drop approval from the outstation template description too". An
--   approval sends no email (notifyOutstationDecision only handles a rejection, which is in-app
--   and never emailed), and the payroll-import notice is never called. The submission email goes
--   To the employee, Cc their manager, Bcc Super Admin (submit-recipients.ts, owner decision
--   2026-09-04), so "(to the approver)" was wrong as well; the owner chose to fix both at once.
--   The stored row overrides the code default (mapTemplate reads row.description first), so the
--   code change alone would change nothing on screen.
--   Guarded on the EXACT current text: if an admin has since written their own description, it is
--   left alone and this updates zero rows.
-- ROLLBACK:
--   update public.email_templates
--      set description = 'Outstation and expense updates: submission (to the approver) and approval.'
--    where template_key = 'outstation'
--      and description = 'Outstation and expense updates: submission (to the employee, copied to their manager).';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

update public.email_templates
   set description = 'Outstation and expense updates: submission (to the employee, copied to their manager).',
       updated_at = now()
 where template_key = 'outstation'
   and description = 'Outstation and expense updates: submission (to the approver) and approval.';

commit;

-- Timestamp 20260919012827 was minted to sort after every migration already on main.
