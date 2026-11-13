/**
 * Workflow Control Center — Phase 1.5 static, READ-ONLY workflow map.
 *
 * Business-friendly grouping: a SMALL set of top-level DOMAINS, each containing
 * named SUBFLOWS. Every subflow is a faithful, code-derived mini-flow of boxes
 * (steps). Each step records actor, responsible role, status produced, in-app
 * notification recipients (split into action-required vs FYI where meaningful),
 * email recipients, fallback/escalation, side effects, and any known gap —
 * including an explicit "notification not implemented yet" flag.
 *
 * PURE DATA: no database access, no service calls, no server-only imports.
 * Phase 1 does NOT change runtime workflow execution or approval logic.
 */

// "Partially implemented" is the honest middle: some subflows run, some are still specification.
// Read the per-subflow gaps -- the domain badge alone cannot tell you which is which.
export type WorkflowControlStatus =
  | "Active"
  | "Draft"
  | "Read-only map"
  | "Partially implemented"
  | "Not implemented";
export type WorkflowControlRisk = "Low" | "Medium" | "High";

export type WorkflowControlStep = {
  id: string;
  name: string;
  actor: string;
  role: string;
  statusProduced: string;
  /** In-app notification recipients (full audience). */
  notificationRecipients: string[];
  /** Email recipients. */
  emailRecipients: string[];
  /** Subset of recipients who must ACT (action-required alert). */
  actionRequiredRecipients?: string[];
  /** Subset of recipients notified for awareness only (FYI). */
  fyiRecipients?: string[];
  /** True when NO notification producer is implemented for this step yet. */
  notificationGap?: boolean;
  /** Fallback / escalation behavior, if any. */
  fallbackEscalation?: string;
  /** Module side effects this step triggers. */
  sideEffects: string;
  /** Where this step routes next / who acts (explicit, business-friendly). */
  routesTo?: string;
  /** A known gap specific to this step, surfaced read-only. */
  knownGap?: string;
};

export type WorkflowSubflow = {
  key: string;
  name: string;
  summary?: string;
  governedByRegistry?: boolean;
  registryModuleKey?: string;
  steps: WorkflowControlStep[];
  gaps?: string[];
  /**
   * True when NONE of these steps run — the subflow is specification only.
   *
   * Explicit rather than inferred from the gap text: a domain can be partly built, and a subflow
   * that IS built can still carry a "NOT BUILT" gap about something it does not cover. Sniffing
   * the prose would then warn that a live subflow does nothing.
   */
  notImplemented?: boolean;
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
    modulesAffected: n("v2_vacation_requests", "v2_vacation_request_events", "vacation balance", "in-app notifications", "audit_logs"),
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
            notificationRecipients: n("Direct manager", "Manager-of-manager (if exists)", "HR Managers"),
            actionRequiredRecipients: n("Direct manager"),
            fyiRecipients: n("Manager-of-manager (if exists)", "HR Managers"),
            emailRecipients: n("Direct manager"),
            fallbackEscalation: "Submission fails if the employee has no direct manager (no auto-escalation).",
            sideEffects: "Creates request with computed paid/unpaid balance; generates manager email token (14-day TTL); writes event + audit log.",
          },
          {
            id: "manager_decision",
            name: "Direct manager approval",
            actor: "Direct manager",
            role: "District Manager / Manager / Regional Manager / NSM / Super Admin",
            statusProduced: "pending_hr",
            routesTo: "HR Manager",
            notificationRecipients: n("Employee", "Manager-of-manager (if exists)", "HR Managers"),
            actionRequiredRecipients: n("HR Managers"),
            fyiRecipients: n("Employee", "Manager-of-manager (if exists)"),
            emailRecipients: [],
            sideEffects: "Records manager decision + timestamp; transitions to pending_hr; writes event + audit log.",
          },
          {
            id: "hr_decision",
            name: "HR final decision",
            actor: "HR Manager",
            role: "Super Admin / CEO",
            statusProduced: "approved | rejected",
            notificationRecipients: n("Employee", "Manager-of-manager (if exists)", "HR Managers"),
            fyiRecipients: n("Employee", "Manager-of-manager (if exists)", "HR Managers"),
            emailRecipients: n("Employee", "CC: HR Managers + manager-of-manager"),
            sideEffects: "On approval recalculates and consumes balance; writes event + audit log; marks email token used.",
          },
        ],
        gaps: ["An employee with no linked direct manager still submits normally, but the request then stalls: it cannot be decided until HR assigns a management approver (assignVacationApprover). The HR queue flags it as \"Missing direct manager\"."],
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
            notificationRecipients: n("Employee", "Direct manager", "Manager-of-manager", "HR Managers"),
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
      {
        // No registry module and no transition table in code: excuses/service.ts moves the status by a
        // compare-and-set on pending_manager. Mapped so the map names every request flow (REC-005).
        key: "excuse",
        name: "Excuse Request & Approval",
        summary: "Employee asks for an excuse → the direct manager decides. No HR step.",
        steps: [
          {
            id: "submit",
            name: "Employee submits an excuse",
            actor: "Employee",
            role: "Any employee except District and Regional Managers",
            statusProduced: "pending_manager",
            routesTo: "Direct manager",
            notificationRecipients: n("Direct manager", "HR visibility recipients"),
            actionRequiredRecipients: n("Direct manager"),
            fyiRecipients: n("HR visibility recipients"),
            emailRecipients: n("Direct manager"),
            fallbackEscalation:
              "Refused outright when no direct manager is linked, or when the manager is a District or Regional Manager. A Super Admin can reassign the manager (reassignExcuseManager), which re-notifies the new one. A daily reminder goes to the manager once an excuse has waited two days.",
            sideEffects: "Creates the v2_excuse_requests row at pending_manager.",
          },
          {
            id: "manager_decision",
            name: "Direct manager decides",
            actor: "Direct manager",
            role: "The assigned manager only — no Super Admin stand-in",
            statusProduced: "approved | rejected | returned_to_employee",
            notificationRecipients: n("Employee", "HR visibility recipients"),
            fyiRecipients: n("Employee", "HR visibility recipients"),
            emailRecipients: n("Employee"),
            sideEffects: "Writes the decision only while the request is still pending_manager; a return needs a comment.",
          },
          {
            id: "resubmit",
            name: "Employee resubmits a returned excuse",
            actor: "Employee",
            role: "Employee",
            statusProduced: "pending_manager",
            routesTo: "Direct manager",
            notificationRecipients: n("Direct manager"),
            actionRequiredRecipients: n("Direct manager"),
            emailRecipients: n("Direct manager"),
            sideEffects: "Moves returned_to_employee back to pending_manager.",
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
    modulesAffected: n("outstation_expense_requests", "outstation_expenses", "storage (evidence)"),
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
            routesTo: "Super Admin approver",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Creates request capturing amount, eligibility and fraud flags, and leaves it PENDING — nothing reaches payroll until a Super Admin approves it in the queue (owner decision 2026-08-08; it used to auto-approve into payroll staging on submit). Raises the awaiting-approval alert: To the employee, Cc their manager and skip-level, Bcc active Super Admins.",
          },
          {
            id: "decision",
            name: "Approve / reject",
            actor: "HR Manager",
            // Corrected 2026-08-10. This read "Super Admin / Finance Manager / CEO" and was wrong in
            // both directions: adminOutstationRoles has only ever been Super Admin, and Finance
            // Manager/CEO were read-only. Finance Manager is now out of the module entirely (owner:
            // "exclude him 100% from outstation or expenses"). This string is rendered in the
            // Workflow Control UI, so a stale role here reads as policy.
            role: "Super Admin (HR Manager)",
            statusProduced: "approved | rejected",
            notificationRecipients: n("Employee (submitter) — on rejection only"),
            fyiRecipients: n("Employee (submitter) — on rejection only"),
            // Never emailed (owner rule 2026-09-19) — outstation-rejection-channel-guard.ts.
            emailRecipients: [],
            sideEffects: "Approval makes the expense eligible for manual payroll import. Only REJECTION notifies the submitter (notifyOutstationDecision, reason included, on in-app + Telegram + push — never email); approval is silent.",
          },
        ],
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
            routesTo: "Super Admin approver (after validation)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Uploads car evidence / tickets; writes location audit with fraud flags, and leaves the request PENDING — nothing reaches payroll until a Super Admin approves it in the queue (owner decision 2026-08-08; it used to auto-approve into payroll staging on submit). Raises the awaiting-approval alert: To the employee, Cc their manager and skip-level, Bcc active Super Admins.",
          },
          {
            id: "admin_review",
            name: "Admin reviews & approves/rejects",
            actor: "HR Manager",
            // Corrected 2026-08-10 — see the `decision` step above for why.
            role: "Super Admin (HR Manager)",
            statusProduced: "approved | rejected",
            notificationRecipients: n("Employee (submitter) — on rejection only"),
            fyiRecipients: n("Employee (submitter) — on rejection only"),
            // Never emailed (owner rule 2026-09-19) — outstation-rejection-channel-guard.ts.
            emailRecipients: [],
            fallbackEscalation: "Rejection blocked once imported to payroll.",
            sideEffects: "On approve creates/updates the linked payroll expense. Only REJECTION notifies the submitter (notifyOutstationDecision, reason included, on in-app + Telegram + push — never email); approval is silent.",
          },
        ],
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
            actor: "HR Manager",
            // Corrected 2026-08-10 — see the `decision` step earlier in this module.
            role: "Super Admin (HR Manager)",
            statusProduced: "approved",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Creates/updates the linked outstation_expenses row. Approval is silent — no notification is sent (only rejection notifies the submitter).",
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
            actor: "HR Manager",
            // Corrected 2026-08-10 — see the `decision` step earlier in this module.
            role: "Super Admin (HR Manager)",
            statusProduced: "added_to_payroll",
            notificationRecipients: [],
            emailRecipients: [],
            fallbackEscalation: "Only from 'approved'; locks the expense once imported.",
            sideEffects: "Links the expense to a payroll run and locks edit/delete. No notification is sent — the payroll-import step is silent.",
          },
        ],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        summary: "One alert: the employee is notified on rejection only.",
        steps: [
          {
            id: "notify",
            name: "Notify employee on rejection",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Employee (submitter) — on rejection only"),
            // Never emailed (owner rule 2026-09-19) — outstation-rejection-channel-guard.ts.
            emailRecipients: [],
            sideEffects: "Outstation/expenses sends exactly ONE decision notification: notifyOutstationDecision on REJECTION → the submitter (reason included, in-app + Telegram + push — never email). Approve and payroll-import are intentionally silent.",
          },
        ],
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
        registryModuleKey: "probation",
        steps: [
          {
            id: "evaluation_requested",
            name: "System / HR Manager creates evaluation",
            actor: "HR Manager or scheduled reminder",
            role: "Super Admin / system",
            statusProduced: "evaluation_requested",
            notificationRecipients: n("Direct manager", "Manager-of-manager", "HR", "Training Manager"),
            actionRequiredRecipients: n("Direct manager"),
            fyiRecipients: n("Manager-of-manager", "HR", "Training Manager"),
            emailRecipients: n("probation_alert"),
            sideEffects: "Creates evaluation + history; schedules reminder events.",
          },
          {
            id: "manager_feedback",
            name: "Manager submits feedback",
            actor: "Direct manager (manager-of-manager fallback)",
            role: "Manager / Super Admin",
            statusProduced: "manager_feedback",
            notificationRecipients: n("Direct manager", "HR", "Training Manager"),
            actionRequiredRecipients: n("HR"),
            fyiRecipients: n("Direct manager", "Training Manager"),
            emailRecipients: n("probation_alert"),
            sideEffects: "Records manager feedback + reviewer.",
          },
          {
            id: "hr_decision",
            name: "HR decides (pass / terminate)",
            actor: "HR Manager",
            role: "Super Admin",
            statusProduced: "probation_passed | probation_terminated",
            notificationRecipients: n("Direct manager", "HR", "Training Manager"),
            fyiRecipients: n("Direct manager", "HR", "Training Manager"),
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
        registryModuleKey: "contracts",
        steps: [
          {
            id: "requested",
            name: "Create renewal request",
            actor: "HR Manager",
            role: "Super Admin",
            statusProduced: "requested",
            notificationRecipients: n("Employee"),
            fyiRecipients: n("Employee"),
            emailRecipients: n("Manager chain (fallback HR inbox)"),
            sideEffects: "Enforces one active renewal per employee.",
            knownGap: "In-app notification goes only to the employee; manager/HR reviewers get email only.",
          },
          {
            id: "review",
            name: "Manager then HR review",
            actor: "Manager → HR Manager",
            role: "Manager chain / Super Admin / CEO",
            statusProduced: "manager_review → hr_review",
            notificationRecipients: n("HR / stakeholders (email)"),
            emailRecipients: n("Manager chain / HR"),
            sideEffects: "Records reviewers; signed contract may be uploaded.",
          },
          {
            id: "decision",
            name: "Renew / Not renew / Cancel",
            actor: "HR Manager",
            role: "Super Admin / CEO",
            statusProduced: "renewed | not_renewed | cancelled",
            notificationRecipients: n("Employee (on renew)", "Stakeholders"),
            fyiRecipients: n("Employee (on renew)", "Stakeholders"),
            emailRecipients: n("Employee (renew)", "Stakeholders"),
            sideEffects: "On renew: expires old contract, creates new active contract.",
          },
        ],
      },
      {
        key: "resignation",
        name: "Resignation",
        governedByRegistry: true,
        registryModuleKey: "resignations",
        steps: [
          {
            id: "submitted",
            name: "Submit resignation",
            actor: "HR or employee self-service",
            role: "Per registry (resignation_submit)",
            statusProduced: "resignation_submitted",
            notificationRecipients: n("Super Admin", "HR Operations"),
            emailRecipients: n("Super Admin", "HR Operations"),
            sideEffects:
              "Terminal employment status; hides from organogram; deactivates access; optionally opens vacancy. Delivered in-app, email, Telegram and push (policy row resignations.*), and the in-app copy DOES render in the personal bell — its category resolves to \"general\", which is on the allowlist. Audience is owner-set (2026-08-09) and resolved from the admin-editable resignation_workflow_alert role policy: Super Admin + HR Operations only (the Talent Acquisition seat this policy named originally was retired 2026-08-28). manager_chain was deliberately removed so a resignation never fans out up the org chart.",
          },
          {
            id: "review_approve_complete",
            name: "Review → approve → complete",
            actor: "HR / approver",
            role: "Per registry",
            statusProduced: "under_review → approved → completed",
            notificationRecipients: n("Super Admin", "HR Operations"),
            emailRecipients: n("Super Admin", "HR Operations"),
            fallbackEscalation: "Reject / Reopen / Cancel available from earlier states.",
            sideEffects: "Marks the employee fully separated.",
          },
        ],
      },
      {
        key: "contract-non-renewal",
        name: "Contract Non-Renewal",
        summary: "A renewal resolved as \"not renew\" terminates the employee and opens the vacancy.",
        steps: [
          {
            id: "not_renewed",
            name: "Resolve renewal as \"not renew\"",
            actor: "HR Manager",
            role: "Super Admin / CEO",
            statusProduced: "not_renewed",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects:
              "Terminates the employee and opens the position vacancy through resignEmployeeAndOpenVacancy — the same helper every other termination uses — stamping the reason \"Contract not renewed (request <id>)\" so the termination is attributable to this flow. The employee then loses organogram_visible, has their EU-organogram seat released by au.resign_occupant, and drops out of v_payroll_eligible_employees. No resignation notice is sent, deliberately (suppressWorkflowNotification): a non-renewal is a COMPANY decision, and the resignation notice would frame it to recipients as voluntary. Live behind the WP6_CONTRACT_NON_RENEWAL_TERMINAL_ENABLED kill switch (src/lib/contracts/feature-flags.ts), with the schema confirmed on staging and production.",
          },
        ],
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
      {
        // Registered (report_it, migration 20261113211605) for this map ONLY (REC-005, REC-033). It sits
        // here because the map holds at most ten domains and all ten are taken; a safety report is
        // raised by an employee and worked by one named person, the nearest of the ten. The move is
        // decided by phx_report_it_set_status (compare-and-set) and changeReportStatus never asks the
        // registry. REPORT_IT_TRANSITIONS (src/lib/report-it/lifecycle.ts) writes the two moves down and
        // tests/workflow-registry-coverage.test.ts holds the seed equal to it.
        key: "report-it",
        name: "Report It (safety reports)",
        summary: "An employee files a safety report → its owner assesses it → closes it. Forward only, no reopen; due in 15 days if serious, 90 otherwise.",
        governedByRegistry: false,
        registryModuleKey: "report_it",
        steps: [
          {
            id: "received",
            name: "File a safety report",
            actor: "Any employee",
            role: "Any role with Report It create",
            statusProduced: "received",
            notificationRecipients: n("The Report It owner (report_it_dashboard_access)"),
            emailRecipients: n("The Report It owner (report_it_dashboard_access)"),
            sideEffects: "Stamps the due date (15 calendar days if serious, 90 otherwise). The owner's notice and email carry the report number and time only, never patient data.",
          },
          {
            id: "start_assessment",
            name: "Start assessment",
            actor: "The Report It desk",
            role: "Report It owner, Super Admin, CEO or Finance Manager",
            statusProduced: "under_assessment",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "One database call moves the status and writes the report_it_audit_logs row; two presses move it once.",
          },
          {
            id: "close",
            name: "Close the report",
            actor: "The Report It desk",
            role: "Report It owner, Super Admin, CEO or Finance Manager",
            statusProduced: "closed",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Closed is final; a report that needs more work is filed again as a follow-up.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 4. Offer & Hiring
  // ===========================================================================
  // PARTIALLY BUILT as of 2026-08-21. The internal offer now exists and is governed: `ats_offers`
  // holds one offer per application, and prepare -> submit -> approve -> send -> record-answer each
  // run through assertRecruitmentTransition against the live workflow registry, writing to
  // `ats_application_events`. Approval is Super-Admin-only, and an unapproved offer is refused at
  // send — the registry on its own allows offer_initiated -> offer_sent, so that guard lives in
  // src/lib/recruitment/offers.ts and is pinned by tests/recruitment-offers.test.ts.
  //
  // What is still NOT built is everything candidate-facing: there are no accept/reject links, no
  // token, no expiry job, and no email to the candidate at any point. Owner decision 2026-08-21 —
  // no automatic applicant email; the offer goes out however letters go out today and a recruiter
  // records the answer they were given. `job_offers` / `job_offer_audit_logs` were never created
  // and are not planned. `src/config/offer-approval.ts` (salary thresholds, CEO caps, always-approve
  // roles) was DELETED on 2026-08-29 by owner decision: it had zero call sites since 16 June and only
  // described an approval chain nobody had agreed to. Approval is one Super-Admin step at any figure;
  // a threshold chain is a fresh decision if it is ever wanted, not a file to revive.
  // The candidate-driven steps below are kept as specification, not description.
  {
    key: "offer-hiring",
    name: "Offer & Hiring",
    status: "Partially implemented",
    riskLevel: "High",
    summary:
      "The internal offer is live and governed — prepared, approved by a Super Admin, then recorded as sent. Nothing candidate-facing exists: no accept/reject link, no expiry job, and no email to the applicant.",
    modulesAffected: n("ats_offers", "ats_applications", "ats_application_events", "employees", "position_vacancies"),
    subflows: [
      {
        key: "offer",
        name: "Offer Lifecycle",
        governedByRegistry: true,
        registryModuleKey: "recruitment",
        steps: [
          {
            id: "offer_prepare",
            name: "Prepare the offer draft",
            actor: "Talent Acquisition",
            role: "Talent Acquisition / Super Admin",
            statusProduced: "offer_draft",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects:
              "Writes the terms (job title, monthly gross, start date) to ats_offers. Editing them again clears any previous approval.",
          },
          {
            id: "offer_submit_approval",
            name: "Submit the offer for approval",
            actor: "Talent Acquisition",
            role: "Talent Acquisition / Super Admin",
            statusProduced: "offer_pending_approval",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Refused while any of the three terms is missing.",
          },
          {
            id: "offer_approved",
            name: "Approve the offer",
            actor: "Super Admin",
            role: "Super Admin",
            statusProduced: "offer_approved | offer_draft (sent back)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects:
              "Super-Admin-only in the workflow registry, so the recruiter who prepared an offer cannot approve it. Sending it back returns it to draft and voids the submission.",
          },
          {
            id: "offer_sent",
            name: "Record the offer as sent",
            actor: "Talent Acquisition",
            role: "Talent Acquisition / Super Admin",
            statusProduced: "offer_sent",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects:
              "Refused unless the offer is approved. Nothing is emailed — the letter goes out as it does today and this records that it went.",
          },
          {
            id: "offer_answer",
            name: "Record the candidate's answer",
            actor: "Talent Acquisition",
            role: "Talent Acquisition / Super Admin",
            statusProduced: "offer_accepted | offer_declined | offer_expired | offer_negotiation",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "The answer is recorded by whoever heard it; the candidate has no way to respond in-system.",
          },
        ],
        gaps: [
          "NOT BUILT: nothing candidate-facing — no accept/reject link, no token, and no email to the applicant at any step. Owner decision 2026-08-21: the answer is recorded by the recruiter who heard it.",
          "NOT BUILT: offer_expired is recorded by hand. There is no expiry date on an offer and no job that lapses one.",
          "BY DESIGN: approval is a single Super-Admin step regardless of the figure — there is no salary threshold, no CEO cap and no Finance step. src/config/offer-approval.ts held exactly that policy, unused, and was deleted 2026-08-29 by owner decision; a threshold chain is a new decision to take, not a file to restore.",
        ],
      },
      {
        key: "acceptance",
        notImplemented: true,
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
            actionRequiredRecipients: n("HR team"),
            fyiRecipients: n("Candidate"),
            emailRecipients: n("HR team", "Candidate"),
            sideEffects: "Moves the record into the hired pipeline (pending HR approval).",
          },
        ],
        gaps: [
          "NOT BUILT: there is no candidate-facing accept or reject route. The stage itself is now reachable — a recruiter records the answer through src/lib/recruitment/offers.ts — but the candidate never touches the system and is never emailed by it.",
        ],
      },
      {
        key: "hr-approval",
        notImplemented: true,
        name: "HR Approval & Employee Creation",
        summary: "HR converts an accepted offer into an employee.",
        steps: [
          {
            id: "approve_hire",
            name: "Approve hire & create employee",
            actor: "HR Manager",
            role: "Super Admin",
            statusProduced: "offer_hired",
            notificationRecipients: n("HR team"),
            fyiRecipients: n("HR team"),
            emailRecipients: n("HR team"),
            sideEffects: "Generates the employee_hr_id and provisions system access.",
          },
        ],
        gaps: [
          "NOT BUILT: nothing CREATES an employee from an accepted offer, and there is no approver step. The hire itself IS wired, though: the employee is added through the normal HR Add Employee flow first, and markApplicationHired (src/lib/recruitment/applications.ts, POST /api/recruitment/applications/[id]/convert) then links the application to that HR_ID, closes the requisition and best-effort seeds probation.",
          "NOT ENFORCED: that handoff is manual and unchecked in both directions — app_hire does not require an accepted offer to exist, and nothing compares the created employee's job title, salary or start date against the terms the Super Admin approved. An offer approved at one figure can be hired at another, silently.",
        ],
      },
      {
        key: "vacancy-fill",
        notImplemented: true,
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
        gaps: [
          "NOT BUILT, AND DELIBERATELY SO — this is not residue: no offer ever fills a vacancy. Seats are opened and closed by the HR employee lifecycle, never by this flow. tests/recruitment-vacancy-close-invariant.test.ts pins it: markApplicationHired and the requisition service must not touch position_vacancies, and closeVacancyOnHire (src/lib/employees/vacancy-closer.ts) is the only closer. Wiring this subflow up would turn that suite red — do not 'finish' it.",
        ],
      },
      {
        key: "notifications",
        notImplemented: true,
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
        gaps: [
          "NOT BUILT: no candidate or HR message is produced by this flow — nothing writes an offer notification to the outbox.",
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
            role: "Super Admin / Finance Manager",
            statusProduced: "part1_ready",
            notificationRecipients: n("Payroll admins"),
            fyiRecipients: n("Payroll admins"),
            emailRecipients: [],
            sideEffects: "Freezes the initial upload for review.",
          },
          {
            id: "review",
            name: "Send to review & approve",
            actor: "Payroll admin / approver",
            role: "Super Admin / Finance Manager",
            statusProduced: "under_review → approved",
            notificationRecipients: n("Approvers", "Payroll owner"),
            actionRequiredRecipients: n("Approvers"),
            fyiRecipients: n("Payroll owner"),
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
            fyiRecipients: n("Payroll admins"),
            emailRecipients: [],
            sideEffects: "Locks payroll edits; payslips become available.",
          },
        ],
      },
      {
        key: "payslip-notification",
        name: "Payslip Publish & Notification",
        summary: "Every employee in an approved batch is told their payslip is ready.",
        steps: [
          {
            id: "publish",
            name: "Notify employees on batch approval",
            actor: "System",
            role: "System",
            statusProduced: "(payslips available)",
            notificationRecipients: n("Each employee in the batch"),
            emailRecipients: [],
            sideEffects:
              "notifyPayslipAvailable (src/lib/payroll/notify-payslip-available.ts) sends one notification per employee in the batch, under a per-employee idempotency key, at the moment payslips become visible. TWO callers: the old payroll module's \"approve\" transition, and Automated Payroll's publish. It used to be a helper private to the workflow route, which is exactly why Automated Payroll could not reach it and 205 employees across two published months were never told. Best-effort by design — a delivery failure never blocks payroll — but the counts are returned and recorded in the run's audit row, so a month that told nobody is readable as one.",
            fallbackEscalation:
              "Owner rule: a payslip is NEVER emailed. Delivery is in-app + generic Telegram only (policy row payroll.payslip_available), and payslip-channel-guard strips the email channel as a hard backstop at four further layers. The absence of a payslip email type is the rule, not a gap.",
          },
        ],
      },
      {
        // Registered (automated_payroll_runs, migration 20261113201813) for this map ONLY. The run
        // moves money, so run-service.ts never asks the registry: each phase change claims the run
        // itself (claimTransition). AUTOMATED_PAYROLL_RUN_TRANSITIONS writes the six moves down and
        // tests/workflow-registry-coverage.test.ts holds the claim sites and the seed to it.
        key: "automated-run",
        name: "Automated Payroll Run",
        summary: "Part 1 → Part 2 → ready → published, Super Admin only. Registered for the map; the run service does not read the registry.",
        governedByRegistry: false,
        registryModuleKey: "automated_payroll_runs",
        steps: [
          {
            id: "confirm_part1",
            name: "Confirm Part 1",
            actor: "HR (Super Admin)",
            role: "Super Admin",
            statusProduced: "part2",
            notificationRecipients: n("CEO", "Financial Advisor", "Finance Manager"),
            fyiRecipients: n("CEO", "Financial Advisor", "Finance Manager"),
            emailRecipients: n("CEO", "Financial Advisor", "Finance Manager", "The named Part 1 reviewers"),
            sideEffects: "Needs every Part 1 step confirmed; stamps who confirmed Part 1 and moves the run to Part 2 under one claim.",
          },
          {
            id: "confirm_part2",
            name: "Confirm Part 2",
            actor: "HR (Super Admin)",
            role: "Super Admin",
            statusProduced: "ready",
            notificationRecipients: n("CEO", "Financial Advisor", "Finance Manager"),
            fyiRecipients: n("CEO", "Financial Advisor", "Finance Manager"),
            emailRecipients: n("CEO", "Financial Advisor", "Finance Manager"),
            sideEffects: "Stamps who confirmed Part 2 and moves the run to ready under one claim.",
          },
          {
            id: "publish",
            name: "Publish to payslips",
            actor: "Super Admin",
            role: "Super Admin",
            statusProduced: "published",
            notificationRecipients: n("CEO", "Financial Advisor", "Finance Manager", "Each employee paid in the run"),
            fyiRecipients: n("CEO", "Financial Advisor", "Finance Manager", "Each employee paid in the run"),
            emailRecipients: n("CEO", "Financial Advisor", "Finance Manager"),
            sideEffects:
              "Writes and approves the salary batch, then marks the run published and records who was held in one database call; carried trips are marked paid. Employees are told in-app and on Telegram, never by email.",
          },
          {
            id: "reopen_or_cancel",
            name: "Reopen Part 1 / Part 2, or cancel",
            actor: "HR (Super Admin)",
            role: "Super Admin",
            statusProduced: "part1 | part2 | cancelled",
            notificationRecipients: [],
            emailRecipients: [],
            fallbackEscalation: "Refused after a bank file was downloaded unless an override with a reason is given.",
            sideEffects: "Reopen clears that part's confirmation; cancel releases the run's late-expense reservations and carry-forward ledger.",
          },
        ],
      },
      {
        // The registry row (private_calendar_data_disputes) is visibility only, as its migration
        // 20260722150000 says: the decision is a compare-and-set in private-calendar/disputes.ts.
        key: "calendar-dispute",
        name: "Private Calendar Data Dispute",
        summary: "An employee disputes the data behind a day → a Super Admin accepts or rejects it. An accepted whole day is spared from a deduction.",
        governedByRegistry: false,
        registryModuleKey: "private_calendar_data_disputes",
        steps: [
          {
            id: "submit",
            name: "Employee disputes a day",
            actor: "Employee",
            role: "Employee",
            statusProduced: "pending_review",
            routesTo: "Super Admin",
            notificationRecipients: n("Super Admins"),
            actionRequiredRecipients: n("Super Admins"),
            emailRecipients: n("Super Admins"),
            sideEffects: "Stores the claim, where it can be verified, and any attachments; one pending dispute per day.",
          },
          {
            id: "decide",
            name: "Super Admin decides",
            actor: "Super Admin",
            role: "Super Admin",
            statusProduced: "accepted | rejected",
            notificationRecipients: n("Employee"),
            fyiRecipients: n("Employee"),
            emailRecipients: n("Employee"),
            sideEffects: "Writes the decision only while pending_review, with an audit row. An accepted whole day counts as a proven worked day and is removed from a deduction charge.",
          },
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
            actor: "Coach (Training / Product Manager)",
            role: "Training Manager / Product Manager / Group Product Manager / Super Admin",
            statusProduced: "draft",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Creates/updates report and score items.",
          },
          {
            id: "submit",
            name: "Submit report",
            actor: "Coach (Training / Product Manager)",
            role: "Training Manager / Product Manager / Group Product Manager / Super Admin",
            statusProduced: "submitted",
            notificationRecipients: n("Medical Rep (the coached employee)"),
            actionRequiredRecipients: n("Medical Rep (the coached employee)"),
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
            fyiRecipients: n("Training Manager"),
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
  // 7. Marketing Requests
  // ===========================================================================
  {
    key: "marketing",
    name: "Marketing Requests",
    // LIVE, not "Draft". Production held 23 real requests on 2026-08-29 — created from 2026-08-02 and
    // still arriving that day, every one of them submitted, 4 approved and 5 rejected. It carried
    // "Draft" + beta only because nobody revisited the label once the module went into service, and a
    // Draft/Beta badge on a live, money-adjacent approval flow tells a Super Admin not to trust figures
    // he should be trusting.
    //
    // NOT "Partially implemented": that status is reserved for offer-hiring, whose subflows are
    // specification only, and the test below pins that no other domain may claim it. Every marketing
    // subflow really runs. The one incomplete behaviour is the finance leg, and that belongs in the
    // approval subflow's `gaps` — where the UI already surfaces it per subflow — not in the domain badge.
    status: "Active",
    riskLevel: "High",
    summary: "HCP/pharmacy marketing requests with validation and approval. Live and carrying real requests.",
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
            actionRequiredRecipients: n("Manager (if assigned)"),
            fyiRecipients: n("Requester"),
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
            fyiRecipients: n("Requester"),
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
            fyiRecipients: n("Requester", "Manager"),
            emailRecipients: n("Requester"),
            sideEffects: "On approval creates the finance requirement (invoice/deadline).",
          },
        ],
        // Approval-step rows ARE written consistently — measured in production 2026-08-29: 123 rows
        // covering all 23 requests, none missing.
        //
        // Both halves of the old finance gap are now closed. Migration 20260829180000 makes the
        // decision RPC create the obligation in the same transaction as the approval, dated from
        // the finance_invoice_deadline_days control setting. The overdue marker then reads that
        // deadline back: resolveMarketingInvoiceObligation (src/lib/marketing-requests/
        // invoice-obligation.ts) is the single source of truth, used by the Approved Requests
        // table and by the report export, so both say "Overdue" where the stored column still
        // says 'pending'.
        //
        // The status is DERIVED, not stored, and that is deliberate rather than unfinished — a
        // nightly job flipping the column could only ever be wrong (it can die silently, and it
        // goes stale the moment a deadline is corrected forward). The 'overdue' value the CHECK
        // constraint allows therefore stays unused in the database on purpose.
        //
        // The push is wired too. Owner decision 2026-08-29, asked directly: "the requester and
        // finance". `/api/cron/marketing-invoice-overdue-nudge` tells each requester about their
        // OWN overdue invoices and sends finance one digest of all of them — in-app, Telegram and
        // push, never email (marketing lateness reminders lost email on 2026-07-25, and
        // marketing-sla-channel-guard.ts now blocks this event type too).
        //
        // The finance half is addressed through the `marketing_invoice_overdue_alert` audience, so
        // the owner can retarget or silence it at /admin/notification-recipients without a deploy.
        // The requester half deliberately is NOT configurable: being told your own invoice is late
        // is not an audience question.
        //
        // The one thing left is a SCREEN for finance. The Finance Manager holds the
        // `finance_execution` rung but is not in `marketingAdminWorkflowRoles`, so the only page
        // rendering the Invoice due column redirects him away, and the marketing inbox he can open
        // lists requests awaiting a decision — which excludes an approved one by definition. His
        // notification therefore carries the full facts and no link, rather than a button leading
        // somewhere that cannot show the thing it is about. Granting him that page is an access
        // decision and belongs to the owner, so it is recorded here rather than assumed.
        gaps: ["Finance is told about an overdue invoice but has no screen showing one: the Finance Manager is not in marketingAdminWorkflowRoles, so /admin/marketing-requests (the only page with the Invoice due column) redirects them away and the marketing inbox they can open excludes approved requests. Their alert carries the facts and no link. Granting them that page needs the owner's decision."],
      },
      {
        key: "finance-hold",
        name: "Finance Hold",
        summary: "An approved request whose invoice never arrived — flagged by the system, decided by a human.",
        steps: [
          {
            id: "flag_overdue",
            name: "Flag an approved request whose invoice is late",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects:
              "Read-only. loadMarketingFinanceHoldQueue asks resolveMarketingInvoiceObligation — the same module the Approved Requests tab and the export read — whether each obligation is late today in Africa/Cairo, and writes nothing. Lateness is defined in one place only, so the queue an admin acts on can never disagree with the screen they read it on. An invoice already submitted or cleared is never flagged: flagging one would freeze a request that owes nothing.",
            routesTo: "Super Admin, who decides whether to hold. Nothing happens without them.",
          },
          {
            id: "hold_release",
            name: "Super Admin places or releases the hold",
            actor: "Super Admin",
            role: "Super Admin",
            statusProduced: "finance_hold (held) | approved or active (released)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects:
              "Records the reason on the finance requirement BEFORE flipping the status, so a client request that times out — which still commits — can never leave a request frozen with no recorded why. The same write pauses the invoice obligation (pending to hold, and back on release), which is what silences the Overdue marker while a request is held rather than nagging about a pause someone chose; an invoice already submitted is left exactly as it is, in both directions. Both writes are compare-and-set, so two admins on the same queue cannot silently overwrite each other, and phx_capture_marketing_request_event records actor, from and to. A release returns the request to the status the event log says it was held from, never a guess.",
            fallbackEscalation:
              "None, deliberately. The system never holds or releases on its own — owner rule 2026-08-29, the same rule expenses run under: the system flags, a human decides. Do not add a cron or an auto-hold-once-overdue convenience.",
          },
        ],
        gaps: ["Placing or releasing a finance hold notifies nobody. The requester is not told that their approved request has been frozen, or that it has been let go again — the hold is visible only to someone already looking at the request, or at the hold queue. Who should receive that is an owner decision, not a default to assume."],
      },
      {
        key: "notifications",
        name: "Notifications & Emails",
        steps: [
          {
            id: "notify",
            name: "Notify requester / approver",
            actor: "System",
            role: "System",
            statusProduced: "(no status change)",
            notificationRecipients: n("Assigned approver (per step)", "Requester", "CC steps"),
            emailRecipients: n("Assigned approver (per step)", "Requester"),
            sideEffects:
              "Wired via notifyMarketingWorkflow → createSystemNotification: request_submitted/assigned (approver), request_approved (requester + all participants), request_rejected/returned (requester); plus daily SLA reminders (due_date_reminder/overdue_reminder) from runMarketingSlaDaily on the daily cron.",
          },
        ],
      },
      {
        // A separate module from marketing requests (src/lib/market-awareness). Its CEO step asks the
        // market_awareness registry row after MARKET_AWARENESS_TRANSITIONS; with no row the code
        // table decides alone (src/lib/market-awareness/workflow-registry.ts).
        key: "market-awareness",
        name: "Market Awareness Activity",
        summary: "Product manager raises an activity → the approval group in parallel → CEO → executed → closed.",
        governedByRegistry: true,
        registryModuleKey: "market_awareness",
        steps: [
          {
            id: "submit",
            name: "Product manager submits",
            actor: "Requester",
            role: "Product Manager / Group Product Manager",
            statusProduced: "pending_group",
            routesTo: "Marketing Manager and the National Sales Manager of every targeted line, at the same time",
            notificationRecipients: n("Every approver in the group"),
            actionRequiredRecipients: n("Every approver in the group"),
            emailRecipients: n("Every approver in the group", "CC: requester, requester's manager"),
            fallbackEscalation: "Refused, naming the line, when a targeted line has no National Sales Manager in the seat. If no approver resolves at all it goes straight to the CEO.",
            sideEffects: "Writes one approver slot per group member; a resubmission resets the whole group.",
          },
          {
            id: "group_decision",
            name: "Approval group decides",
            actor: "Marketing Manager / National Sales Manager (own line)",
            role: "Marketing Manager / National Sales Manager / Super Admin",
            statusProduced: "pending_ceo (when all approved) | returned | rejected | on_hold",
            routesTo: "CEO, once the last group member approves",
            notificationRecipients: n("CEO (when the group completes)", "Requester (return, reject or hold)"),
            actionRequiredRecipients: n("CEO (when the group completes)"),
            fyiRecipients: n("Requester (return, reject or hold)"),
            emailRecipients: n("CEO (when the group completes)"),
            fallbackEscalation: "A hold freezes the activity; the holder, the CEO or a Super Admin releases it back to the group.",
            sideEffects: "Fills the member's slot and moves the status in one database call; a return or hold needs a comment.",
          },
          {
            id: "ceo_decision",
            name: "CEO decides",
            actor: "CEO",
            role: "CEO / Super Admin",
            statusProduced: "approved | returned | rejected",
            notificationRecipients: n("National Sales Manager", "SFE Manager", "Finance Manager", "Requester (return or reject)"),
            fyiRecipients: n("National Sales Manager", "SFE Manager", "Finance Manager", "Requester (return or reject)"),
            emailRecipients: n("National Sales Manager", "SFE Manager", "Finance Manager"),
            sideEffects: "Only the CEO may approve at a different amount; the decision row and the status change are one statement.",
          },
          {
            id: "execute_close",
            name: "Executed, then closed",
            actor: "Requester",
            role: "Requester / Super Admin",
            statusProduced: "executed → closed",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "Finance marks the activity paid separately; it never approves. The requester may withdraw it until the CEO approves.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 8. Direct Orders (added 2026-11-13, REC-005 — on the registry since 20260718140000)
  // ===========================================================================
  {
    key: "direct-orders",
    name: "Direct Orders",
    status: "Active",
    riskLevel: "High",
    summary: "A rep's direct pharmacy order: SFE validation, the requester's management line, the CEO, then collection.",
    modulesAffected: n("direct_orders", "direct_order_approval_steps", "sales-of-sales batch", "notification_events"),
    subflows: [
      {
        key: "order",
        name: "Order Approval Chain",
        summary: "Submit → SFE Manager → management line → CEO. Each rung opens only after the one below approves.",
        governedByRegistry: true,
        registryModuleKey: "direct_orders",
        steps: [
          {
            id: "submit",
            name: "Rep submits the order",
            actor: "Requester",
            role: "Direct-order requester roles / Super Admin",
            statusProduced: "pending_approval",
            routesTo: "SFE Manager",
            notificationRecipients: n("First-rung approvers"),
            actionRequiredRecipients: n("First-rung approvers"),
            emailRecipients: n("First-rung approvers", "CC: SFE Manager, Super Admin"),
            sideEffects: "Creates the order and its approval rungs from the requester's management line.",
          },
          {
            id: "sfe_validation",
            name: "SFE Manager validates",
            actor: "SFE Manager",
            role: "SFE Manager / Super Admin",
            statusProduced: "pending_approval",
            routesTo: "Next rung of the management line",
            notificationRecipients: n("Next-rung approvers"),
            actionRequiredRecipients: n("Next-rung approvers"),
            emailRecipients: n("Next-rung approvers"),
            sideEffects: "Also confirms a hand-typed pharmacy's codes.",
          },
          {
            id: "management_line",
            name: "Management line approves",
            actor: "Regional Manager / National Sales Manager (by requester)",
            role: "The requester's actual manager at each rung / Super Admin",
            statusProduced: "pending_approval",
            routesTo: "CEO",
            notificationRecipients: n("Next-rung approvers"),
            actionRequiredRecipients: n("Next-rung approvers"),
            emailRecipients: n("Next-rung approvers"),
            fallbackEscalation: "A National Sales Manager, Product Manager or Group Product Manager goes straight to the CEO. A missing management rung is flagged, not blocked; a Super Admin can reassign a rung.",
            sideEffects: "Decision applied by one database call per rung.",
          },
          {
            id: "ceo_decision",
            name: "CEO final decision",
            actor: "CEO",
            role: "CEO / Super Admin",
            statusProduced: "approved | returned | rejected",
            notificationRecipients: n("Requester (return or reject)", "SFE Manager", "Super Admin"),
            fyiRecipients: n("Requester (return or reject)", "SFE Manager", "Super Admin"),
            emailRecipients: n("Distribution contact (final approval)", "CC: CEO, Super Admin"),
            sideEffects: "Final approval rebuilds the order's sales-of-sales batch in the same transaction, so a failure rolls the decision back. Any reject is final; a return goes back to the requester.",
          },
        ],
      },
      {
        key: "held",
        name: "Held Orders",
        summary: "An order for a pharmacy not in the master is held for up to 14 days.",
        governedByRegistry: true,
        registryModuleKey: "direct_orders",
        steps: [
          {
            id: "hold",
            name: "Order is held",
            actor: "System",
            role: "System",
            statusProduced: "held",
            notificationRecipients: n("Requester"),
            fyiRecipients: n("Requester"),
            emailRecipients: n("Requester"),
            sideEffects: "Holds the order until the pharmacy is resolved.",
          },
          {
            id: "release_or_expire",
            name: "Released, kept, cancelled or expired",
            actor: "Super Admin (Held Desk) / System",
            role: "Super Admin",
            statusProduced: "pending_approval | held | cancelled | expired",
            notificationRecipients: n("First-rung approvers (release)", "Requester (cancel or expiry)"),
            emailRecipients: n("First-rung approvers (release)", "Requester (expiry)"),
            sideEffects: "A released order enters the approval chain; an unresolved one expires after 14 days.",
          },
        ],
      },
      {
        key: "collection",
        name: "Collection",
        summary: "Finance records what was collected against an approved order.",
        steps: [
          {
            id: "collect",
            name: "Record collection",
            actor: "Finance officer",
            role: "Finance officer / Super Admin",
            statusProduced: "(collection recorded)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "One locked compare-and-set write; writes a collection event.",
          },
        ],
      },
    ],
  },

  // ===========================================================================
  // 9. Weekly & Monthly Plans (added 2026-11-13, REC-005)
  // ===========================================================================
  {
    key: "plans",
    name: "Weekly & Monthly Plans",
    status: "Active",
    riskLevel: "Medium",
    summary: "Employee weekly and monthly plans: submit, manager stage, CEO or second-approver stage, HR acknowledgement.",
    modulesAffected: n("employee_plan_headers", "employee_plan_items", "notification_events", "audit_logs"),
    subflows: [
      {
        // decideEmployeePlan asks the employee_plans registry row after EMPLOYEE_PLAN_TRANSITIONS;
        // with no row the code table decides alone (src/lib/weekly-planning/plan-registry.ts).
        key: "employee-plan",
        name: "Plan Submission & Approval",
        summary: "Submit → assigned manager → CEO (or the named second approver) → HR acknowledgement.",
        governedByRegistry: true,
        registryModuleKey: "employee_plans",
        steps: [
          {
            id: "submit",
            name: "Employee submits the plan",
            actor: "Plan owner",
            role: "Plan-eligible employees",
            statusProduced: "submitted",
            routesTo: "Assigned manager",
            notificationRecipients: n("Assigned manager", "HR (awareness)"),
            actionRequiredRecipients: n("Assigned manager"),
            fyiRecipients: n("HR (awareness)"),
            emailRecipients: n("Assigned manager"),
            fallbackEscalation: "With no manager on the plan the notice goes to the skip-level manager, then the CEO for a National Sales Manager, then Super Admin.",
            sideEffects: "The plan owner may also ask to edit a submitted plan, or cancel it before it is decided.",
          },
          {
            id: "manager_decision",
            name: "Assigned manager decides",
            actor: "Assigned manager",
            role: "The plan's manager only — no Super Admin stand-in",
            statusProduced: "manager_approved | manager_returned | manager_rejected",
            routesTo: "CEO, or the named second approver",
            notificationRecipients: n("Employee", "CEO or second approver (on approval)"),
            actionRequiredRecipients: n("CEO or second approver (on approval)"),
            fyiRecipients: n("Employee"),
            emailRecipients: n("CEO or second approver (on approval)"),
            fallbackEscalation: "A District Manager plan has no CEO stage: its manager's approval lands on final_approved, unless that manager has a named second approver.",
            sideEffects: "A return or reject needs a comment. The manager may also ask for visit details first.",
          },
          {
            id: "ceo_decision",
            name: "CEO or second approver decides",
            actor: "CEO / named second approver",
            role: "CEO (never on a District Manager plan) / the named second approver",
            statusProduced: "final_approved | ceo_returned | ceo_rejected",
            routesTo: "HR",
            notificationRecipients: n("Employee", "HR (on final approval)"),
            fyiRecipients: n("Employee", "HR (on final approval)"),
            emailRecipients: n("HR (on final approval)"),
            sideEffects: "A return or reject needs a comment.",
          },
          {
            id: "hr_acknowledge",
            name: "HR acknowledges",
            actor: "System / Super Admin",
            role: "Super Admin",
            statusProduced: "hr_acknowledged",
            notificationRecipients: [],
            emailRecipients: [],
            fallbackEscalation: "Acknowledged automatically on final approval; if that fails the plan waits at final_approved for a Super Admin.",
            sideEffects: "An approved plan can be revised into a new draft linked to it; the approved plan stands until the revision is approved.",
          },
        ],
      },
      {
        key: "legacy-weekly-plan",
        name: "Legacy Weekly Plan Table",
        summary: "The first weekly-plan machine. Its transition table is still in code and registered, but nothing runs it.",
        governedByRegistry: false,
        registryModuleKey: "weekly_plans",
        notImplemented: true,
        steps: [
          {
            id: "legacy",
            name: "Draft → submitted → manager → CEO → final approved",
            actor: "None",
            role: "None",
            statusProduced: "(not used)",
            notificationRecipients: [],
            emailRecipients: [],
            sideEffects: "None. WEEKLY_PLAN_TRANSITIONS (src/lib/weekly-planning/workflow.ts) has no caller in running code.",
          },
        ],
        gaps: ["Legacy: the weekly_plans table is empty and being retired; live plans run through Plan Submission & Approval above."],
      },
    ],
  },

  // ===========================================================================
  // 10. Notifications & Communication (cross-cutting — not a duplicate of flows)
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
            sideEffects: "Two daily crons on the production scheduler (cron-job.org); outbox + probation reminders piggyback the renewal cron.",
            knownGap: "An employee with no linked direct manager cannot submit an excuse AT ALL — createExcuseRequest refuses with \"Direct manager is not linked for this employee. Please contact HR.\" Vacation, by contrast, accepts the request and waits for HR to assign an approver.",
          },
        ],
        gaps: ["An employee with no linked direct manager cannot submit an excuse at all (createExcuseRequest refuses outright, so there is nothing for HR to reassign). Any fallback must respect the excluded-role rule: District and Regional Managers may not decide excuses."],
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

/** Number of in-app notifications wired across a domain's steps. */
export function domainNotificationCount(domain: WorkflowControlDomain): number {
  return domain.subflows.reduce(
    (sum, s) => sum + s.steps.filter((st) => st.notificationRecipients.length > 0 && !st.notificationGap).length,
    0,
  );
}

/** Number of email touchpoints across a domain's steps. */
export function domainEmailCount(domain: WorkflowControlDomain): number {
  return domain.subflows.reduce((sum, s) => sum + s.steps.filter((st) => st.emailRecipients.length > 0).length, 0);
}

/** All known gaps for a domain: subflow-level gaps + per-step notification gaps. */
export function domainGaps(domain: WorkflowControlDomain): string[] {
  const gaps: string[] = [];
  for (const subflow of domain.subflows) {
    if (subflow.gaps) gaps.push(...subflow.gaps);
    for (const step of subflow.steps) {
      if (step.knownGap) gaps.push(step.knownGap);
    }
  }
  return Array.from(new Set(gaps));
}

/** True when any step in the domain has an unimplemented notification producer. */
export function domainHasNotificationGap(domain: WorkflowControlDomain): boolean {
  return domain.subflows.some((s) => s.steps.some((st) => st.notificationGap));
}
