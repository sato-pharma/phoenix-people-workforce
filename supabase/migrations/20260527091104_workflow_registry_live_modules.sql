update public.workflow_registry_modules
set
  statuses = '[
    {"key":"draft","label":"Draft","terminal":false},
    {"key":"pending","label":"Pending Approval","terminal":false},
    {"key":"approved","label":"Approved","terminal":false},
    {"key":"rejected","label":"Rejected","terminal":true},
    {"key":"added_to_payroll","label":"Added to Payroll","terminal":true}
  ]'::jsonb,
  actions = '[
    {"key":"submit","label":"Submit expense","from":["draft"],"to":"pending","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Manager","Super Admin","HR Specialist","Finance Manager","CEO"],"sideEffects":["capture employee, trip, GPS, and calculated amount"],"notifications":["notify approvers when request is pending"],"auditLog":"Expense submitted","tests":["employee can submit live expense","submitted expense remains outside payroll until approval"]},
    {"key":"approve","label":"Approve expense","from":["pending"],"to":"approved","allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],"sideEffects":["set approved_by and approved_at","make expense eligible for manual payroll import"],"notifications":["notify employee that expense was approved"],"auditLog":"Expense approved","tests":["only authorized roles can approve","approval does not automatically add to payroll"]},
    {"key":"reject","label":"Reject expense","from":["pending"],"to":"rejected","allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],"sideEffects":["store rejection reason"],"notifications":["notify employee that expense was rejected"],"auditLog":"Expense rejected","tests":["rejected expense is excluded from payroll import"]},
    {"key":"reject_before_payroll","label":"Reject approved expense before payroll","from":["approved"],"to":"rejected","allowedRoles":["Super Admin","HR Specialist","Finance Manager","CEO"],"sideEffects":["remove pending payroll expense row","store rejection reason"],"notifications":["notify employee that expense approval was revoked"],"auditLog":"Approved expense rejected before payroll","tests":["approved expense can be rejected before payroll import","payroll locked expense cannot be rejected"]},
    {"key":"edit_before_payroll","label":"Edit before payroll","from":["draft","pending","approved","rejected"],"to":"unchanged","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["recalculate linked expense before payroll lock"],"notifications":["optional employee/admin notification"],"auditLog":"Expense edited before payroll","tests":["payroll locked expense cannot be edited"]},
    {"key":"add_to_payroll","label":"Add to payroll","from":["approved"],"to":"added_to_payroll","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["lock edit/delete","link expense to payroll run"],"notifications":["optional payroll completion notification"],"auditLog":"Expense added to payroll","tests":["expense cannot be deleted after payroll import"]},
    {"key":"delete_before_payroll","label":"Delete before payroll","from":["draft","pending","approved","rejected"],"to":"deleted","allowedRoles":["Super Admin","HR Specialist","Finance Manager"],"sideEffects":["remove or soft-delete expense before payroll lock"],"notifications":["optional employee/admin notification"],"auditLog":"Expense deleted before payroll","tests":["approved expense can be deleted before payroll","payroll locked expense cannot be deleted"]}
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'outstation_expenses';

update public.workflow_registry_modules
set
  statuses = '[
    {"key":"draft","label":"Draft","terminal":false},
    {"key":"pending_manager","label":"Pending Manager","terminal":false},
    {"key":"pending_hr","label":"Pending HR","terminal":false},
    {"key":"approved","label":"Approved","terminal":true},
    {"key":"rejected","label":"Rejected","terminal":true},
    {"key":"cancelled","label":"Cancelled","terminal":true}
  ]'::jsonb,
  actions = '[
    {"key":"submit","label":"Submit leave","from":["draft"],"to":"pending_manager","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Manager","CEO","HR Specialist","Super Admin"],"sideEffects":["reserve requested dates"],"notifications":["notify manager or HR"],"auditLog":"Leave request submitted","tests":["employee can submit leave request"]},
    {"key":"manager_approve","label":"Manager approve","from":["pending_manager"],"to":"pending_hr","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Manager","CEO","HR Specialist","Super Admin"],"sideEffects":["capture manager approval"],"notifications":["notify HR"],"auditLog":"Leave manager approved","tests":["manager approval moves leave to HR"]},
    {"key":"manager_reject","label":"Manager reject","from":["pending_manager"],"to":"pending_hr","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Manager","CEO","HR Specialist","Super Admin"],"sideEffects":["capture manager rejection reason"],"notifications":["notify HR"],"auditLog":"Leave manager rejected","tests":["manager rejection moves leave to HR"]},
    {"key":"hr_approve","label":"HR approve","from":["pending_hr"],"to":"approved","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["consume leave balance"],"notifications":["notify employee"],"auditLog":"Leave HR approved","tests":["HR approval finalizes leave"]},
    {"key":"hr_reject","label":"HR reject","from":["pending_hr"],"to":"rejected","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["release reserved days"],"notifications":["notify employee"],"auditLog":"Leave HR rejected","tests":["HR rejection does not consume leave balance"]},
    {"key":"admin_create","label":"Admin create leave","from":["draft"],"to":"unchanged","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create leave record on behalf of employee"],"notifications":["optional employee notification"],"auditLog":"Leave admin created","tests":["admin-created leave is audited"]},
    {"key":"admin_update","label":"Admin update leave","from":["draft","pending_manager","pending_hr","approved","rejected","cancelled"],"to":"unchanged","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["update leave record"],"notifications":["optional employee notification"],"auditLog":"Leave admin updated","tests":["admin update is registry-controlled"]},
    {"key":"admin_delete","label":"Admin delete leave","from":["draft","pending_manager","pending_hr","approved","rejected","cancelled"],"to":"deleted","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["remove leave record"],"notifications":["optional employee notification"],"auditLog":"Leave admin deleted","tests":["admin delete is registry-controlled"]}
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'leave_requests';

update public.workflow_registry_modules
set
  statuses = '[
    {"key":"resignation_new","label":"Resignation New","terminal":false},
    {"key":"resignation_submitted","label":"Resignation Submitted","terminal":false},
    {"key":"resignation_under_review","label":"Resignation Under Review","terminal":false},
    {"key":"resignation_approved","label":"Resignation Approved","terminal":false},
    {"key":"resignation_rejected","label":"Resignation Rejected","terminal":true},
    {"key":"resignation_completed","label":"Resignation Completed","terminal":true},
    {"key":"resignation_cancelled","label":"Resignation Cancelled","terminal":true},
    {"key":"probation_new","label":"Probation New","terminal":false},
    {"key":"probation_evaluation_requested","label":"Probation Evaluation Requested","terminal":false},
    {"key":"probation_manager_feedback","label":"Probation Manager Feedback","terminal":false},
    {"key":"probation_passed","label":"Probation Passed","terminal":true},
    {"key":"probation_terminated","label":"Probation Terminated","terminal":true},
    {"key":"probation_extended","label":"Probation Extended","terminal":false},
    {"key":"probation_cancelled","label":"Probation Cancelled","terminal":true},
    {"key":"contract_new","label":"Contract New","terminal":false},
    {"key":"contract_requested","label":"Contract Requested","terminal":false},
    {"key":"contract_manager_review","label":"Contract Manager Review","terminal":false},
    {"key":"contract_hr_review","label":"Contract HR Review","terminal":false},
    {"key":"contract_renewed","label":"Contract Renewed","terminal":true},
    {"key":"contract_not_renewed","label":"Contract Not Renewed","terminal":true},
    {"key":"contract_cancelled","label":"Contract Cancelled","terminal":true},
    {"key":"offer_draft","label":"Offer Draft","terminal":false},
    {"key":"offer_sent","label":"Offer Sent","terminal":false},
    {"key":"offer_accepted","label":"Offer Accepted","terminal":false},
    {"key":"offer_rejected","label":"Offer Rejected","terminal":true},
    {"key":"offer_expired","label":"Offer Expired","terminal":true},
    {"key":"offer_hired","label":"Offer Hired","terminal":true}
  ]'::jsonb,
  actions = '[
    {"key":"resignation_submit","label":"Submit resignation","from":["resignation_new"],"to":"resignation_submitted","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Manager","HR Specialist","Super Admin"],"sideEffects":["create resignation record"],"notifications":["notify HR"],"auditLog":"Resignation submitted","tests":["resignation submit is registry-controlled"]},
    {"key":"resignation_mark_review","label":"Mark resignation under review","from":["resignation_submitted","resignation_under_review","resignation_approved","resignation_rejected","resignation_cancelled"],"to":"resignation_under_review","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["capture reviewer"],"notifications":["notify stakeholders"],"auditLog":"Resignation under review","tests":["completed resignation cannot be reviewed"]},
    {"key":"resignation_approve","label":"Approve resignation","from":["resignation_submitted","resignation_under_review"],"to":"resignation_approved","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["capture approval"],"notifications":["notify stakeholders"],"auditLog":"Resignation approved","tests":["only submitted or under-review resignations can be approved"]},
    {"key":"resignation_reject","label":"Reject resignation","from":["resignation_submitted","resignation_under_review","resignation_approved","resignation_rejected","resignation_cancelled"],"to":"resignation_rejected","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["store rejection reason"],"notifications":["notify stakeholders"],"auditLog":"Resignation rejected","tests":["completed resignation cannot be rejected"]},
    {"key":"resignation_complete","label":"Complete resignation","from":["resignation_approved"],"to":"resignation_completed","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["finalize employee lifecycle"],"notifications":["notify payroll and HR"],"auditLog":"Resignation completed","tests":["only approved resignation can be completed"]},
    {"key":"resignation_cancel","label":"Cancel resignation","from":["resignation_submitted","resignation_under_review","resignation_approved","resignation_rejected","resignation_cancelled"],"to":"resignation_cancelled","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["cancel resignation workflow"],"notifications":["notify stakeholders"],"auditLog":"Resignation cancelled","tests":["completed resignation cannot be cancelled"]},
    {"key":"resignation_reopen","label":"Reopen resignation","from":["resignation_rejected","resignation_cancelled","resignation_approved"],"to":"resignation_under_review","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["clear rejection and reopen review"],"notifications":["notify stakeholders"],"auditLog":"Resignation reopened","tests":["only closed non-completed resignation can be reopened"]},
    {"key":"probation_create","label":"Create probation evaluation","from":["probation_new"],"to":"probation_evaluation_requested","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create probation evaluation"],"notifications":["notify manager"],"auditLog":"Probation evaluation created","tests":["open probation evaluation is unique per employee"]},
    {"key":"probation_manager_feedback","label":"Submit probation manager feedback","from":["probation_evaluation_requested","probation_manager_feedback"],"to":"probation_manager_feedback","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Manager","Super Admin","HR Specialist"],"sideEffects":["record manager feedback"],"notifications":["notify HR"],"auditLog":"Probation manager feedback submitted","tests":["manager feedback is required"]},
    {"key":"probation_pass","label":"Pass probation","from":["probation_evaluation_requested","probation_manager_feedback"],"to":"probation_passed","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["complete probation as passed"],"notifications":["notify employee and manager"],"auditLog":"Probation passed","tests":["final probation decision blocks later changes"]},
    {"key":"probation_terminate","label":"Terminate probation","from":["probation_evaluation_requested","probation_manager_feedback"],"to":"probation_terminated","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["complete probation and open resignation/vacancy flow"],"notifications":["notify HR"],"auditLog":"Probation terminated","tests":["termination requires decision reason"]},
    {"key":"contract_create","label":"Create contract renewal request","from":["contract_new"],"to":"contract_requested","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create renewal request"],"notifications":["notify contract reviewers"],"auditLog":"Contract renewal requested","tests":["contract request has valid dates"]},
    {"key":"contract_manager_review","label":"Manager contract review","from":["contract_requested","contract_manager_review"],"to":"contract_manager_review","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Manager","CEO","Super Admin","HR Specialist"],"sideEffects":["capture manager review"],"notifications":["notify HR"],"auditLog":"Contract manager reviewed","tests":["manager review stays active"]},
    {"key":"contract_hr_review","label":"HR contract review","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_hr_review","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["capture HR review"],"notifications":["notify stakeholders"],"auditLog":"Contract HR reviewed","tests":["HR review is registry-controlled"]},
    {"key":"contract_renew","label":"Renew contract","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_renewed","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["create or update employee contract"],"notifications":["notify employee"],"auditLog":"Contract renewed","tests":["renewal writes completed contract"]},
    {"key":"contract_not_renew","label":"Do not renew contract","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_not_renewed","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["close renewal without new contract"],"notifications":["notify stakeholders"],"auditLog":"Contract not renewed","tests":["not-renew decision is final"]},
    {"key":"contract_upload_signed","label":"Upload signed contract","from":["contract_hr_review","contract_renewed"],"to":"unchanged","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["attach signed contract"],"notifications":["optional employee notification"],"auditLog":"Signed contract uploaded","tests":["signed contract URL is required"]},
    {"key":"contract_cancel","label":"Cancel contract renewal","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_cancelled","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["cancel renewal workflow"],"notifications":["notify stakeholders"],"auditLog":"Contract renewal cancelled","tests":["active contract renewal can be cancelled"]},
    {"key":"offer_create","label":"Create and send offer","from":["offer_draft"],"to":"offer_sent","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["send offer email"],"notifications":["notify candidate"],"auditLog":"Offer sent","tests":["offer creation is registry-controlled"]},
    {"key":"offer_candidate_accept","label":"Candidate accepts offer","from":["offer_sent"],"to":"offer_accepted","allowedRoles":["Employee"],"sideEffects":["move onboarding to pending HR approval"],"notifications":["notify HR"],"auditLog":"Offer accepted","tests":["accepted offer waits for HR approval"]},
    {"key":"offer_candidate_reject","label":"Candidate rejects offer","from":["offer_sent"],"to":"offer_rejected","allowedRoles":["Employee"],"sideEffects":["close offer"],"notifications":["notify HR"],"auditLog":"Offer rejected","tests":["rejected offer is final"]},
    {"key":"offer_expire","label":"Expire offer","from":["offer_sent"],"to":"offer_expired","allowedRoles":["Employee","Super Admin"],"sideEffects":["close expired offer"],"notifications":["optional HR notification"],"auditLog":"Offer expired","tests":["expired offer cannot be accepted"]},
    {"key":"offer_hire_approve","label":"Approve accepted offer as hire","from":["offer_accepted"],"to":"offer_hired","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create employee and close vacancy"],"notifications":["notify HR"],"auditLog":"Offer approved as hired","tests":["only accepted offers can be approved"]}
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'employee_lifecycle';

update public.workflow_registry_modules
set
  module_name = 'Employee Lifecycle (deprecated)',
  description = 'Deprecated combined registry module. Live employee lifecycle enforcement is split into Resignations, Probation, Contracts, and Offers.',
  is_active = false,
  updated_by = 'system'
where module_key = 'employee_lifecycle';

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
    'resignations',
    'Resignations',
    'Employee resignation submission, review, approval, completion, cancellation, and reopen workflow.',
    '[
      {"key":"resignation_new","label":"New resignation","terminal":false},
      {"key":"resignation_submitted","label":"Submitted","terminal":false},
      {"key":"resignation_under_review","label":"Under review","terminal":false},
      {"key":"resignation_approved","label":"Approved","terminal":false},
      {"key":"resignation_rejected","label":"Rejected","terminal":true},
      {"key":"resignation_completed","label":"Completed","terminal":true},
      {"key":"resignation_cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"resignation_submit","label":"Employee/HR submits resignation","from":["resignation_new"],"to":"resignation_submitted","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Manager","HR Specialist","Super Admin"],"sideEffects":["create resignation record"],"notifications":["notify HR"],"auditLog":"Resignation submitted","tests":["resignation submit is registry-controlled"]},
      {"key":"resignation_mark_review","label":"HR starts review","from":["resignation_submitted","resignation_under_review","resignation_approved","resignation_rejected","resignation_cancelled"],"to":"resignation_under_review","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["capture reviewer"],"notifications":["notify stakeholders"],"auditLog":"Resignation under review","tests":["completed resignation cannot be reviewed"]},
      {"key":"resignation_approve","label":"HR approves resignation","from":["resignation_submitted","resignation_under_review"],"to":"resignation_approved","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["capture approval"],"notifications":["notify stakeholders"],"auditLog":"Resignation approved","tests":["only submitted or under-review resignations can be approved"]},
      {"key":"resignation_reject","label":"HR rejects resignation","from":["resignation_submitted","resignation_under_review","resignation_approved","resignation_rejected","resignation_cancelled"],"to":"resignation_rejected","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["store rejection reason"],"notifications":["notify stakeholders"],"auditLog":"Resignation rejected","tests":["completed resignation cannot be rejected"]},
      {"key":"resignation_complete","label":"HR completes resignation","from":["resignation_approved"],"to":"resignation_completed","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["finalize employee lifecycle"],"notifications":["notify payroll and HR"],"auditLog":"Resignation completed","tests":["only approved resignation can be completed"]},
      {"key":"resignation_cancel","label":"HR cancels resignation","from":["resignation_submitted","resignation_under_review","resignation_approved","resignation_rejected","resignation_cancelled"],"to":"resignation_cancelled","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["cancel resignation workflow"],"notifications":["notify stakeholders"],"auditLog":"Resignation cancelled","tests":["completed resignation cannot be cancelled"]},
      {"key":"resignation_reopen","label":"HR reopens resignation","from":["resignation_rejected","resignation_cancelled","resignation_approved"],"to":"resignation_under_review","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["clear rejection and reopen review"],"notifications":["notify stakeholders"],"auditLog":"Resignation reopened","tests":["only closed non-completed resignation can be reopened"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'probation',
    'Probation',
    'Probation evaluation creation, manager feedback, pass, and termination workflow.',
    '[
      {"key":"probation_new","label":"New evaluation","terminal":false},
      {"key":"probation_evaluation_requested","label":"Evaluation requested","terminal":false},
      {"key":"probation_manager_feedback","label":"Manager feedback","terminal":false},
      {"key":"probation_passed","label":"Passed","terminal":true},
      {"key":"probation_terminated","label":"Terminated","terminal":true},
      {"key":"probation_extended","label":"Extended","terminal":false},
      {"key":"probation_cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"probation_create","label":"HR creates probation evaluation","from":["probation_new"],"to":"probation_evaluation_requested","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create probation evaluation"],"notifications":["notify manager"],"auditLog":"Probation evaluation created","tests":["open probation evaluation is unique per employee"]},
      {"key":"probation_manager_feedback","label":"Manager submits feedback","from":["probation_evaluation_requested","probation_manager_feedback"],"to":"probation_manager_feedback","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Manager","Super Admin","HR Specialist"],"sideEffects":["record manager feedback"],"notifications":["notify HR"],"auditLog":"Probation manager feedback submitted","tests":["manager feedback is required"]},
      {"key":"probation_pass","label":"HR passes probation","from":["probation_evaluation_requested","probation_manager_feedback"],"to":"probation_passed","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["complete probation as passed"],"notifications":["notify employee and manager"],"auditLog":"Probation passed","tests":["final probation decision blocks later changes"]},
      {"key":"probation_terminate","label":"HR terminates probation","from":["probation_evaluation_requested","probation_manager_feedback"],"to":"probation_terminated","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["complete probation and open resignation/vacancy flow"],"notifications":["notify HR"],"auditLog":"Probation terminated","tests":["termination requires decision reason"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'contracts',
    'Contracts',
    'Contract renewal request, manager review, HR review, renewal, non-renewal, signed upload, and cancellation workflow.',
    '[
      {"key":"contract_new","label":"New request","terminal":false},
      {"key":"contract_requested","label":"Requested","terminal":false},
      {"key":"contract_manager_review","label":"Manager review","terminal":false},
      {"key":"contract_hr_review","label":"HR review","terminal":false},
      {"key":"contract_renewed","label":"Renewed","terminal":true},
      {"key":"contract_not_renewed","label":"Not renewed","terminal":true},
      {"key":"contract_cancelled","label":"Cancelled","terminal":true}
    ]'::jsonb,
    '[
      {"key":"contract_create","label":"HR creates renewal request","from":["contract_new"],"to":"contract_requested","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create renewal request"],"notifications":["notify contract reviewers"],"auditLog":"Contract renewal requested","tests":["contract request has valid dates"]},
      {"key":"contract_manager_review","label":"Manager reviews contract","from":["contract_requested","contract_manager_review"],"to":"contract_manager_review","allowedRoles":["District Manager","Regional Manager","National Sales Manager","Manager","CEO","Super Admin","HR Specialist"],"sideEffects":["capture manager review"],"notifications":["notify HR"],"auditLog":"Contract manager reviewed","tests":["manager review stays active"]},
      {"key":"contract_hr_review","label":"HR reviews contract","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_hr_review","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["capture HR review"],"notifications":["notify stakeholders"],"auditLog":"Contract HR reviewed","tests":["HR review is registry-controlled"]},
      {"key":"contract_renew","label":"HR renews contract","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_renewed","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["create or update employee contract"],"notifications":["notify employee"],"auditLog":"Contract renewed","tests":["renewal writes completed contract"]},
      {"key":"contract_not_renew","label":"HR does not renew contract","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_not_renewed","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["close renewal without new contract"],"notifications":["notify stakeholders"],"auditLog":"Contract not renewed","tests":["not-renew decision is final"]},
      {"key":"contract_upload_signed","label":"HR uploads signed contract","from":["contract_hr_review","contract_renewed"],"to":"unchanged","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["attach signed contract"],"notifications":["optional employee notification"],"auditLog":"Signed contract uploaded","tests":["signed contract URL is required"]},
      {"key":"contract_cancel","label":"HR cancels contract renewal","from":["contract_requested","contract_manager_review","contract_hr_review"],"to":"contract_cancelled","allowedRoles":["Super Admin","HR Specialist","CEO"],"sideEffects":["cancel renewal workflow"],"notifications":["notify stakeholders"],"auditLog":"Contract renewal cancelled","tests":["active contract renewal can be cancelled"]}
    ]'::jsonb,
    true,
    'system',
    'system'
  ),
  (
    'offers',
    'Offers',
    'Offer creation, candidate decision, expiry, and HR hire approval workflow.',
    '[
      {"key":"offer_draft","label":"Draft","terminal":false},
      {"key":"offer_sent","label":"Sent to candidate","terminal":false},
      {"key":"offer_accepted","label":"Accepted","terminal":false},
      {"key":"offer_rejected","label":"Rejected","terminal":true},
      {"key":"offer_expired","label":"Expired","terminal":true},
      {"key":"offer_hired","label":"Hired","terminal":true}
    ]'::jsonb,
    '[
      {"key":"offer_create","label":"HR sends offer","from":["offer_draft"],"to":"offer_sent","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["send offer email"],"notifications":["notify candidate"],"auditLog":"Offer sent","tests":["offer creation is registry-controlled"]},
      {"key":"offer_candidate_accept","label":"Candidate accepts offer","from":["offer_sent"],"to":"offer_accepted","allowedRoles":["Employee"],"sideEffects":["move onboarding to pending HR approval"],"notifications":["notify HR"],"auditLog":"Offer accepted","tests":["accepted offer waits for HR approval"]},
      {"key":"offer_candidate_reject","label":"Candidate rejects offer","from":["offer_sent"],"to":"offer_rejected","allowedRoles":["Employee"],"sideEffects":["close offer"],"notifications":["notify HR"],"auditLog":"Offer rejected","tests":["rejected offer is final"]},
      {"key":"offer_expire","label":"Offer expires","from":["offer_sent"],"to":"offer_expired","allowedRoles":["Employee","Super Admin"],"sideEffects":["close expired offer"],"notifications":["optional HR notification"],"auditLog":"Offer expired","tests":["expired offer cannot be accepted"]},
      {"key":"offer_hire_approve","label":"HR approves accepted offer as hire","from":["offer_accepted"],"to":"offer_hired","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["create employee and close vacancy"],"notifications":["notify HR"],"auditLog":"Offer approved as hired","tests":["only accepted offers can be approved"]}
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

update public.workflow_registry_modules
set
  statuses = '[
    {"key":"draft","label":"Draft","terminal":false},
    {"key":"pending_validation","label":"Pending Validation","terminal":false},
    {"key":"pending_approval","label":"Pending Approval","terminal":false},
    {"key":"returned","label":"Returned","terminal":false},
    {"key":"rejected","label":"Rejected","terminal":true},
    {"key":"approved","label":"Approved","terminal":false},
    {"key":"active","label":"Active","terminal":false},
    {"key":"roi_tracking","label":"ROI Tracking","terminal":false},
    {"key":"closed","label":"Closed","terminal":true},
    {"key":"finance_hold","label":"Finance Hold","terminal":false},
    {"key":"validation_pending","label":"Validation Pending","terminal":false},
    {"key":"validation_system_validated","label":"System Validated","terminal":false},
    {"key":"validation_sfe_validated","label":"SFE Validated","terminal":false},
    {"key":"validation_rejected","label":"Validation Rejected","terminal":true},
    {"key":"control_active","label":"Control Active","terminal":false}
  ]'::jsonb,
  actions = '[
    {"key":"create_draft","label":"Create request draft","from":["draft"],"to":"draft","allowedRoles":["Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","Marketing Manager","SFE Manager","CEO","Super Admin"],"sideEffects":["create marketing request draft"],"notifications":[],"auditLog":"Marketing request draft created","tests":["draft creation is registry-controlled"]},
    {"key":"create_validation_record","label":"Create validation record","from":["validation_pending"],"to":"validation_system_validated","allowedRoles":["Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","Marketing Manager","SFE Manager","CEO","Super Admin"],"sideEffects":["create customer and pharmacy validation records"],"notifications":["notify validation workspace"],"auditLog":"Marketing validation record created","tests":["validation record creation is registry-controlled"]},
    {"key":"update_control_step","label":"Update control workflow step","from":["control_active"],"to":"unchanged","allowedRoles":["Marketing Manager","SFE Manager","CEO","Super Admin"],"sideEffects":["update marketing workflow control settings"],"notifications":[],"auditLog":"Marketing control workflow step updated","tests":["control-step updates require authorized roles"]},
    {"key":"upload_finance_evidence","label":"Upload finance evidence","from":["draft","pending_validation","pending_approval","returned","rejected","approved","active","roi_tracking","closed","finance_hold"],"to":"unchanged","allowedRoles":["Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","Marketing Manager","SFE Manager","Finance Manager","CEO","Super Admin"],"sideEffects":["store invoice or money transfer proof"],"notifications":["notify finance or request owner"],"auditLog":"Marketing finance evidence uploaded","tests":["finance evidence upload is registry-controlled"]}
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'marketing_requests';

update public.workflow_registry_modules
set
  statuses = '[
    {"key":"draft","label":"Draft","terminal":false},
    {"key":"submitted","label":"Submitted","terminal":false},
    {"key":"reviewed_by_employee","label":"Reviewed by Employee","terminal":false},
    {"key":"locked","label":"Locked","terminal":true},
    {"key":"cancelled","label":"Cancelled","terminal":true}
  ]'::jsonb,
  actions = '[
    {"key":"create_draft","label":"Create draft report","from":["draft"],"to":"draft","allowedRoles":["Training Manager","Super Admin"],"sideEffects":["create coaching report draft"],"notifications":[],"auditLog":"Coaching draft created","tests":["draft creation is registry-controlled"]},
    {"key":"update_draft","label":"Update draft report","from":["draft"],"to":"draft","allowedRoles":["Training Manager","Super Admin"],"sideEffects":["update coaching draft and score data"],"notifications":[],"auditLog":"Coaching draft updated","tests":["draft update is registry-controlled"]},
    {"key":"submit","label":"Submit report","from":["draft"],"to":"submitted","allowedRoles":["Training Manager","Super Admin"],"sideEffects":["publish coaching report"],"notifications":["notify employee"],"auditLog":"Coaching report submitted","tests":["submitted coaching report becomes employee-visible"]},
    {"key":"acknowledge","label":"Employee acknowledge","from":["submitted"],"to":"reviewed_by_employee","allowedRoles":["Employee","Medical Rep","District Manager","Regional Manager","National Sales Manager","Product Manager","Group Product Manager","SFE Manager","Training Manager","Marketing Manager","Finance Manager","Manager","CEO","HR Specialist","Super Admin"],"sideEffects":["record employee acknowledgement"],"notifications":["notify training manager"],"auditLog":"Coaching report acknowledged","tests":["acknowledgement records timestamp"]},
    {"key":"lock","label":"Lock submitted report","from":["submitted","reviewed_by_employee"],"to":"locked","allowedRoles":["Training Manager","Super Admin"],"sideEffects":["freeze coaching report"],"notifications":["optional employee notification"],"auditLog":"Coaching report locked","tests":["locked report cannot be edited"]}
  ]'::jsonb,
  updated_by = 'system'
where module_key = 'coaching_reports';
