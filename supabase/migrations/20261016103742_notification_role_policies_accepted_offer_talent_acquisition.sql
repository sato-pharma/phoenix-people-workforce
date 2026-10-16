-- notification_role_policies: Talent Acquisition joins the accepted_offer_alert audience
--
-- WHAT THIS CHANGES: appends 'HR Resourcing' (the Talent Acquisition seat) to the roles of the one
-- row 'accepted_offer_alert', so she is told, in-app, by push and on Telegram, the moment a job offer
-- is marked accepted. The row's description is reworded to match the code default, but only while it
-- is still the text the 2026-10-02 seed wrote — an edit the owner made on the console is left alone.
-- WHY: owner instruction 2026-10-16 — the Talent Acquisition account's notification center should
-- show new CVs received, interview requests and accepted job offers. The first two already reach
-- her in code (the CV alert reads recruitmentAlertRoles; the interview-request notice now names her
-- seat); this is the third, whose audience is the admin-editable row below.
-- ROLLBACK:
--   update public.notification_role_policies
--      set roles = array_remove(roles, 'HR Resourcing')
--    where notification_key = 'accepted_offer_alert';
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: one row, one array element. Idempotent — a re-run changes
-- nothing, because the element is only appended while it is absent.

begin;

update public.notification_role_policies
   set roles = array_append(roles, 'HR Resourcing'),
       updated_at = now(),
       updated_by = 'migration:20261016103742'
 where notification_key = 'accepted_offer_alert'
   and not ('HR Resourcing' = any (roles));

update public.notification_role_policies
   set description = 'Who is told, in-app, by push and on Telegram, the moment a job offer is marked accepted, so the new hire can be seated. The notice carries the candidate''s name, the agreed start date and the seat the offer named, and links to the organogram where an accepted offer is now one press to hire. Defaults to Super Admin, HR Operations and Talent Acquisition — the owner''s choice, 2026-10-02, with Talent Acquisition added 2026-10-16.'
 where notification_key = 'accepted_offer_alert'
   and description = 'Who is told, in-app, by push and on Telegram, the moment a job offer is marked accepted, so the new hire can be seated. The notice carries the candidate''s name, the agreed start date and the seat the offer named, and links to the organogram where an accepted offer is now one press to hire. Defaults to Super Admin and HR Operations — the owner''s choice, 2026-10-02.';

commit;
