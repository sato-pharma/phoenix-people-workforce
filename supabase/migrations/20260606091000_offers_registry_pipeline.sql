-- Recruitment Offer Pipeline (M3) — offers workflow-registry module re-upsert.
--
-- Adds the pre-send pipeline states + actions to the `offers` module:
--   draft → pending_approval → approved → generated → sent, plus the
--   negotiation loop (sent → negotiation_in_progress → draft) and an
--   approval_rejected loop back to draft. The legacy offer_create (draft → sent)
--   is kept for the standalone /offers dashboard. Atomic upsert; restates the
--   COMPLETE module arrays (the registry stores the whole module).
-- Lockstep: src/lib/employee-lifecycle/workflow.ts (toOfferWorkflowStatus / actions)
--           + src/lib/offers/service.ts OfferStatus.

insert into public.workflow_registry_modules (
  module_key, module_name, description, statuses, actions, is_active, created_by, updated_by
)
values
  (
    'offers',
    'Offers',
    'Offer preparation, threshold approval chain, document generation, send, candidate decision (incl. negotiation), expiry, and HR hire approval workflow.',
    '[
      {"key":"offer_draft","label":"Draft","terminal":false},
      {"key":"offer_pending_approval","label":"Pending approval","terminal":false},
      {"key":"offer_approved","label":"Approved","terminal":false},
      {"key":"offer_approval_rejected","label":"Approval rejected","terminal":false},
      {"key":"offer_generated","label":"Generated","terminal":false},
      {"key":"offer_sent","label":"Sent to candidate","terminal":false},
      {"key":"offer_negotiation_in_progress","label":"Negotiation in progress","terminal":false},
      {"key":"offer_accepted","label":"Accepted","terminal":false},
      {"key":"offer_rejected","label":"Rejected","terminal":true},
      {"key":"offer_expired","label":"Expired","terminal":true},
      {"key":"offer_hired","label":"Hired","terminal":true}
    ]'::jsonb,
    '[
      {"key":"offer_create","label":"HR sends offer (direct)","from":["offer_draft"],"to":"offer_sent","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["send offer email"],"notifications":["notify candidate"],"auditLog":"Offer sent","tests":["offer creation is registry-controlled"]},
      {"key":"offer_submit_approval","label":"Submit offer for approval","from":["offer_draft","offer_approval_rejected","offer_negotiation_in_progress"],"to":"offer_pending_approval","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["seed approval chain"],"notifications":["notify approvers"],"auditLog":"Offer submitted for approval","tests":["draft can be submitted for approval"]},
      {"key":"offer_chain_approve","label":"Approval chain fully approved","from":["offer_pending_approval"],"to":"offer_approved","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["mark offer approved"],"notifications":["notify HR"],"auditLog":"Offer approved","tests":["all required approvers approve"]},
      {"key":"offer_chain_reject","label":"Approval chain rejected","from":["offer_pending_approval"],"to":"offer_approval_rejected","allowedRoles":["Super Admin","HR Specialist"],"requiresReason":true,"sideEffects":["mark offer approval rejected"],"notifications":["notify HR"],"auditLog":"Offer approval rejected","tests":["any required approver can reject"]},
      {"key":"offer_generate","label":"Generate offer documents","from":["offer_approved"],"to":"offer_generated","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["render offer letter + salary summary"],"notifications":[],"auditLog":"Offer documents generated","tests":["approved offer can be generated"]},
      {"key":"offer_send","label":"Send generated offer","from":["offer_generated"],"to":"offer_sent","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["record sent metadata","send offer email"],"notifications":["notify candidate"],"auditLog":"Offer sent","tests":["generated offer can be sent"]},
      {"key":"offer_candidate_accept","label":"Candidate accepts offer","from":["offer_sent"],"to":"offer_accepted","allowedRoles":["Employee"],"sideEffects":["move onboarding to pending HR approval"],"notifications":["notify HR"],"auditLog":"Offer accepted","tests":["accepted offer waits for HR approval"]},
      {"key":"offer_candidate_reject","label":"Candidate rejects offer","from":["offer_sent"],"to":"offer_rejected","allowedRoles":["Employee"],"sideEffects":["close offer"],"notifications":["notify HR"],"auditLog":"Offer rejected","tests":["rejected offer is final"]},
      {"key":"offer_candidate_negotiate","label":"Candidate requests negotiation","from":["offer_sent"],"to":"offer_negotiation_in_progress","allowedRoles":["Employee","Super Admin","HR Specialist"],"sideEffects":["flag offer for renegotiation"],"notifications":["notify HR"],"auditLog":"Offer negotiation requested","tests":["sent offer can enter negotiation"]},
      {"key":"offer_renegotiate_prepare","label":"Re-prepare offer after negotiation","from":["offer_negotiation_in_progress"],"to":"offer_draft","allowedRoles":["Super Admin","HR Specialist"],"sideEffects":["return offer to draft for a new version"],"notifications":[],"auditLog":"Offer returned to draft for renegotiation","tests":["negotiation loops back to draft"]},
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

notify pgrst, 'reload schema';
