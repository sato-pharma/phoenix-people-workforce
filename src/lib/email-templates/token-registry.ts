// The single source of truth for every {{token}} the email-template system understands. Every
// place that used to hand-list tokens (contextVariables' render map, htmlBlockTokens,
// placeholderHints, variableCatalog, the sample-context builders) now DERIVES from this list
// instead of maintaining its own copy — see the derivation call sites in render-core.ts,
// service.ts and email-designer.ts. A token that's missing here is missing everywhere, LOUDLY
// (chip picker won't offer it, "Unknown variable" blocks publish) instead of the old failure
// mode: silently rendering blank in a real, already-sent email (the exact shape of the
//
// ZERO non-type imports on purpose — mirrors render-core.ts, which needs to stay importable by
// the type-stripping test runner (no JSX). EmailTemplateContext/EmailTemplateKey are imported
// type-only so they're fully erased at compile time.
import type { EmailTemplateContext, EmailTemplateKey } from "./service";

export type TokenCategory = "Candidate" | "Company" | "Contract" | "Employee" | "Manager" | "Payroll";

export type TokenDefinition = {
  /** Must be a real EmailTemplateContext field name — a typo here is now a compile error. */
  token: keyof EmailTemplateContext;
  category: TokenCategory;
  label: string;
  /**
   * Plain-token sample value, used verbatim by the generated sample-context builders. For the
   * html-block tokens (isHtmlBlock: true) this is only ever shown as descriptive placeholder text
   * in the designer's chip picker (e.g. "(the submitted plan days as a table)") — call sites that
   * need a REAL rendered sample table build one explicitly and layer it on top of the generated
   * base; see sampleTemplateContext() / sendTemplateTestEmail() in their respective files.
   */
  sampleValue: string;
  /** [] = usable in every template type (matches the frontend's existing "empty = all" convention). */
  allowedTemplateTypes: readonly EmailTemplateKey[];
  /**
   * True for tokens whose value is trusted pre-rendered HTML (bypasses escaping in bodyHtml).
   * Each of these ALSO has a `${token}Text` plain-text-projection sibling field on
   * EmailTemplateContext (e.g. planTableText) that is NOT a separate TOKEN_REGISTRY entry — it
   * never appears literally as `{{planTableText}}` in a template body, so it has no chip, no
   * category, no sample value of its own. See contextVariables() in render-core.ts for how the
   * sibling is resolved.
   */
  isHtmlBlock?: true;
};

export const TOKEN_REGISTRY: readonly TokenDefinition[] = [
  { category: "Employee", label: "Employee Name", sampleValue: "Mariam Adel", token: "employeeName", allowedTemplateTypes: [] },
  { category: "Employee", label: "Employee HR ID", sampleValue: "PHX-1024", token: "employeeHrId", allowedTemplateTypes: [] },
  { category: "Employee", label: "Job Title", sampleValue: "Medical Representative", token: "jobTitle", allowedTemplateTypes: [] },
  { category: "Employee", label: "Line", sampleValue: "Cardio Line", token: "line", allowedTemplateTypes: [] },
  { category: "Employee", label: "Area", sampleValue: "Cairo", token: "area", allowedTemplateTypes: [] },
  { category: "Manager", label: "Manager Name", sampleValue: "Omar Nabil", token: "managerName", allowedTemplateTypes: [] },
  { category: "Candidate", label: "Candidate Name", sampleValue: "Ahmed Hassan", token: "candidateName", allowedTemplateTypes: ["offer", "offer_status", "interview_invitation", "interview_feedback", "recruitment_update", "password_setup", "password_reset"] },
  { category: "Candidate", label: "Interview Date", sampleValue: "2026-06-10", token: "interviewDate", allowedTemplateTypes: ["interview_invitation", "interview_feedback"] },
  { category: "Candidate", label: "Interview Time", sampleValue: "10:30 AM", token: "interviewTime", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Interview Location", sampleValue: "Cairo Office", token: "interviewLocation", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Interviewer Name", sampleValue: "Nour Samir", token: "interviewerName", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Meeting Link", sampleValue: "https://meet.example.com/phoenix", token: "meetingUrl", allowedTemplateTypes: ["interview_invitation"] },
  { category: "Candidate", label: "Feedback", sampleValue: "Strong role alignment", token: "feedback", allowedTemplateTypes: ["interview_feedback"] },
  { category: "Candidate", label: "Next Step", sampleValue: "Schedule final interview", token: "nextStep", allowedTemplateTypes: ["interview_feedback"] },
  { category: "Contract", label: "Start Date", sampleValue: "2026-06-01", token: "startDate", allowedTemplateTypes: [] },
  { category: "Contract", label: "End Date", sampleValue: "2026-06-05", token: "endDate", allowedTemplateTypes: [] },
  { category: "Contract", label: "Hire Date", sampleValue: "2026-06-01", token: "hireDate", allowedTemplateTypes: ["probation_workflow", "probation_reminder", "contract_renewal"] },
  { category: "Contract", label: "Expiry Text", sampleValue: "24 hours", token: "expiryText", allowedTemplateTypes: ["password_setup", "password_reset", "user_created"] },
  { category: "Payroll", label: "Vacation Balance", sampleValue: "12 days", token: "vacationBalance", allowedTemplateTypes: ["leave_request", "leave_approval", "leave_rejection"] },
  { category: "Company", label: "Approval Flow", sampleValue: "Manager then HR", token: "approvalFlow", allowedTemplateTypes: [] },
  { category: "Company", label: "Status", sampleValue: "Pending manager approval", token: "status", allowedTemplateTypes: [] },
  { category: "Company", label: "Date", sampleValue: "2026-05-31", token: "date", allowedTemplateTypes: [] },
  { category: "Company", label: "Duration", sampleValue: "5 days", token: "duration", allowedTemplateTypes: [] },
  { category: "Company", label: "Action Link", sampleValue: "https://phoenix.example.com/action", token: "ctaUrl", allowedTemplateTypes: [] },
  { category: "Company", label: "Action Button Text", sampleValue: "Open in Phoenix Workforce", token: "ctaLabel", allowedTemplateTypes: [] },
  { category: "Company", label: "Recipient Name", sampleValue: "Omar", token: "recipientName", allowedTemplateTypes: [] },
  { category: "Company", label: "Email Subject", sampleValue: "Phoenix Workforce notification", token: "subject", allowedTemplateTypes: [] },
  { category: "Company", label: "Summary", sampleValue: "A workflow update needs review.", token: "summary", allowedTemplateTypes: [] },
  { category: "Company", label: "Submitted Plan Table", sampleValue: "(the submitted plan days as a table)", token: "planTable", allowedTemplateTypes: ["weekly_plans"], isHtmlBlock: true },
  { category: "Company", label: "Vacation Type", sampleValue: "Annual Leave", token: "vacationType", allowedTemplateTypes: ["leave_request", "leave_approval", "leave_rejection"] },
  { category: "Company", label: "Honorific", sampleValue: "Dr. ", token: "honorific", allowedTemplateTypes: [] },
  { category: "Payroll", label: "Amount", sampleValue: "1,250 EGP", token: "amount", allowedTemplateTypes: [] },
  { category: "Company", label: "Destination", sampleValue: "Alexandria, Egypt", token: "destination", allowedTemplateTypes: ["outstation"] },
  { category: "Company", label: "Excuse Type", sampleValue: "Morning excuse", token: "excuseType", allowedTemplateTypes: ["excuse_request", "excuse_decision"] },
  { category: "Company", label: "Excuse Date", sampleValue: "2026-06-12", token: "excuseDate", allowedTemplateTypes: ["excuse_request", "excuse_decision"] },
  { category: "Company", label: "Details Table", sampleValue: "(a premium zebra-striped label/value summary table)", token: "detailsTable", allowedTemplateTypes: [], isHtmlBlock: true },
  { category: "Company", label: "Digest Table", sampleValue: "(a weekly digest summary table)", token: "digestTable", allowedTemplateTypes: ["dv_planner_weekly", "probation_weekly_digest"], isHtmlBlock: true },
  { category: "Company", label: "Week Label", sampleValue: "2026-06-08 to 2026-06-14", token: "weekLabel", allowedTemplateTypes: ["dv_planner_weekly", "probation_weekly_digest"] },
  { category: "Company", label: "Score Table", sampleValue: "(the coaching score breakdown table)", token: "scoreTable", allowedTemplateTypes: ["coaching_report"], isHtmlBlock: true },
  { category: "Payroll", label: "Estimated Cost", sampleValue: "50,000 EGP", token: "estimatedCost", allowedTemplateTypes: ["marketing_request"] },
  { category: "Payroll", label: "Required ROI", sampleValue: "3.5x", token: "requiredRoi", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "ROI Window", sampleValue: "90 days", token: "roiWindow", allowedTemplateTypes: ["marketing_request"] },
  { category: "Payroll", label: "Pay Date", sampleValue: "2026-06-30", token: "payDate", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Customer Name", sampleValue: "El Ezaby Pharmacy", token: "customerName", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Current Step", sampleValue: "Regional Manager review", token: "currentStep", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Request Code", sampleValue: "REQ-0208", token: "requestCode", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Requester Name", sampleValue: "Youssef Ahmed", token: "requesterName", allowedTemplateTypes: ["marketing_request"] },
  { category: "Company", label: "Products Table", sampleValue: "(the requested products/financials table)", token: "productsTable", allowedTemplateTypes: ["marketing_request"], isHtmlBlock: true },
  { category: "Company", label: "Return Callout", sampleValue: "(the return/rejection reason callout)", token: "returnCallout", allowedTemplateTypes: ["marketing_request"], isHtmlBlock: true },
  { category: "Employee", label: "Probation Day", sampleValue: "45", token: "probationDay", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "DV Date", sampleValue: "2026-06-10", token: "dvDate", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Evaluator Name", sampleValue: "Nour Samir", token: "evaluatorName", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Evaluator Role", sampleValue: "District Manager", token: "evaluatorRole", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Visit Count", sampleValue: "4", token: "visitCount", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "DV Progress", sampleValue: "DM 2/3 · TM 1/1 · Total 3/4", token: "dvProgress", allowedTemplateTypes: ["probation_dv_snapshot"] },
  { category: "Employee", label: "Risk Status", sampleValue: "Action Required", token: "riskStatus", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "Provisional Score", sampleValue: "6.85 / 10", token: "provisionalScore", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "Days Remaining", sampleValue: "12", token: "daysRemaining", allowedTemplateTypes: ["probation_dv_snapshot", "probation_day30", "probation_day60", "probation_day75"] },
  { category: "Employee", label: "Milestone Day", sampleValue: "60", token: "milestoneDay", allowedTemplateTypes: ["probation_day30", "probation_day60", "probation_day75"] },
] as const satisfies readonly TokenDefinition[];

/** Tokens whose value is trusted pre-rendered HTML — see TokenDefinition.isHtmlBlock. */
export const HTML_BLOCK_TOKENS: readonly TokenDefinition["token"][] = TOKEN_REGISTRY.filter(
  (t): t is TokenDefinition & { isHtmlBlock: true } => Boolean(t.isHtmlBlock),
).map((t) => t.token);
