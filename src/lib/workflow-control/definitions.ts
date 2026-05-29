/**
 * Workflow Control Center — Phase 1 static, READ-ONLY workflow definitions.
 *
 * These definitions are a faithful, code-derived map of the live Phoenix
 * workflows (validated against src/lib/<domain>/service.ts and the workflow
 * registry). They are PURE DATA: no database access, no service calls, no
 * imports of server-only modules — safe to import from server pages, client
 * components, and tests alike.
 *
 * Phase 1 does NOT change runtime workflow execution or approval logic. Phase 2
 * will move these into a workflow_definitions table with versioning/draft/publish.
 */

export type WorkflowControlStatus = "Active" | "Draft" | "Read-only map";
export type WorkflowControlRisk = "Low" | "Medium" | "High";

export type WorkflowControlStep = {
  /** Stable id within the workflow (used as React key + simulator reference). */
  id: string;
  name: string;
  /** Who performs this step. */
  actor: string;
  /** Role(s) responsible / authorized. */
  role: string;
  /** Workflow status this step produces. */
  statusProduced: string;
  /** In-app notification recipients (described by role/relationship). */
  notificationRecipients: string[];
  /** Email recipients (described by role/relationship). */
  emailRecipients: string[];
  /** Fallback / escalation behavior, if any. */
  fallbackEscalation?: string;
  /** Module side effects this step triggers. */
  sideEffects?: string;
};

export type WorkflowControlDefinition = {
  key: string;
  name: string;
  status: WorkflowControlStatus;
  governedByRegistry: boolean;
  /** Matching workflow-registry moduleKey, when governed by the registry. */
  registryModuleKey?: string;
  riskLevel: WorkflowControlRisk;
  /** One-line description for the library card. */
  summary: string;
  modulesAffected: string[];
  notificationsInvolved: string[];
  emailsInvolved: string[];
  steps: WorkflowControlStep[];
  /** Known gaps / unclear steps surfaced read-only (NOT changed in Phase 1). */
  gaps: string[];
};

export const WORKFLOW_CONTROL_DEFINITIONS: readonly WorkflowControlDefinition[] = [
  {
    key: "vacation",
    name: "Vacation Request",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "leave_requests",
    riskLevel: "Medium",
    summary: "Employee leave request with manager then HR final approval.",
    modulesAffected: ["v2_vacation_requests", "v2_vacation_request_events", "vacation balance", "in-app notifications", "audit_logs"],
    notificationsInvolved: ["vacation_request:submitted", "vacation_request:manager_review", "vacation_request:decision"],
    emailsInvolved: ["leave_request (to manager, with approve/reject token)", "leave_approval / leave_rejection (to employee, CC HR + manager-of-manager)"],
    steps: [
      {
        id: "submit",
        name: "Employee submits request",
        actor: "Employee",
        role: "Employee",
        statusProduced: "pending_manager",
        notificationRecipients: ["Direct manager", "Manager-of-manager (if exists)", "HR Specialists (A-16)"],
        emailRecipients: ["Direct manager"],
        fallbackEscalation: "Submission fails if the employee has no direct manager (no auto-escalation).",
        sideEffects: "Creates request with computed paid/unpaid balance; generates manager email token (14-day TTL); writes event + audit log.",
      },
      {
        id: "manager_decision",
        name: "Direct manager decision",
        actor: "Direct manager",
        role: "District Manager / Manager / Regional Manager / National Sales Manager / Super Admin",
        statusProduced: "pending_hr",
        notificationRecipients: ["Employee", "Manager-of-manager (if exists)", "HR Specialists (A-16)"],
        emailRecipients: [],
        sideEffects: "Records manager decision + timestamp; transitions to pending_hr; writes event + audit log.",
      },
      {
        id: "hr_decision",
        name: "HR final decision",
        actor: "HR Specialist",
        role: "Super Admin / HR Specialist / CEO",
        statusProduced: "approved | rejected",
        notificationRecipients: ["Employee", "Manager-of-manager (if exists)", "HR Specialists (A-16)"],
        emailRecipients: ["Employee", "CC: HR Specialists + manager-of-manager"],
        sideEffects: "Records HR decision; on approval recalculates and consumes balance; writes event + audit log; marks email token used.",
      },
    ],
    gaps: [
      "No manager-of-manager escalation when the direct manager is missing — submission simply fails.",
      "Policy warnings are sent in the submission notification but not persisted on the request for HR to see at final decision.",
    ],
  },
  {
    key: "expense",
    name: "Expense Request",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "outstation_expenses",
    riskLevel: "Medium",
    summary: "Expense approval and controlled hand-off into payroll.",
    modulesAffected: ["outstation_expense_requests", "payroll_expenses", "payroll_expense_reports", "audit_logs"],
    notificationsInvolved: ["(declared) notify approvers when pending", "(declared) notify employee on approve/reject"],
    emailsInvolved: [],
    steps: [
      {
        id: "submit",
        name: "Submit expense",
        actor: "Employee / Medical Rep / Manager",
        role: "Most submitting roles (see registry allowedRoles)",
        statusProduced: "pending",
        notificationRecipients: ["Approvers (Super Admin / HR Specialist / Finance Manager / CEO)"],
        emailRecipients: [],
        sideEffects: "Creates request capturing trip, GPS, calculated amount, eligibility and fraud flags.",
      },
      {
        id: "approve",
        name: "Approve expense",
        actor: "Finance admin",
        role: "Super Admin / HR Specialist / Finance Manager / CEO",
        statusProduced: "approved",
        notificationRecipients: ["Employee (submitter)"],
        emailRecipients: [],
        sideEffects: "Sets approved_by/at; makes expense eligible for manual payroll import.",
      },
      {
        id: "reject",
        name: "Reject expense",
        actor: "Finance admin",
        role: "Super Admin / HR Specialist / Finance Manager / CEO",
        statusProduced: "rejected",
        notificationRecipients: ["Employee (submitter)"],
        emailRecipients: [],
        sideEffects: "Stores rejection reason; excludes from payroll import.",
      },
      {
        id: "add_to_payroll",
        name: "Add to payroll",
        actor: "Finance admin",
        role: "Super Admin / HR Specialist / Finance Manager",
        statusProduced: "added_to_payroll",
        notificationRecipients: ["(optional) payroll completion"],
        emailRecipients: [],
        fallbackEscalation: "Only allowed from 'approved'; locks the expense once imported.",
        sideEffects: "Links expense to the payroll run and locks edit/delete.",
      },
    ],
    gaps: [
      "Notification/email producers are declared in the registry but NOT yet called by the service (no alerts are actually sent).",
      "Approver list is not routed (no manager-review-before-finance rule).",
    ],
  },
  {
    key: "outstation",
    name: "Outstation Request",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "outstation_expenses",
    riskLevel: "Medium",
    summary: "Field outstation capture with fraud validation, then finance review.",
    modulesAffected: ["outstation_expense_requests", "outstation_location_audit_logs", "payroll_expenses", "storage (evidence/tickets)"],
    notificationsInvolved: [],
    emailsInvolved: [],
    steps: [
      {
        id: "capture_submit",
        name: "Employee captures location & submits",
        actor: "Employee (field)",
        role: "Any user with outstation permission",
        statusProduced: "submitted (pending)",
        notificationRecipients: [],
        emailRecipients: [],
        sideEffects: "Inserts request; uploads car evidence / ticket attachments; writes location audit with fraud flags.",
      },
      {
        id: "validate",
        name: "Validation & fraud detection",
        actor: "System",
        role: "System process",
        statusProduced: "eligibility: eligible | needs_review | not_eligible",
        notificationRecipients: [],
        emailRecipients: [],
        sideEffects: "Distance via Maps API, territory match, GPS accuracy, impossible-speed check, suspicion score.",
      },
      {
        id: "admin_review",
        name: "Admin reviews & approves/rejects",
        actor: "Finance admin",
        role: "Super Admin / HR Specialist / Finance Manager / CEO",
        statusProduced: "approved | rejected",
        notificationRecipients: [],
        emailRecipients: [],
        fallbackEscalation: "Rejection blocked once imported to payroll.",
        sideEffects: "On approve creates/updates linked payroll expense; on reject removes linked payroll rows; writes audit log.",
      },
    ],
    gaps: [
      "No in-app or email notifications are sent at any step today.",
      "No documented routing for approval_recommendation = manager_review / finance_review.",
    ],
  },
  {
    key: "marketing",
    name: "Marketing Request",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "marketing_requests",
    riskLevel: "High",
    summary: "HCP/pharmacy marketing request with validation, approval and finance evidence.",
    modulesAffected: ["marketing_requests", "marketing_request_approval_steps", "marketing_request_finance_requirements", "marketing customers/pharmacies"],
    notificationsInvolved: ["request_submitted", "request_approved", "request_rejected"],
    emailsInvolved: ["requester notification", "manager notification"],
    steps: [
      {
        id: "draft",
        name: "Create draft",
        actor: "Creator (rep / manager / marketing)",
        role: "Marketing creator roles",
        statusProduced: "draft",
        notificationRecipients: [],
        emailRecipients: [],
        sideEffects: "Creates request; computes ROI preview; validates customer/products/pharmacy codes.",
      },
      {
        id: "submit",
        name: "Submit request",
        actor: "Requester or direct manager",
        role: "Request owner / manager",
        statusProduced: "pending_validation",
        notificationRecipients: ["Requester", "Manager (if assigned)"],
        emailRecipients: ["Requester", "Manager (if assigned)"],
        sideEffects: "Sets submitted_at; creates approval steps if defined.",
      },
      {
        id: "validate",
        name: "Validate request",
        actor: "SFE Manager",
        role: "SFE Manager / Super Admin",
        statusProduced: "pending_approval",
        notificationRecipients: ["Requester"],
        emailRecipients: ["Requester"],
        sideEffects: "Updates validation state on customers/pharmacies; records decision.",
      },
      {
        id: "approve",
        name: "Approve / reject / return",
        actor: "Finance / scoped approver",
        role: "Finance Manager / Super Admin / assigned role",
        statusProduced: "approved | rejected | returned",
        notificationRecipients: ["Requester", "Manager"],
        emailRecipients: ["Requester"],
        sideEffects: "Sets decision timestamp; creates finance requirement (invoice/deadline) on approval.",
      },
    ],
    gaps: [
      "Submit/approve/reject service functions are partially routed through the registry; approval-step rows are not consistently written.",
      "Finance-hold transitions and ROI/closed auto-transitions are defined but not implemented.",
    ],
  },
  {
    key: "probation",
    name: "Probation",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "employee_lifecycle",
    riskLevel: "Medium",
    summary: "New-hire probation review with manager feedback and HR pass/terminate.",
    modulesAffected: ["probation_evaluations", "employees", "resignations (on terminate)", "notification_events", "audit_logs"],
    notificationsInvolved: ["probation (in-app reminders)", "probation_alert (email)"],
    emailsInvolved: ["probation_alert (manager, manager-of-manager, HR, Training Manager)"],
    steps: [
      {
        id: "evaluation_requested",
        name: "System / HR creates evaluation",
        actor: "HR or scheduled reminder",
        role: "Super Admin / HR Specialist / system",
        statusProduced: "evaluation_requested",
        notificationRecipients: ["Direct manager", "Manager-of-manager", "HR", "Training Manager"],
        emailRecipients: ["probation_alert"],
        sideEffects: "Creates evaluation + history; schedules reminder notification events.",
      },
      {
        id: "manager_feedback",
        name: "Manager submits feedback",
        actor: "Direct manager (or manager-of-manager fallback)",
        role: "Direct Manager / Manager-of-manager / HR Specialist / Super Admin",
        statusProduced: "manager_feedback",
        notificationRecipients: ["Direct manager", "HR", "Training Manager"],
        emailRecipients: ["probation_alert"],
        sideEffects: "Records manager feedback + reviewer; writes history.",
      },
      {
        id: "hr_decision",
        name: "HR decides (pass / terminate)",
        actor: "HR Specialist",
        role: "HR Specialist / Super Admin",
        statusProduced: "probation_passed | probation_terminated",
        notificationRecipients: ["Direct manager", "HR", "Training Manager"],
        emailRecipients: ["probation_alert"],
        fallbackEscalation: "Terminate triggers resignation workflow (opens vacancy, deactivates access).",
        sideEffects: "Pass → activates employee (payroll-eligible, organogram-visible); cancels pending reminders.",
      },
    ],
    gaps: [
      "Extension decision ('extend' / probation_extended) is defined but never executed.",
      "Reminder processing bypasses normal access control with no audit trail of sent reminders.",
    ],
  },
  {
    key: "contract",
    name: "Contract Renewal",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "employee_lifecycle",
    riskLevel: "Medium",
    summary: "Contract renewal review and renew / not-renew / cancel decision.",
    modulesAffected: ["contract_renewal_requests", "employee_contracts", "contract_renewal_history", "employees"],
    notificationsInvolved: ["contract_renewal (workflow state change)"],
    emailsInvolved: ["manager_chain", "employee (on renew)", "HR inbox fallback"],
    steps: [
      {
        id: "requested",
        name: "Create renewal request",
        actor: "HR Specialist",
        role: "Super Admin / HR Specialist",
        statusProduced: "requested",
        notificationRecipients: ["Employee"],
        emailRecipients: ["Manager chain (fallback HR inbox)"],
        sideEffects: "Creates renewal request; enforces one active renewal per employee.",
      },
      {
        id: "manager_review",
        name: "Manager review",
        actor: "Manager (or above)",
        role: "Manager chain / Super Admin / HR Specialist",
        statusProduced: "manager_review",
        notificationRecipients: ["HR (via email)"],
        emailRecipients: ["HR team / manager chain"],
        sideEffects: "Records manager reviewer + timestamped note.",
      },
      {
        id: "hr_review",
        name: "HR review",
        actor: "HR Specialist",
        role: "Super Admin / HR Specialist / CEO",
        statusProduced: "hr_review",
        notificationRecipients: ["Stakeholders (email)"],
        emailRecipients: ["Stakeholders / manager chain"],
        sideEffects: "Records HR reviewer; signed contract may be uploaded.",
      },
      {
        id: "decision",
        name: "Renew / Not renew / Cancel",
        actor: "HR Specialist",
        role: "Super Admin / HR Specialist / CEO",
        statusProduced: "renewed | not_renewed | cancelled",
        notificationRecipients: ["Employee (on renew)", "Stakeholders"],
        emailRecipients: ["Employee (renew)", "Stakeholders"],
        fallbackEscalation: "Terminal decision; no escalation.",
        sideEffects: "On renew: expires old contract, creates new active contract, updates renewal date.",
      },
    ],
    gaps: [
      "Reminder/cron caller for renewal candidates is exported but its scheduled invocation isn't visible.",
      "In-app recipients are limited to the employee; manager/HR reviewers get email only.",
    ],
  },
  {
    key: "offers",
    name: "Offer Lifecycle",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "employee_lifecycle",
    riskLevel: "High",
    summary: "Candidate offer send, accept/reject, and HR hire approval.",
    modulesAffected: ["job_offers", "employees", "position_vacancies", "job_offer_audit_logs", "notification_outbox"],
    notificationsInvolved: ["offer_accepted (HR)", "offer_rejected (HR)", "hire_approved (HR)"],
    emailsInvolved: ["sendJobOfferEmail (candidate)", "acceptance/rejection/hire notifications (HR)"],
    steps: [
      {
        id: "offer_sent",
        name: "Create & send offer",
        actor: "HR Specialist",
        role: "HR Specialist / Super Admin",
        statusProduced: "offer_sent",
        notificationRecipients: ["Candidate (via email)"],
        emailRecipients: ["Candidate"],
        sideEffects: "Creates offer with secure token + expiry; emails accept/reject links.",
      },
      {
        id: "candidate_decision",
        name: "Candidate accepts / rejects",
        actor: "Candidate",
        role: "Candidate",
        statusProduced: "offer_accepted | offer_rejected",
        notificationRecipients: ["HR team", "Candidate (confirmation)"],
        emailRecipients: ["HR team", "Candidate"],
        fallbackEscalation: "Expires automatically after expiry date (offer_expired).",
        sideEffects: "On accept sets onboarding_status = pending_hr_approval; writes audit log.",
      },
      {
        id: "hr_hire",
        name: "HR approves accepted offer as hire",
        actor: "HR Specialist",
        role: "HR Specialist / Super Admin",
        statusProduced: "offer_hired",
        notificationRecipients: ["HR team"],
        emailRecipients: ["HR team"],
        sideEffects: "Creates employee from offer; closes/fills the matching position vacancy; provisions access.",
      },
    ],
    gaps: [
      "Offer token is not consumed/invalidated until expiry — it can be reused while valid.",
      "No retry if the offer/notification email fails (failures only logged to the outbox).",
    ],
  },
  {
    key: "resignation",
    name: "Resignation",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "employee_lifecycle",
    riskLevel: "High",
    summary: "Employee separation: submit → review → approve → complete (with reopen/cancel).",
    modulesAffected: ["employee_resignations", "employees", "position_vacancies", "app_auth_users", "user_access_profiles", "audit_logs"],
    notificationsInvolved: ["resignation (email only — not in personal bell)"],
    emailsInvolved: ["Resignation Submitted / Approved / Rejected / Completed (manager chain)"],
    steps: [
      {
        id: "submitted",
        name: "Submit resignation",
        actor: "HR or employee self-service",
        role: "Per registry (resignation_submit)",
        statusProduced: "resignation_submitted",
        notificationRecipients: [],
        emailRecipients: ["Manager chain of the resigning employee"],
        sideEffects: "Sets terminal employment status; hides from organogram; deactivates access; optionally opens vacancy.",
      },
      {
        id: "under_review",
        name: "Mark for review",
        actor: "HR / management",
        role: "Per registry (resignation_mark_review)",
        statusProduced: "resignation_under_review",
        notificationRecipients: [],
        emailRecipients: ["Manager chain"],
        sideEffects: "Records reviewer; clears rejected reason.",
      },
      {
        id: "approved",
        name: "Approve resignation",
        actor: "HR / approver",
        role: "Per registry (resignation_approve)",
        statusProduced: "resignation_approved",
        notificationRecipients: [],
        emailRecipients: ["Manager chain"],
        sideEffects: "Records approver + timestamp.",
      },
      {
        id: "completed",
        name: "Complete resignation",
        actor: "HR",
        role: "Per registry (resignation_complete)",
        statusProduced: "resignation_completed",
        notificationRecipients: [],
        emailRecipients: ["Manager chain"],
        fallbackEscalation: "Reject/Reopen/Cancel available from earlier states.",
        sideEffects: "Marks employee fully separated (terminal).",
      },
    ],
    gaps: [
      "No in-app notifications — resignation is not in the personal-bell allowlist (email only).",
      "Date-update path bypasses the workflow registry transition guard.",
    ],
  },
  {
    key: "payroll",
    name: "Payroll / Payslip Notification",
    status: "Read-only map",
    governedByRegistry: true,
    registryModuleKey: "payroll_batches",
    riskLevel: "High",
    summary: "Payroll batch lifecycle; payslip-ready notification is declared but not yet implemented.",
    modulesAffected: ["payroll_batches", "payslips", "notification_events"],
    notificationsInvolved: ["(declared at lock) notify employees when payslips are ready — NOT yet implemented"],
    emailsInvolved: [],
    steps: [
      {
        id: "uploaded",
        name: "Upload & mark Part 1 ready",
        actor: "Payroll admin",
        role: "Super Admin / HR Specialist / Finance Manager",
        statusProduced: "part1_ready",
        notificationRecipients: ["Payroll admins"],
        emailRecipients: [],
        sideEffects: "Freezes the initial upload for Part 1 review.",
      },
      {
        id: "review",
        name: "Send to review & approve",
        actor: "Payroll admin / approver",
        role: "Super Admin / HR Specialist / Finance Manager",
        statusProduced: "under_review → approved",
        notificationRecipients: ["Approvers", "Payroll owner"],
        emailRecipients: [],
        sideEffects: "Moves the batch through final review to approved.",
      },
      {
        id: "lock",
        name: "Lock batch (payslips ready)",
        actor: "Finance / Super Admin",
        role: "Super Admin / Finance Manager",
        statusProduced: "locked",
        notificationRecipients: ["Employees (declared — payslip ready)"],
        emailRecipients: [],
        fallbackEscalation: "No fallback defined for failed payslip-notification delivery.",
        sideEffects: "Locks payroll edits; payslips become available.",
      },
    ],
    gaps: [
      "No payslip-notification producer or cron exists yet — the 'notify employees' side effect at lock is declared but not sent.",
      "No 'payslip' email notification type or policy is configured.",
    ],
  },
  {
    key: "coaching",
    name: "Coaching Report",
    status: "Active",
    governedByRegistry: true,
    registryModuleKey: "coaching_reports",
    riskLevel: "Medium",
    summary: "Field coaching report: draft → submit → acknowledge by the rep.",
    modulesAffected: ["coaching_reports", "coaching_score_items", "coaching_report_acknowledgments", "notification_events"],
    notificationsInvolved: ["coaching_report_submitted (in-app to the rep)"],
    emailsInvolved: [],
    steps: [
      {
        id: "draft",
        name: "Create / update draft",
        actor: "Training Manager",
        role: "Training Manager / Super Admin",
        statusProduced: "draft",
        notificationRecipients: [],
        emailRecipients: [],
        sideEffects: "Creates/updates report and score items; writes audit log.",
      },
      {
        id: "submit",
        name: "Submit report",
        actor: "Training Manager",
        role: "Training Manager / Super Admin",
        statusProduced: "submitted",
        notificationRecipients: ["Medical Rep (the coached employee)"],
        emailRecipients: [],
        sideEffects: "Computes final score / performance zone; enqueues in-app notification to the rep.",
      },
      {
        id: "acknowledge",
        name: "Employee acknowledges",
        actor: "Medical Rep",
        role: "Employee (must match the coached rep)",
        statusProduced: "reviewed_by_employee",
        notificationRecipients: ["Training Manager (acknowledgement)"],
        emailRecipients: [],
        fallbackEscalation: "No manager/HR escalation if the rep never acknowledges.",
        sideEffects: "Records acknowledgement (one per report) + audit metadata.",
      },
    ],
    gaps: [
      "Submission notifies only the rep — no manager/HR routing; the coach gets no confirmation.",
      "A 'cancelled' status exists in schema but no code path produces or handles it.",
    ],
  },
];

export function listWorkflowDefinitions(): readonly WorkflowControlDefinition[] {
  return WORKFLOW_CONTROL_DEFINITIONS;
}

export function getWorkflowDefinition(key: string): WorkflowControlDefinition | undefined {
  const needle = key.trim().toLowerCase();
  return WORKFLOW_CONTROL_DEFINITIONS.find((definition) => definition.key === needle);
}

export function workflowDefinitionKeys(): string[] {
  return WORKFLOW_CONTROL_DEFINITIONS.map((definition) => definition.key);
}
