/**
 * Every row the employee-portal sidebar can draw — its href, the words on it, and the heading it
 * sits under — readable on the server.
 *
 * The rail itself is built by `buildEmployeePortalSections` inside employee-portal-layout.tsx, a
 * `"use client"` file whose rows carry Lucide components, so nothing server-side can import it. The
 * System Audit has to name the module a person was in EXACTLY as their sidebar named it, so this is
 * a mirror: one line per row, in the rail's own order, the label character for character.
 *
 * A mirror rots unless something holds it level. tests/system-audit-portal-sidebar-rows-drift.test.ts
 * re-reads the layout's source and fails in BOTH directions — a rail row missing here, a row here
 * the rail no longer draws, or a label or heading that differs by one character. So adding a row to
 * the rail without adding it here turns CI red; it never silently becomes "Not in sidebar".
 *
 * Which rows a particular person sees is the layout's business (its visibility flags); this list
 * answers only "what is the row at this address called".
 */

export type EmployeePortalSidebarRow = {
  href: `/employee-portals${string}`;
  label: string;
  section: string;
};

export const EMPLOYEE_PORTAL_SIDEBAR_ROWS: readonly EmployeePortalSidebarRow[] = [
  { href: "/employee-portals/training-manager", label: "Overview", section: "Training Manager" },
  { href: "/employee-portals/training-manager/coaching", label: "Coaching Dashboard", section: "Training Manager" },
  { href: "/employee-portals/training-manager/field-coaching", label: "Field Coaching", section: "Training Manager" },
  { href: "/employee-portals/training-manager/rep-achievement", label: "Rep Achievement", section: "Training Manager" },
  { href: "/employee-portals/field-crm/plan", label: "Weekly Plan", section: "Training Manager" },

  { href: "/employee-portals/field-crm", label: "Phoenix CRM", section: "Phoenix CRM" },
  { href: "/employee-portals/place-checks", label: "Place checks", section: "Phoenix CRM" },
  { href: "/employee-portals/visit-report", label: "Visit report", section: "Phoenix CRM" },
  { href: "/employee-portals/double-visit-requests", label: "Double visit requests", section: "Phoenix CRM" },
  { href: "/employee-portals/my-map", label: "My map", section: "Phoenix CRM" },

  { href: "/employee-portals", label: "Command Center", section: "My Workspace" },
  { href: "/employee-portals/interview-calendar", label: "Interview Calendar", section: "My Workspace" },
  { href: "/employee-portals/organogram", label: "Organogram", section: "My Workspace" },
  { href: "/employee-portals/employee-360", label: "Employee 360", section: "My Workspace" },
  { href: "/employee-portals/business-review", label: "Business Review", section: "My Workspace" },
  { href: "/employee-portals/private-calendar", label: "Private Calendar", section: "My Workspace" },
  { href: "/employee-portals/plans", label: "Weekly / Monthly Plan", section: "My Workspace" },
  { href: "/employee-portals/plans/calendar", label: "Planning Calendar", section: "My Workspace" },
  { href: "/employee-portals/production-planning", label: "Production Planner", section: "My Workspace" },

  { href: "/employee-portals/business-cards", label: "Business Cards", section: "Social" },
  { href: "/employee-portals/email-signature", label: "Email Signature", section: "Social" },
  { href: "/employee-portals/milestones", label: "My Milestones", section: "Social" },
  { href: "/employee-portals/spotlight", label: "Spotlight", section: "Social" },

  { href: "/employee-portals/approvals/vacation", label: "Leave Approvals", section: "Approvals Hub" },
  { href: "/employee-portals/approvals/excuse", label: "Excuse Approvals", section: "Approvals Hub" },
  { href: "/employee-portals/approvals/plan", label: "Plan Approvals", section: "Approvals Hub" },
  { href: "/employee-portals/marketing-requests/inbox", label: "Marketing Inbox", section: "Approvals Hub" },
  { href: "/employee-portals/market-awareness/inbox", label: "Awareness Inbox", section: "Approvals Hub" },
  { href: "/employee-portals/approvals-hub", label: "Other Approvals", section: "Approvals Hub" },

  { href: "/employee-portals/source-of-sales", label: "Source of Sales", section: "Sales Data" },
  { href: "/employee-portals/weekly-sales", label: "Weekly Sales", section: "Sales Data" },
  { href: "/employee-portals/weekly-stock", label: "Weekly Stock", section: "Sales Data" },
  { href: "/employee-portals/territory-drilldown", label: "Sales Drilldown", section: "Sales Data" },
  { href: "/employee-portals/direct-orders", label: "Direct Orders", section: "Sales Data" },
  { href: "/employee-portals/direct-orders-in-my-area", label: "Area Direct Orders", section: "Sales Data" },

  { href: "/employee-portals/sales-vs-target", label: "Sales vs Target", section: "Performance" },
  { href: "/employee-portals/monthly-closing", label: "Monthly Closing", section: "Performance" },
  { href: "/employee-portals/monthly-closing/performance-review", label: "Performance Review", section: "Performance" },
  { href: "/employee-portals/team-performance", label: "Team Performance", section: "Performance" },
  { href: "/employee-portals/med-reps-performance", label: "MRs Performance", section: "Performance" },
  { href: "/employee-portals/dsms-performance", label: "DSMs Performance", section: "Performance" },
  { href: "/employee-portals/incentive", label: "Incentive", section: "Performance" },
  { href: "/employee-portals/probation", label: "Probation Tracker", section: "Performance" },
  { href: "/employee-portals/coaching-skills-survey", label: "Coaching Skills Survey", section: "Performance" },

  { href: "/employee-portals/make-it-happen", label: "Make It Happen", section: "Forecast & Target" },
  { href: "/employee-portals/field-crm/forecast", label: "Daily Forecast", section: "Forecast & Target" },
  { href: "/employee-portals/targets", label: "Targets", section: "Forecast & Target" },

  { href: "/employee-portals/vacancies", label: "Vacancies", section: "Recruitment" },
  { href: "/employee-portals/recruitment-candidates", label: "My Candidates", section: "Recruitment" },
  { href: "/employee-portals/territory-management", label: "Territory Management", section: "Recruitment" },
  { href: "/employee-portals/recruitment-engagement", label: "Manager CV Engagement", section: "Recruitment" },

  { href: "/employee-portals/visits", label: "My Visits", section: "Field Work" },
  { href: "/employee-portals/early-birds", label: "Early Birds", section: "Field Work" },
  { href: "/employee-portals/ranks", label: "Phoenix Ranks", section: "Field Work" },
  { href: "/employee-portals/crm", label: "CRM", section: "Field Work" },
  { href: "/employee-portals/reps-list", label: "Reps List", section: "Field Work" },
  { href: "/employee-portals/dv-planner", label: "DV Planner", section: "Field Work" },
  { href: "/employee-portals/double-visit-report", label: "Double Visit Report", section: "Field Work" },
  { href: "/employee-portals/field-activity", label: "Field Activity", section: "Field Work" },
  { href: "/employee-portals/team-calendar", label: "Team Calendar", section: "Field Work" },
  { href: "/employee-portals/field-absence", label: "Field Absence Calendar", section: "Field Work" },

  { href: "/employee-portals/kpis", label: "Summary", section: "KPIs" },
  { href: "/employee-portals/kpis/frequency", label: "Frequency", section: "KPIs" },
  { href: "/employee-portals/kpis/coverage", label: "Coverage", section: "KPIs" },
  { href: "/employee-portals/kpis/call-rate", label: "Call Rate", section: "KPIs" },

  { href: "/employee-portals/marketing-requests/validation", label: "Customer Validation", section: "Marketing & ROI" },
  { href: "/employee-portals/marketing-requests", label: "Marketing Requests", section: "Marketing & ROI" },
  { href: "/employee-portals/roi-tracker", label: "ROI Tracker", section: "Marketing & ROI" },
  { href: "/employee-portals/market-awareness", label: "Market Awareness", section: "Marketing & ROI" },
  { href: "/employee-portals/roi", label: "ROI Dashboard", section: "Marketing & ROI" },
  { href: "/employee-portals/marketing-requests/control", label: "Marketing Control", section: "Marketing & ROI" },
  { href: "/employee-portals/marketing-requests/all", label: "All Marketing Requests", section: "Marketing & ROI" },
  { href: "/employee-portals/marketing-requests/customer-database", label: "Customer Database", section: "Marketing & ROI" },

  { href: "/employee-portals/payslips", label: "Payslips", section: "Payroll" },
  { href: "/employee-portals/deductions", label: "Deductions", section: "Payroll" },
  { href: "/employee-portals/disputes", label: "My Disputes", section: "Payroll" },

  { href: "/employee-portals/expenses", label: "My Outstation Expenses", section: "Outstation Expenses" },
  { href: "/employee-portals/expense-dashboard", label: "Expense Dashboard", section: "Outstation Expenses" },
  { href: "/employee-portals/expense-submissions", label: "Expense Submissions", section: "Outstation Expenses" },
  { href: "/employee-portals/submit-expense", label: "Submit Expense", section: "Outstation Expenses" },
  { href: "/employee-portals/team-expenses", label: "Team Expenses", section: "Outstation Expenses" },

  { href: "/employee-portals/vacation-request", label: "Vacation Request", section: "Leaves Management" },
  { href: "/employee-portals/vacation-report", label: "Vacation Report", section: "Leaves Management" },
  { href: "/employee-portals/excuses", label: "Excuses", section: "Leaves Management" },
  { href: "/employee-portals/fingerprint-analytics", label: "Attendance Analytics", section: "Leaves Management" },

  { href: "/employee-portals/report-it", label: "Report It", section: "Other" },
  { href: "/employee-portals/contact-hr-support", label: "Request Support", section: "Other" },
];

/**
 * The portal root lights only on itself — the rail's own EXACT_ONLY_PORTAL_HREFS. Without it every
 * portal page with no row of its own (the profile, a hub card's destination) would read "Command
 * Center", which the rail deliberately never shows there.
 */
export const EMPLOYEE_PORTAL_EXACT_ONLY_HREFS: ReadonlySet<string> = new Set(["/employee-portals"]);
