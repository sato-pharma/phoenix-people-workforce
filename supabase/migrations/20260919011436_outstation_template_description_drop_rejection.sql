-- outstation_template_description_drop_rejection
--
-- WHAT THIS CHANGES: the admin-facing DESCRIPTION of the "Outstation / Expense" email template
--   (public.email_templates, template_key 'outstation') drops "and rejection (to the employee)".
--   One row, one text column plus updated_at. No subject, body, recipient rule or send changes.
-- WHY: owner rule 2026-09-19 — a rejected expense tells the employee in-app, never by email
--   (outstation-rejection-channel-guard.ts). The stored description still said the rejection is
--   emailed, and the stored row overrides the code default (mapTemplate in
--   src/lib/email-templates/service.ts reads row.description first), so fixing the code alone
--   would change nothing on screen.
--   Guarded on the EXACT old text: if an admin has since written their own description, it is
--   left alone and this updates zero rows.
-- ROLLBACK:
--   update public.email_templates
--      set description = 'Outstation and expense updates: submission (to the approver), approval, and rejection (to the employee).'
--    where template_key = 'outstation'
--      and description = 'Outstation and expense updates: submission (to the approver) and approval.';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

update public.email_templates
   set description = 'Outstation and expense updates: submission (to the approver) and approval.',
       updated_at = now()
 where template_key = 'outstation'
   and description = 'Outstation and expense updates: submission (to the approver), approval, and rejection (to the employee).';

commit;

-- Timestamp 20260919011436 was minted to sort after every migration already on main.
