/**
 * Workflow Control Center — Phase 1 static, READ-ONLY workflow map.
 *
 * Business-friendly grouping: a SMALL set of top-level DOMAINS, each containing
 * named SUBFLOWS. Every subflow is a faithful, code-derived mini-flow of boxes
 * (steps) with actors, statuses, notification + email recipients, fallback and
 * side effects.
 *
 * This is PURE DATA: no database access, no service calls, no server-only
 * imports. Safe to import from server pages, client components and tests.
 * Phase 1 does NOT change runtime workflow execution or approval logic.
 */

export type WorkflowControlStatus = "Active" | "Draft" | "Read-only map";
export type WorkflowControlRisk = "Low" | "Medium" | "High";

export type WorkflowControlStep = {
  id: string;
  name: string;
  actor: string;
  role: string;
  statusProduced: string;
  notificationRecipients: string[];
  emailRecipients: string[];
  fallbackEscalation?: string;
  sideEffects?: string;
  /**
   * Explicit, business-friendly destination for this step ("where it routes
   * next / who acts"). Set this whenever the actor text would be ambiguous —
   * the simulator prefers it over any heuristic. Supports the "Direct manager"
   * token, which the simulator resolves to the provided manager.
   */
  routesTo?: string;
};

export type WorkflowSubflow = {
  key: string;
  name: string;
  summary?: string;
  governedByRegistry?: boolean;
  registryModuleKey?: string;
  steps: WorkflowControlStep[];
  gaps?: string[];
};

export type WorkflowControlDomain = {
  key: string;
  name: string;
  status: WorkflowControlStatus;
  riskLevel: WorkflowControlRisk;
  summary: string;
  /** Cross-cutting domains describe shared infrastructure, not a request flow. */
  crossCutting?: boolean;
  /** Beta/early domains carry a visible warning. */
  beta?: boolean;
  modulesAffected: string[];
  subflows: WorkflowSubflow[];
};

const n = (...values: string[]) => values;

export const WORKFLOW_CONTROL_DOMAINS: readonly WorkflowControlDomain[] = [
  // ===========================================================================
  // 1. Leave & Vacation
  // ===========================================================================
  {
    key: "leave",
    name: "Leave & Vacation",
    status: "Active",
    riskLevel: "Medium",
    summary: "Employee leave: request, manager approval, HR final decision, and report impact.",
    modulesAffected: n("v2_vacation_requests", "vacation balance", "in-app notifications", "emails", "audit_logs"),
    subflows: [
      {
        key: "vacation-request",
        name: "Vacation Request & Approval",
        summary: "End-to-end request → direct manager → HR final decision.",
        governedByRegistry: true,
        registryModuleKey: "leave_requests",
        steps: [
          {
            id: "submit",
            name: "Employee submits request",
            actor: "Employee",
            role: "Employee",
            statusProduced: "pending_manager",
            routesTo: "Direct manager",
            notificationRecipients: n("Direct manager", "Manager-of-manager (if exists)", "HR Specialists (A-16)"),
            emailRecipients: n("Direct manager"),
            fallbackEscalation: "Submission fails if the employee has no direct manager (no auto-escalation).",
            sideEffects: "Creates request with computed paid/unpaid balance; generates manager email token (14-day TTL).",
          },
          {
            id: "manager_decision",
            name: "Direct manager approval",
            actor: "Direct manager",
            role: "District Manager / Manager / Regional Manager / NSM / Super Admin",
            statusProduced: "pending_hr",
            notificationRecipients: n("Employee", "Manager-of-manager (if exists)", "HR Specialists (A-16)"),
            emailRecipients: [],
            sideEffects: "Records manager decision; transitions to pending_hr; writes event + audit log.",
          },
          {
            id: "hr_decision",
            name: "HR final decision",
            actor: "HR Specialist",
            role: "Super Admin / HR Specialist / CEO",
            statusProduced: "approved | rejected",
            notificationRecipients: n("Employee", "Manager-of-manager (if exists)", "HR Specialists (A-16)"),
            emailRecipients: n("Employee", "CC: HR Specialists + manager-of-manager"),
            sideEffects: "On approval recalculates and consumes balance; writes event + audit log.",
          },
        ],
        gaps: ["No manager-of-manager escalation when the direct manager is missing — submission simply fails."],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        summary: "The three vacation notification events and their recipients.",
        steps: [
          {
            id: "notify",
            name: "Notify stakeholders at each transition",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Employee", "Direct manager", "Manager-of-manager", "HR Specialists (A-16)"),
            emailRecipients: n("Manager (submission)", "Employee (final decision, CC HR + manager-of-manager)"),
            sideEffects: "vacation_request:submitted / manager_review / decision in-app events; leave_request / approval / rejection emails.",
          },
        ],
        gaps: ["Policy warnings are sent in the submission notification but not persisted for HR to see at final decision."],
      },
      {
        key: "report-impact",
        name: "Vacation Report Impact",
        summary: "Balance and report changes produced by an approval.",
        steps: [
          {
            id: "report",
            name: "Update balance & vacation report",
            actor: "System",
            role: "System",
            statusProduced: "(report data updated)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Consumes paid/unpaid days; updates payment_status and balances feeding the vacation report.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 2. Expenses & Outstation
  // ===========================================================================
  {
    key: "expenses-outstation",
    name: "Expenses & Outstation",
    status: "Active",
    riskLevel: "Medium",
    summary: "Standard expenses and outstation travel: validation, evidence, approval, payroll import.",
    modulesAffected: n("outstation_expense_requests", "outstation_location_audit_logs", "payroll_expenses", "storage (evidence)"),
    subflows: [
      {
        key: "expense",
        name: "Standard Expense Request",
        summary: "Submit → admin approve/reject (registry: outstation_expenses).",
        governedByRegistry: true,
        registryModuleKey: "outstation_expenses",
        steps: [
          {
            id: "submit",
            name: "Submit expense",
            actor: "Employee / Medical Rep / Manager",
            role: "Most submitting roles",
            statusProduced: "pending",
            routesTo: "Approvers (Finance / HR / Super Admin)",
            notificationRecipients: n("Approvers (Super Admin / HR Specialist / Finance Manager / CEO)"),
            emailRecipients: [],
            sideEffects: "Creates request capturing amount, eligibility and fraud flags.",
          },
          {
            id: "decision",
            name: "Approve / reject",
            actor: "Finance admin",
            role: "Super Admin / HR Specialist / Finance Manager / CEO",
            statusProduced: "approved | rejected",
            notificationRecipients: n("Employee (submitter)"),
            emailRecipients: [],
            sideEffects: "Approval makes the expense eligible for manual payroll import.",
          },
        ],
        gaps: ["Notification/email producers are declared in the registry but NOT yet called by the service."],
      },
      {
        key: "outstation",
        name: "Outstation Travel Request",
        summary: "Field capture with GPS, fraud validation, then finance review.",
        governedByRegistry: true,
        registryModuleKey: "outstation_expenses",
        steps: [
          {
            id: "capture",
            name: "Capture location & submit",
            actor: "Employee (field)",
            role: "Any user with outstation permission",
            statusProduced: "submitted (pending)",
            routesTo: "Finance admin (after validation)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Uploads car evidence / tickets; writes location audit with fraud flags.",
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
            sideEffects: "On approve creates/updates the linked payroll expense.",
          },
        ],
        gaps: ["No in-app or email notifications are sent at any step today."],
      },
      {
        key: "validation",
        name: "Distance & Policy Validation",
        summary: "System validation performed during submission.",
        steps: [
          {
            id: "validate",
            name: "Validate distance, territory & speed",
            actor: "System",
            role: "System",
            statusProduced: "eligible | needs_review | not_eligible",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Maps distance, territory match, GPS accuracy, impossible-speed and suspicion score.",
          },
        ],
      },
      {
        key: "evidence",
        name: "Evidence Upload",
        summary: "Car photo / ticket attachments captured with the request.",
        steps: [
          {
            id: "upload",
            name: "Upload car evidence / tickets",
            actor: "Employee (field)",
            role: "Submitter",
            statusProduced: "(attached to request)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Stores evidence in the leave/expense storage bucket; referenced by the audit log.",
          },
        ],
      },
      {
        key: "approval",
        name: "Manager / Admin Approval",
        summary: "Who can approve and what it unlocks.",
        steps: [
          {
            id: "approve",
            name: "Approve for payroll",
            actor: "Finance admin",
            role: "Super Admin / HR Specialist / Finance Manager",
            statusProduced: "approved",
            notificationRecipients: n("Employee (submitter)"),
            emailRecipients: [],
            sideEffects: "Creates/updates the linked payroll_expenses row.",
          },
        ],
      },
      {
        key: "payroll-queue",
        name: "Payroll Queue & Import",
        summary: "Approved expenses imported into a payroll run.",
        steps: [
          {
            id: "add_to_payroll",
            name: "Add to payroll",
            actor: "Finance admin",
            role: "Super Admin / HR Specialist / Finance Manager",
            statusProduced: "added_to_payroll",
            notificationRecipients: n("(optional) payroll completion"),
            emailRecipients: [],
            fallbackEscalation: "Only from 'approved'; locks the expense once imported.",
            sideEffects: "Links the expense to a payroll run and locks edit/delete.",
          },
        ],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        summary: "Declared alerts (currently not implemented).",
        steps: [
          {
            id: "notify",
            name: "Notify approvers / employee",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Approvers", "Employee (submitter)"),
            emailRecipients: [],
            sideEffects: "Declared in the registry; producers are not yet wired up.",
          },
        ],
        gaps: ["No alerts are actually sent today (declared-only)."],
      },
    ],
  },

  // ===========================================================================
  // 3. Employee Lifecycle
  // ===========================================================================
  {
    key: "employee-lifecycle",
    name: "Employee Lifecycle",
    status: "Active",
    riskLevel: "High",
    summary: "Probation, contract renewal, resignation, vacancy and access lifecycle.",
    modulesAffected: n("probation_evaluations", "contract_renewal_requests", "employee_resignations", "position_vacancies", "app_auth_users"),
    subflows: [
      {
        key: "probation",
        name: "Probation",
        governedByRegistry: true,
        registryModuleKey: "employee_lifecycle",
        steps: [
          {
            id: "evaluation_requested",
            name: "System / HR creates evaluation",
            actor: "HR or scheduled reminder",
            role: "Super Admin / HR Specialist / system",
            statusProduced: "evaluation_requested",
            notificationRecipients: n("Direct manager", "Manager-of-manager", "HR", "Training Manager"),
            emailRecipients: n("probation_alert"),
            sideEffects: "Creates evaluation + history; schedules reminder events.",
          },
          {
            id: "manager_feedback",
            name: "Manager submits feedback",
            actor: "Direct manager (manager-of-manager fallback)",
            role: "Manager / HR Specialist / Super Admin",
            statusProduced: "manager_feedback",
            notificationRecipients: n("Direct manager", "HR", "Training Manager"),
            emailRecipients: n("probation_alert"),
            sideEffects: "Records manager feedback + reviewer.",
          },
          {
            id: "hr_decision",
            name: "HR decides (pass / terminate)",
            actor: "HR Specialist",
            role: "HR Specialist / Super Admin",
            statusProduced: "probation_passed | probation_terminated",
            notificationRecipients: n("Direct manager", "HR", "Training Manager"),
            emailRecipients: n("probation_alert"),
            fallbackEscalation: "Terminate triggers the resignation flow (opens vacancy, deactivates access).",
            sideEffects: "Pass activates the employee (payroll-eligible, organogram-visible).",
          },
        ],
        gaps: ["The 'extend' decision is defined but never executed."],
      },
      {
        key: "contract",
        name: "Contract Renewal",
        governedByRegistry: true,
        registryModuleKey: "employee_lifecycle",
        steps: [
          {
            id: "requested",
            name: "Create renewal request",
            actor: "HR Specialist",
            role: "Super Admin / HR Specialist",
            statusProduced: "requested",
            notificationRecipients: n("Employee"),
            emailRecipients: n("Manager chain (fallback HR inbox)"),
            sideEffects: "Enforces one active renewal per employee.",
          },
          {
            id: "review",
            name: "Manager then HR review",
            actor: "Manager → HR Specialist",
            role: "Manager chain / Super Admin / HR Specialist / CEO",
            statusProduced: "manager_review → hr_review",
            notificationRecipients: n("HR / stakeholders (email)"),
            emailRecipients: n("Manager chain / HR"),
            sideEffects: "Records reviewers; signed contract may be uploaded.",
          },
          {
            id: "decision",
            name: "Renew / Not renew / Cancel",
            actor: "HR Specialist",
            role: "Super Admin / HR Specialist / CEO",
            statusProduced: "renewed | not_renewed | cancelled",
            notificationRecipients: n("Employee (on renew)", "Stakeholders"),
            emailRecipients: n("Employee (renew)", "Stakeholders"),
            sideEffects: "On renew: expires old contract, creates new active contract.",
          },
        ],
      },
      {
        key: "resignation",
        name: "Resignation",
        governedByRegistry: true,
        registryModuleKey: "employee_lifecycle",
        steps: [
          {
            id: "submitted",
            name: "Submit resignation",
            actor: "HR or employee self-service",
            role: "Per registry (resignation_submit)",
            statusProduced: "resignation_submitted",
            notificationRecipients: [],
            emailRecipients: n("Manager chain of the resigning employee"),
            sideEffects: "Terminal employment status; hides from organogram; deactivates access; optionally opens vacancy.",
          },
          {
            id: "review_approve_complete",
            name: "Review → approve → complete",
            actor: "HR / approver",
            role: "Per registry",
            statusProduced: "under_review → approved → completed",
            notificationRecipients: [],
            emailRecipients: n("Manager chain"),
            fallbackEscalation: "Reject / Reopen / Cancel available from earlier states.",
            sideEffects: "Marks the employee fully separated.",
          },
        ],
        gaps: ["No in-app notifications — resignation is not in the personal-bell allowlist (email only)."],
      },
      {
        key: "contract-non-renewal",
        name: "Contract Non-Renewal (placeholder)",
        summary: "Terminal non-renewal lifecycle is a Phase-2 blocker (needs migration).",
        steps: [
          {
            id: "placeholder",
            name: "Non-renewal terminal handling — not yet implemented",
            actor: "—",
            role: "—",
            statusProduced: "(planned)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Placeholder: requires a schema migration and is out of Phase-1 scope.",
          },
        ],
        gaps: ["Contract non-renewal terminal lifecycle is not implemented (Phase-2 / migration required)."],
      },
      {
        key: "vacancy",
        name: "Vacancy Opening & Filling",
        summary: "Seat lifecycle driven by resignation/termination and offers.",
        steps: [
          {
            id: "vacancy",
            name: "Open / fill position vacancy",
            actor: "System",
            role: "System",
            statusProduced: "open → filled",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Resignation/termination opens a vacancy; an approved hire fills it (filled_by_hr_id).",
          },
        ],
      },
      {
        key: "access-deactivation",
        name: "Access Deactivation",
        summary: "Auth + access-profile teardown on separation.",
        steps: [
          {
            id: "deactivate",
            name: "Deactivate auth & access profiles",
            actor: "System",
            role: "System",
            statusProduced: "(access revoked)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Deactivates app_auth_users + user_access_profiles; invalidates the directory cache.",
          },
        ],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        summary: "Lifecycle email tones; resignation is email-only.",
        steps: [
          {
            id: "notify",
            name: "Notify the manager chain",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("(probation/contract in-app where wired)"),
            emailRecipients: n("Manager chain (probation_alert / contract_renewal / resignation)"),
            sideEffects: "Email tone varies by action (success/warning/danger).",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 4. Offer & Hiring
  // ===========================================================================
  {
    key: "offer-hiring",
    name: "Offer & Hiring",
    status: "Active",
    riskLevel: "High",
    summary: "Candidate offer, acceptance, HR approval, employee creation and vacancy fill.",
    modulesAffected: n("job_offers", "employees", "position_vacancies", "job_offer_audit_logs", "notification_outbox"),
    subflows: [
      {
        key: "offer",
        name: "Offer Lifecycle",
        governedByRegistry: true,
        registryModuleKey: "employee_lifecycle",
        steps: [
          {
            id: "offer_sent",
            name: "Create & send offer",
            actor: "HR Specialist",
            role: "HR Specialist / Super Admin",
            statusProduced: "offer_sent",
            notificationRecipients: n("Candidate (via email)"),
            emailRecipients: n("Candidate"),
            sideEffects: "Creates offer with secure token + expiry; emails accept/reject links.",
          },
          {
            id: "candidate_decision",
            name: "Candidate accepts / rejects",
            actor: "Candidate",
            role: "Candidate",
            statusProduced: "offer_accepted | offer_rejected",
            notificationRecipients: n("HR team", "Candidate (confirmation)"),
            emailRecipients: n("HR team", "Candidate"),
            fallbackEscalation: "Expires automatically after the expiry date.",
            sideEffects: "On accept sets onboarding_status = pending_hr_approval.",
          },
          {
            id: "hr_hire",
            name: "HR approves accepted offer as hire",
            actor: "HR Specialist",
            role: "HR Specialist / Super Admin",
            statusProduced: "offer_hired",
            notificationRecipients: n("HR team"),
            emailRecipients: n("HR team"),
            sideEffects: "Creates the employee; closes/fills the matching vacancy; provisions access.",
          },
        ],
        gaps: ["Offer token is not consumed/invalidated until expiry — it can be reused while valid."],
      },
      {
        key: "acceptance",
        name: "Candidate Acceptance",
        summary: "The candidate-driven decision step.",
        steps: [
          {
            id: "accept",
            name: "Candidate accepts the offer",
            actor: "Candidate",
            role: "Candidate",
            statusProduced: "offer_accepted",
            notificationRecipients: n("HR team", "Candidate"),
            emailRecipients: n("HR team", "Candidate"),
            sideEffects: "Moves the record into the hired pipeline (pending HR approval).",
          },
        ],
      },
      {
        key: "hr-approval",
        name: "HR Approval & Employee Creation",
        summary: "HR converts an accepted offer into an employee.",
        steps: [
          {
            id: "approve_hire",
            name: "Approve hire & create employee",
            actor: "HR Specialist",
            role: "HR Specialist / Super Admin",
            statusProduced: "offer_hired",
            notificationRecipients: n("HR team"),
            emailRecipients: n("HR team"),
            sideEffects: "Generates the employee_hr_id and provisions system access.",
          },
        ],
      },
      {
        key: "vacancy-fill",
        name: "Vacancy Fill",
        summary: "Department-safe matching closes the open seat.",
        steps: [
          {
            id: "fill",
            name: "Fill the matching vacancy",
            actor: "System",
            role: "System",
            statusProduced: "filled",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Picks a department-safe vacancy and sets filled_by_hr_id.",
          },
        ],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        summary: "Candidate + HR notifications across the lifecycle.",
        steps: [
          {
            id: "notify",
            name: "Notify candidate & HR",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Candidate", "HR team"),
            emailRecipients: n("Candidate (offer)", "HR (accept/reject/hire)"),
            sideEffects: "hr_notifications recipient mode for the HR team.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 5. Payroll & Payslips (payslip notification is a SUBFLOW, not a top card)
  // ===========================================================================
  {
    key: "payroll",
    name: "Payroll & Payslips",
    status: "Active",
    riskLevel: "High",
    summary: "Payroll batch lifecycle and payslip publish/notification.",
    modulesAffected: n("payroll_batches", "payslips", "notification_events"),
    subflows: [
      {
        key: "batch",
        name: "Payroll Batch Lifecycle",
        summary: "Upload → review → approve → lock.",
        governedByRegistry: true,
        registryModuleKey: "payroll_batches",
        steps: [
          {
            id: "upload",
            name: "Upload & mark Part 1 ready",
            actor: "Payroll admin",
            role: "Super Admin / HR Specialist / Finance Manager",
            statusProduced: "part1_ready",
            notificationRecipients: n("Payroll admins"),
            emailRecipients: [],
            sideEffects: "Freezes the initial upload for review.",
          },
          {
            id: "review",
            name: "Send to review & approve",
            actor: "Payroll admin / approver",
            role: "Super Admin / HR Specialist / Finance Manager",
            statusProduced: "under_review → approved",
            notificationRecipients: n("Approvers", "Payroll owner"),
            emailRecipients: [],
            sideEffects: "Moves the batch through final review to approved.",
          },
          {
            id: "lock",
            name: "Lock batch",
            actor: "Finance / Super Admin",
            role: "Super Admin / Finance Manager",
            statusProduced: "locked",
            notificationRecipients: n("Payroll admins"),
            emailRecipients: [],
            sideEffects: "Locks payroll edits; payslips become available.",
          },
        ],
      },
      {
        key: "payslip-notification",
        name: "Payslip Publish & Notification",
        summary: "Declared 'notify employees when payslips are ready' — not yet implemented.",
        steps: [
          {
            id: "publish",
            name: "Publish payslips on lock",
            actor: "System",
            role: "System",
            statusProduced: "(payslips available)",
            notificationRecipients: n("Employees (declared — payslip ready)"),
            emailRecipients: [],
            fallbackEscalation: "No fallback for failed payslip-notification delivery.",
            sideEffects: "The lock step declares an employee payslip notification.",
          },
        ],
        gaps: [
          "No payslip-notification producer or cron exists yet — the declared 'notify employees' is not sent.",
          "No 'payslip' email notification type or policy is configured.",
        ],
      },
    ],
  },

  // ===========================================================================
  // 6. Coaching
  // ===========================================================================
  {
    key: "coaching",
    name: "Coaching",
    status: "Active",
    riskLevel: "Medium",
    summary: "Field coaching report: creation, submission, review and acknowledgement.",
    modulesAffected: n("coaching_reports", "coaching_score_items", "coaching_report_acknowledgments", "notification_events"),
    subflows: [
      {
        key: "report",
        name: "Coaching Report",
        summary: "Draft → submit → employee acknowledgement.",
        governedByRegistry: true,
        registryModuleKey: "coaching_reports",
        steps: [
          {
            id: "draft",
            name: "Create / update draft",
            actor: "Training Manager",
            role: "Training Manager / Super Admin",
            statusProduced: "draft",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Creates/updates report and score items.",
          },
          {
            id: "submit",
            name: "Submit report",
            actor: "Training Manager",
            role: "Training Manager / Super Admin",
            statusProduced: "submitted",
            notificationRecipients: n("Medical Rep (the coached employee)"),
            emailRecipients: [],
            sideEffects: "Computes score/zone; enqueues an in-app notification to the rep.",
          },
          {
            id: "acknowledge",
            name: "Employee acknowledges",
            actor: "Medical Rep",
            role: "Employee (must match the coached rep)",
            statusProduced: "reviewed_by_employee",
            notificationRecipients: n("Training Manager"),
            emailRecipients: [],
            fallbackEscalation: "No manager/HR escalation if the rep never acknowledges.",
            sideEffects: "Records acknowledgement (one per report).",
          },
        ],
        gaps: ["Submission notifies only the rep — no manager/HR routing; the coach gets no confirmation."],
      },
      {
        key: "notifications",
        name: "Notifications",
        summary: "In-app only, to the coached rep.",
        steps: [
          {
            id: "notify",
            name: "Notify the coached rep",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Medical Rep (the coached employee)"),
            emailRecipients: [],
            sideEffects: "coaching_report_submitted in-app event.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 7. Marketing Requests (Beta)
  // ===========================================================================
  {
    key: "marketing",
    name: "Marketing Requests",
    status: "Draft",
    beta: true,
    riskLevel: "High",
    summary: "HCP/pharmacy marketing requests with validation and approval (Beta).",
    modulesAffected: n("marketing_requests", "marketing_request_approval_steps", "marketing_request_finance_requirements"),
    subflows: [
      {
        key: "submission",
        name: "Request Submission",
        governedByRegistry: true,
        registryModuleKey: "marketing_requests",
        steps: [
          {
            id: "draft_submit",
            name: "Draft then submit",
            actor: "Creator (rep / manager / marketing)",
            role: "Marketing creator roles",
            statusProduced: "draft → pending_validation",
            notificationRecipients: n("Requester", "Manager (if assigned)"),
            emailRecipients: n("Requester", "Manager (if assigned)"),
            sideEffects: "Creates request; computes ROI preview; validates products/pharmacy codes.",
          },
        ],
      },
      {
        key: "validation",
        name: "Validation",
        steps: [
          {
            id: "validate",
            name: "SFE validates request",
            actor: "SFE Manager",
            role: "SFE Manager / Super Admin",
            statusProduced: "pending_approval",
            notificationRecipients: n("Requester"),
            emailRecipients: n("Requester"),
            sideEffects: "Updates validation state on customers/pharmacies.",
          },
        ],
      },
      {
        key: "approval",
        name: "Approval / Return / Reject",
        steps: [
          {
            id: "decision",
            name: "Finance / approver decision",
            actor: "Finance / scoped approver",
            role: "Finance Manager / Super Admin / assigned role",
            statusProduced: "approved | rejected | returned",
            notificationRecipients: n("Requester", "Manager"),
            emailRecipients: n("Requester"),
            sideEffects: "On approval creates the finance requirement (invoice/deadline).",
          },
        ],
        gaps: ["Approval-step rows are not consistently written; finance-hold transitions are not implemented."],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        steps: [
          {
            id: "notify",
            name: "Notify requester / manager",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Requester", "Manager"),
            emailRecipients: n("Requester", "Manager"),
            sideEffects: "request_submitted / approved / rejected events.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 8. Notifications & Communication (cross-cutting — not a duplicate of flows)
  // ===========================================================================
  {
    key: "notifications",
    name: "Notifications & Communication",
    status: "Read-only map",
    crossCutting: true,
    riskLevel: "Medium",
    summary: "Cross-cutting delivery infrastructure shared by every workflow.",
    modulesAffected: n("notification_events", "notification_outbox", "email templates", "src/lib/notifications/recipients.ts"),
    subflows: [
      {
        key: "recipient-resolver",
        name: "Recipient Resolver",
        summary: "How a notification's audience is computed and isolated.",
        steps: [
          {
            id: "resolve",
            name: "Resolve & isolate recipients",
            actor: "System",
            role: "System",
            statusProduced: "(audience resolved)",
            notificationRecipients: n("Employee subject", "Explicit recipients (valid HR_IDs only)"),
            emailRecipients: [],
            sideEffects: "Fail-closed recipient isolation; fixture/email/PHASE tokens ignored; personal-bell category allowlist.",
          },
        ],
      },
      {
        key: "channels",
        name: "Email vs In-App",
        summary: "Which channel each event uses.",
        steps: [
          {
            id: "channels",
            name: "Route to email and/or in-app",
            actor: "System",
            role: "System",
            statusProduced: "(channel selected)",
            notificationRecipients: n("In-app: vacation, probation, coaching, general, internal_message, excuse"),
            emailRecipients: n("Email: leave, probation_alert, contract_renewal, resignation, offers"),
            sideEffects: "Outbox model for email; in-app via notification_events.",
          },
        ],
      },
      {
        key: "templates",
        name: "Template Clarity",
        summary: "Subject-first, name-led notification content.",
        steps: [
          {
            id: "templates",
            name: "Clear, subject-first content",
            actor: "System",
            role: "System",
            statusProduced: "(rendered)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Name-led titles, humanized status, action rows, no raw UUIDs or sensitive fields.",
          },
        ],
      },
      {
        key: "escalation",
        name: "Escalation & Reminder Rules",
        summary: "Scheduled reminders and missing-recipient handling.",
        steps: [
          {
            id: "escalation",
            name: "Reminders & escalation",
            actor: "System (daily cron)",
            role: "System",
            statusProduced: "(reminder sent)",
            notificationRecipients: n("Manager", "HR", "Training Manager"),
            emailRecipients: n("Manager chain"),
            fallbackEscalation: "Probation reminders (30/15/7 days); contract-renewal daily cron.",
            sideEffects: "Two daily Vercel crons; outbox + probation reminders piggyback the renewal cron.",
          },
        ],
        gaps: ["Several flows lack manager-of-manager / HR escalation when a primary recipient is missing."],
      },
    ],
  },
];

export function listWorkflowDomains(): readonly WorkflowControlDomain[] {
  return WORKFLOW_CONTROL_DOMAINS;
}

export function getWorkflowDomain(key: string): WorkflowControlDomain | undefined {
  const needle = key.trim().toLowerCase();
  return WORKFLOW_CONTROL_DOMAINS.find((domain) => domain.key === needle);
}

export function workflowDomainKeys(): string[] {
  return WORKFLOW_CONTROL_DOMAINS.map((domain) => domain.key);
}

export function getWorkflowSubflow(domainKey: string, subflowKey: string): WorkflowSubflow | undefined {
  const domain = getWorkflowDomain(domainKey);
  if (!domain) return undefined;
  const needle = subflowKey.trim().toLowerCase();
  return domain.subflows.find((subflow) => subflow.key === needle);
}

export function subflowKeys(domainKey: string): string[] {
  return getWorkflowDomain(domainKey)?.subflows.map((s) => s.key) ?? [];
}

/** Total step count across all subflows of a domain (for the library card). */
export function domainStepCount(domain: WorkflowControlDomain): number {
  return domain.subflows.reduce((sum, subflow) => sum + subflow.steps.length, 0);
}
