-- Recruitment / ATS module — workflow registry seed.
--
-- Registers the `recruitment` module so every requisition + application stage
-- transition is validated by assertWorkflowRegistryTransition (the same engine
-- that governs offers/contracts/probation). One module carries both the
-- requisition (req_*) and application lifecycles; actions keep them separate via
-- their from/to status lists.
--
-- Note: app_offer_accepted/declined/expired are server-side reflections of the
-- existing offer engine's status, so they are allowed to Super Admin / HR
-- Specialist only (the reconciliation runs under a system context). The
-- candidate-facing accept/reject still flows through the offers module's
-- Employee-role action — this module only mirrors the result.

insert into public.workflow_registry_modules (
  module_key,
  module_name,
  description,
  statuses,
  actions,
  is_active,
  created_by,
  updated_by
)
values
  (
    'recruitment',
    'Recruitment',
    'Requisition opening, candidate pipeline (screening, interviews, selection), offer launch/reflection, and hire-conversion workflow.',
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
      {"key":"application_withdrawn","label":"Application withdrawn","terminal":true}
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
      {"key":"app_to_interview_scheduling","label":"Move to interview scheduling","from":["cv_screening","phone_screening"],"to":"interview_scheduling","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":[],"notifications":[],"auditLog":"Interview scheduling started","tests":["scheduling from screening"]},
      {"key":"app_to_hr_interview","label":"Move to HR interview","from":["interview_scheduling"],"to":"hr_interview","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["notify interviewers"],"notifications":["notify interviewers"],"auditLog":"HR interview stage","tests":["hr interview from scheduling"]},
      {"key":"app_record_hr_interview","label":"Record HR interview","from":["hr_interview"],"to":"hiring_manager_interview","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["record hr interview outcome"],"notifications":["notify hiring manager"],"auditLog":"HR interview recorded","tests":["hr interview advances to manager"]},
      {"key":"app_record_hm_interview","label":"Record hiring manager interview","from":["hiring_manager_interview"],"to":"final_selection","allowedRoles":["Super Admin","HR Specialist","District Manager","Regional Manager","National Sales Manager","Manager","Product Manager","Group Product Manager","Marketing Manager"],"requiresReason":false,"sideEffects":["record manager interview outcome"],"notifications":["notify HR"],"auditLog":"Manager interview recorded","tests":["hiring manager can record interview"]},
      {"key":"app_select","label":"Select candidate for offer","from":["final_selection"],"to":"offer_initiated","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["mark selected for offer"],"notifications":[],"auditLog":"Candidate selected for offer","tests":["selection requires reason"]},
      {"key":"app_offer_sent","label":"Offer sent to candidate","from":["offer_initiated"],"to":"offer_sent","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["create offer via offer engine"],"notifications":["notify candidate"],"auditLog":"Offer sent","tests":["offer launches from selection"]},
      {"key":"app_offer_accepted","label":"Reflect offer acceptance","from":["offer_sent"],"to":"offer_accepted","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["reflect offer engine status"],"notifications":[],"auditLog":"Offer accepted","tests":["acceptance reflected from offer engine"]},
      {"key":"app_offer_declined","label":"Reflect offer decline","from":["offer_sent"],"to":"offer_declined","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["reflect offer engine status"],"notifications":[],"auditLog":"Offer declined","tests":["decline reflected from offer engine"]},
      {"key":"app_offer_expired","label":"Reflect offer expiry","from":["offer_sent"],"to":"offer_expired","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["reflect offer engine status"],"notifications":[],"auditLog":"Offer expired","tests":["expiry reflected from offer engine"]},
      {"key":"app_to_pre_boarding","label":"Move to pre-boarding","from":["offer_accepted"],"to":"pre_boarding","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["start pre-boarding"],"notifications":[],"auditLog":"Pre-boarding started","tests":["pre-boarding from accepted"]},
      {"key":"app_hire","label":"Approve hire and convert","from":["offer_accepted","pre_boarding"],"to":"hired","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":false,"sideEffects":["convert to employee via offer approval","fill requisition"],"notifications":["notify HR"],"auditLog":"Candidate hired","tests":["hire converts accepted offer"]},
      {"key":"app_reject","label":"Reject application","from":["in_candidate_pool","cv_screening","phone_screening","interview_scheduling","hr_interview","hiring_manager_interview","final_selection"],"to":"application_rejected","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["close application; candidate stays in pool"],"notifications":[],"auditLog":"Application rejected","tests":["rejection requires reason"]},
      {"key":"app_withdraw","label":"Withdraw application","from":["in_candidate_pool","cv_screening","phone_screening","interview_scheduling","hr_interview","hiring_manager_interview","final_selection","offer_sent"],"to":"application_withdrawn","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["candidate withdrew"],"notifications":[],"auditLog":"Application withdrawn","tests":["withdrawal requires reason"]}
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
