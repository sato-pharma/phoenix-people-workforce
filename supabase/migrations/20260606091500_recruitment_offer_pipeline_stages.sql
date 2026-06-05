-- Recruitment Offer Pipeline (M4) — application stages + recruitment registry.
--
-- Mirrors the offers pipeline onto the recruitment application: adds the 5 new
-- NON-terminal stages (offer_draft, offer_pending_approval, offer_approved,
-- offer_generated, offer_negotiation), widens the stage CHECK, and re-upserts the
-- recruitment module with the 6 new app_offer_* actions. Extends app_offer_sent.from
-- with offer_generated (so a generated offer can be sent). Additive + idempotent.
-- Lockstep: src/lib/recruitment/types.ts (applicationStages / recruitmentActionKeys).

alter table public.recruitment_applications
  drop constraint if exists recruitment_applications_stage_check;
alter table public.recruitment_applications
  add constraint recruitment_applications_stage_check
  check (stage in (
    'application_received', 'in_candidate_pool', 'cv_screening', 'phone_screening',
    'interview_scheduling', 'hr_interview', 'hiring_manager_interview', 'final_selection',
    'offer_initiated', 'offer_sent', 'offer_accepted', 'offer_declined', 'offer_expired',
    'pre_boarding', 'hired', 'application_rejected', 'application_withdrawn',
    'shortlisted', 'on_hold', 'no_response', 'call_back',
    'manager_interview_completed', 'backup_candidate',
    'offer_draft', 'offer_pending_approval', 'offer_approved', 'offer_generated', 'offer_negotiation'
  ));

insert into public.workflow_registry_modules (
  module_key, module_name, description, statuses, actions, is_active, created_by, updated_by
)
values
  (
    'recruitment',
    'Recruitment',
    'Requisition opening, candidate pipeline (screening, interviews, selection), staged offer pipeline (prepare, approval chain, generation, send, negotiation), offer launch/reflection, and hire-conversion workflow.',
    '[
      {"key":"req_draft","label":"Requisition draft","terminal":false},
      {"key":"req_open","label":"Recruitment open","terminal":false},
      {"key":"req_published","label":"Published","terminal":false},
      {"key":"req_on_hold","label":"On hold","terminal":false},
      {"key":"req_filled","label":"Filled","terminal":true},
      {"key":"req_closed","label":"Closed","terminal":true},
      {"key":"req_cancelled","label":"Cancelled","terminal":true},
      {"key":"application_received","label":"Application received","terminal":false},
      {"key":"in_candidate_pool","label":"In candidate pool","terminal":false},
      {"key":"cv_screening","label":"CV screening","terminal":false},
      {"key":"phone_screening","label":"Phone screening","terminal":false},
      {"key":"interview_scheduling","label":"Interview scheduling","terminal":false},
      {"key":"hr_interview","label":"HR interview","terminal":false},
      {"key":"hiring_manager_interview","label":"Hiring manager interview","terminal":false},
      {"key":"final_selection","label":"Final selection","terminal":false},
      {"key":"offer_initiated","label":"Offer initiated","terminal":false},
      {"key":"offer_sent","label":"Offer sent","terminal":false},
      {"key":"offer_accepted","label":"Offer accepted","terminal":false},
      {"key":"offer_declined","label":"Offer declined","terminal":true},
      {"key":"offer_expired","label":"Offer expired","terminal":true},
      {"key":"pre_boarding","label":"Pre-boarding","terminal":false},
      {"key":"hired","label":"Hired","terminal":true},
      {"key":"application_rejected","label":"Application rejected","terminal":true},
      {"key":"application_withdrawn","label":"Application withdrawn","terminal":true},
      {"key":"shortlisted","label":"Shortlisted","terminal":false},
      {"key":"on_hold","label":"On hold","terminal":false},
      {"key":"no_response","label":"No response","terminal":false},
      {"key":"call_back","label":"Call back","terminal":false},
      {"key":"manager_interview_completed","label":"Manager interview completed","terminal":false},
      {"key":"backup_candidate","label":"Backup candidate","terminal":false},
      {"key":"offer_draft","label":"Offer draft","terminal":false},
      {"key":"offer_pending_approval","label":"Offer pending approval","terminal":false},
      {"key":"offer_approved","label":"Offer approved","terminal":false},
      {"key":"offer_generated","label":"Offer generated","terminal":false},
      {"key":"offer_negotiation","label":"Offer negotiation","terminal":false}
    ]'::jsonb,
    '[
      {"key":"req_open","label":"Open recruitment","from":["req_draft"],"to":"req_open","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["inherit vacancy details"],"notifications":["notify recruitment owner"],"auditLog":"Recruitment opened","tests":["requisition opens from draft"]},
      {"key":"req_publish","label":"Publish vacancy","from":["req_open"],"to":"req_published","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["mark requisition published"],"notifications":[],"auditLog":"Requisition published","tests":["requisition publishes from open"]},
      {"key":"req_hold","label":"Put recruitment on hold","from":["req_open","req_published"],"to":"req_on_hold","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["pause recruitment"],"notifications":[],"auditLog":"Recruitment on hold","tests":["hold requires reason"]},
      {"key":"req_resume","label":"Resume recruitment","from":["req_on_hold"],"to":"req_open","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["resume recruitment"],"notifications":[],"auditLog":"Recruitment resumed","tests":["resume returns to open"]},
      {"key":"req_fill","label":"Mark requisition filled","from":["req_open","req_published","req_on_hold"],"to":"req_filled","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["close requisition on hire"],"notifications":[],"auditLog":"Requisition filled","tests":["hire fills requisition"]},
      {"key":"req_close","label":"Close recruitment","from":["req_open","req_published","req_on_hold"],"to":"req_closed","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["close requisition"],"notifications":[],"auditLog":"Recruitment closed","tests":["close requires reason"]},
      {"key":"req_cancel","label":"Cancel recruitment","from":["req_draft","req_open","req_published","req_on_hold"],"to":"req_cancelled","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["cancel requisition"],"notifications":[],"auditLog":"Recruitment cancelled","tests":["cancel requires reason"]},
      {"key":"app_add","label":"Add candidate to pool","from":["application_received"],"to":"in_candidate_pool","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["attach candidate record"],"notifications":[],"auditLog":"Candidate added to pool","tests":["application enters pool"]},
      {"key":"app_to_cv_screen","label":"Start CV screening","from":["in_candidate_pool"],"to":"cv_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":[],"notifications":[],"auditLog":"CV screening started","tests":["screening starts from pool"]},
      {"key":"app_to_phone_screen","label":"Move to phone screening","from":["cv_screening"],"to":"phone_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":[],"notifications":[],"auditLog":"Phone screening started","tests":["phone screening from cv screening"]},
      {"key":"app_to_interview_scheduling","label":"Move to interview scheduling","from":["cv_screening","phone_screening","shortlisted"],"to":"interview_scheduling","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":[],"notifications":[],"auditLog":"Interview scheduling started","tests":["scheduling from screening"]},
      {"key":"app_to_hr_interview","label":"Move to HR interview","from":["interview_scheduling"],"to":"hr_interview","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["notify interviewers"],"notifications":["notify interviewers"],"auditLog":"HR interview stage","tests":["hr interview from scheduling"]},
      {"key":"app_record_hr_interview","label":"Record HR interview","from":["hr_interview"],"to":"hiring_manager_interview","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["record hr interview outcome"],"notifications":["notify hiring manager"],"auditLog":"HR interview recorded","tests":["hr interview advances to manager"]},
      {"key":"app_record_hm_interview","label":"Record hiring manager interview","from":["hiring_manager_interview"],"to":"manager_interview_completed","allowedRoles":["Super Admin","HR Specialist","District Manager","Regional Manager","National Sales Manager","Manager","Product Manager","Group Product Manager","Marketing Manager"],"requiresReason":false,"sideEffects":["record manager interview outcome"],"notifications":["notify HR"],"auditLog":"Manager interview recorded","tests":["hiring manager can record interview"]},
      {"key":"app_mgr_completed_to_final","label":"Move to final selection","from":["manager_interview_completed"],"to":"final_selection","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":[],"notifications":[],"auditLog":"Advanced to final selection","tests":["manager completed to final selection"]},
      {"key":"app_select","label":"Select candidate for offer","from":["final_selection"],"to":"offer_initiated","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["mark selected for offer"],"notifications":[],"auditLog":"Candidate selected for offer","tests":["selection requires reason"]},
      {"key":"app_to_backup","label":"Mark as backup candidate","from":["final_selection"],"to":"backup_candidate","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["hold candidate in reserve"],"notifications":[],"auditLog":"Marked backup candidate","tests":["backup from final selection"]},
      {"key":"app_backup_to_offer","label":"Activate backup for offer","from":["backup_candidate"],"to":"offer_initiated","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["activate backup candidate"],"notifications":["notify HR"],"auditLog":"Backup activated for offer","tests":["backup activated to offer"]},
      {"key":"app_offer_prepare","label":"Prepare offer draft","from":["offer_initiated","offer_negotiation"],"to":"offer_draft","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["create draft offer from requisition"],"notifications":[],"auditLog":"Offer draft prepared","tests":["offer draft prepared from selection"]},
      {"key":"app_offer_submit_approval","label":"Submit offer for approval","from":["offer_draft"],"to":"offer_pending_approval","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["seed approval chain"],"notifications":["notify approvers"],"auditLog":"Offer submitted for approval","tests":["draft submitted for approval"]},
      {"key":"app_offer_approved","label":"Offer approved by chain","from":["offer_pending_approval"],"to":"offer_approved","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["mark offer approved"],"notifications":["notify HR"],"auditLog":"Offer approved","tests":["pending approval advances to approved"]},
      {"key":"app_offer_approval_rejected","label":"Offer approval rejected","from":["offer_pending_approval"],"to":"offer_draft","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["return offer to draft"],"notifications":["notify HR"],"auditLog":"Offer approval rejected","tests":["rejected approval returns to draft"]},
      {"key":"app_offer_generated","label":"Generate offer documents","from":["offer_approved"],"to":"offer_generated","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["render offer letter + salary summary"],"notifications":[],"auditLog":"Offer documents generated","tests":["approved offer is generated"]},
      {"key":"app_offer_negotiation","label":"Candidate negotiation","from":["offer_sent"],"to":"offer_negotiation","allowedRoles":["Super Admin","HR Specialist","Employee"],"requiresReason":false,"sideEffects":["flag offer for renegotiation"],"notifications":["notify HR"],"auditLog":"Offer negotiation requested","tests":["sent offer can enter negotiation"]},
      {"key":"app_offer_sent","label":"Offer sent to candidate","from":["offer_initiated","offer_generated"],"to":"offer_sent","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["create offer via offer engine"],"notifications":["notify candidate"],"auditLog":"Offer sent","tests":["offer launches from selection"]},
      {"key":"app_offer_accepted","label":"Reflect offer acceptance","from":["offer_sent"],"to":"offer_accepted","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["reflect offer engine status"],"notifications":[],"auditLog":"Offer accepted","tests":["acceptance reflected from offer engine"]},
      {"key":"app_offer_declined","label":"Reflect offer decline","from":["offer_sent"],"to":"offer_declined","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["reflect offer engine status"],"notifications":[],"auditLog":"Offer declined","tests":["decline reflected from offer engine"]},
      {"key":"app_offer_expired","label":"Reflect offer expiry","from":["offer_sent"],"to":"offer_expired","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["reflect offer engine status"],"notifications":[],"auditLog":"Offer expired","tests":["expiry reflected from offer engine"]},
      {"key":"app_to_pre_boarding","label":"Move to pre-boarding","from":["offer_accepted"],"to":"pre_boarding","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["start pre-boarding"],"notifications":[],"auditLog":"Pre-boarding started","tests":["pre-boarding from accepted"]},
      {"key":"app_hire","label":"Approve hire and convert","from":["offer_accepted","pre_boarding"],"to":"hired","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["convert to employee via offer approval","fill requisition"],"notifications":["notify HR"],"auditLog":"Candidate hired","tests":["hire converts accepted offer"]},
      {"key":"app_reject","label":"Reject application","from":["in_candidate_pool","cv_screening","phone_screening","interview_scheduling","hr_interview","hiring_manager_interview","final_selection","shortlisted","on_hold","no_response","call_back","manager_interview_completed","backup_candidate"],"to":"application_rejected","allowedRoles":["Super Admin","HR Specialist","District Manager","Regional Manager","National Sales Manager","Manager","Product Manager","Group Product Manager","Marketing Manager"],"requiresReason":true,"sideEffects":["close application; candidate stays in pool"],"notifications":[],"auditLog":"Application rejected","tests":["rejection requires reason"]},
      {"key":"app_withdraw","label":"Withdraw application","from":["in_candidate_pool","cv_screening","phone_screening","interview_scheduling","hr_interview","hiring_manager_interview","final_selection","offer_sent","shortlisted","on_hold","no_response","call_back","manager_interview_completed","backup_candidate"],"to":"application_withdrawn","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["candidate withdrew"],"notifications":[],"auditLog":"Application withdrawn","tests":["withdrawal requires reason"]},
      {"key":"app_cv_shortlist","label":"Shortlist from CV screening","from":["cv_screening"],"to":"shortlisted","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["record cv screening outcome"],"notifications":[],"auditLog":"Candidate shortlisted","tests":["shortlist from cv screening"]},
      {"key":"app_shortlist_to_scheduling","label":"Move shortlisted to interview scheduling","from":["shortlisted"],"to":"interview_scheduling","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":[],"notifications":[],"auditLog":"Shortlisted to scheduling","tests":["shortlisted advances to scheduling"]},
      {"key":"app_hold","label":"Put screening on hold","from":["cv_screening","phone_screening","hiring_manager_interview"],"to":"on_hold","allowedRoles":["Super Admin","HR Specialist","District Manager","Regional Manager","National Sales Manager","Manager","Product Manager","Group Product Manager","Marketing Manager"],"requiresReason":true,"sideEffects":["pause screening"],"notifications":[],"auditLog":"Screening on hold","tests":["hold requires reason"]},
      {"key":"app_resume_from_hold_to_cv","label":"Resume on-hold to CV screening","from":["on_hold"],"to":"cv_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["resume screening"],"notifications":[],"auditLog":"Resumed to CV screening","tests":["resume from hold to cv"]},
      {"key":"app_resume_from_hold_to_phone","label":"Resume on-hold to phone screening","from":["on_hold"],"to":"phone_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["resume screening"],"notifications":[],"auditLog":"Resumed to phone screening","tests":["resume from hold to phone"]},
      {"key":"app_resume_from_hold_to_hm","label":"Resume on-hold to hiring manager interview","from":["on_hold"],"to":"hiring_manager_interview","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["resume screening"],"notifications":[],"auditLog":"Resumed to hiring manager interview","tests":["resume from hold to hm"]},
      {"key":"app_no_response","label":"Mark no response","from":["phone_screening"],"to":"no_response","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["record no response"],"notifications":[],"auditLog":"No response","tests":["no response from phone"]},
      {"key":"app_resume_from_no_response","label":"Retry phone after no response","from":["no_response"],"to":"phone_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["retry phone screening"],"notifications":[],"auditLog":"Retry phone screening","tests":["resume from no response"]},
      {"key":"app_call_back","label":"Mark call back","from":["cv_screening","phone_screening"],"to":"call_back","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["schedule call back"],"notifications":[],"auditLog":"Call back","tests":["call back from screening"]},
      {"key":"app_resume_from_call_back_to_cv","label":"Resume call-back to CV screening","from":["call_back"],"to":"cv_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["resume screening"],"notifications":[],"auditLog":"Resumed to CV screening","tests":["resume from call back to cv"]},
      {"key":"app_resume_from_call_back_to_phone","label":"Resume call-back to phone screening","from":["call_back"],"to":"phone_screening","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["resume screening"],"notifications":[],"auditLog":"Resumed to phone screening","tests":["resume from call back to phone"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  )
on conflict (module_key) do update
set
  module_name = excluded.module_name,
  description = excluded.description,
  statuses = excluded.statuses,
  actions = excluded.actions,
  is_active = excluded.is_active,
  updated_by = 'system';

notify pgrst, 'reload schema';
