const appTitle = "Phoenix Workforce";

const exactRouteTitles: Record<string, string> = {
  "/": appTitle,
  "/admin": "Admin Command Center",
  "/admin/access": "Access Control",
  "/admin/data-health": "Data Health",
  "/admin/email-notifications": "Email Notifications",
  "/admin/email-reply-composer": "Email Reply Composer",
  "/admin/email-templates": "Email Templates",
  "/admin/leave": "Leave Administration",
  "/admin/logs": "Audit Logs",
  "/admin/marketing-requests": "Marketing Requests Admin",
  "/admin/marketing-requests/control": "Marketing Control",
  "/admin/marketing-requests/customer-database": "Customer Database",
  "/admin/marketing-requests/validation": "Marketing Validation",
  "/admin/monitoring": "Monitoring",
  "/admin/outstation/heatmaps": "Outstation Heatmaps",
  "/admin/outstation/policy": "Outstation Policy",
  "/admin/outstation/requests": "Outstation Requests",
  "/admin/payslips-center": "Payslips Center",
  "/admin/profile": "Admin Profile",
  "/attendance/device-user-mapping": "Device User Mapping",
  "/attendance/fingerprint-report": "Fingerprint Report",
  "/attendance/policies": "Attendance Policies",
  "/coaching": "Coaching",
  "/coaching/analytics": "Coaching Analytics",
  "/coaching/new": "New Coaching Report",
  "/contracts": "Contracts",
  "/cv-database": "CV Database",
  "/dev/employee-portals": "Employee Portal Dev Preview",
  "/employee/outstation/new": "New Outstation Request",
  "/employee-portals": "Employee Portal",
  "/employee-portals/coaching": "Coaching Reports",
  "/employee-portals/contact-hr-support": "Contact HR Support",
  "/employee-portals/dsms-performance": "DSM Performance",
  "/employee-portals/excuses": "Excuses",
  "/employee-portals/expense-dashboard": "Expense Dashboard",
  "/employee-portals/expenses": "My Expenses",
  "/employee-portals/incentive": "Incentive",
  "/employee-portals/marketing-requests": "Marketing Requests",
  "/employee-portals/marketing-requests/control": "Marketing Control",
  "/employee-portals/marketing-requests/customer-database": "Customer Database",
  "/employee-portals/marketing-requests/validation": "Marketing Validation",
  "/employee-portals/med-reps-performance": "Medical Reps Performance",
  "/employee-portals/organogram": "Organogram",
  "/employee-portals/payroll": "Payroll",
  "/employee-portals/payslips": "Payslips",
  "/employee-portals/pending-approvals": "Pending Approvals",
  "/employee-portals/probation": "Probation",
  "/employee-portals/profile": "Profile",
  "/employee-portals/sales": "Sales",
  "/employee-portals/submit-expense": "Submit Expense",
  "/employee-portals/team-expenses": "Team Expenses",
  "/employee-portals/team-performance": "Team Performance",
  "/employee-portals/training-manager": "Training Manager",
  "/employee-portals/training-manager/create-coaching-report": "Create Coaching Report",
  "/employee-portals/training-manager/field-coaching": "Field Coaching",
  "/employee-portals/vacancies": "Vacancies",
  "/employees": "Employees",
  "/hiring-documents": "Hiring Documents",
  "/hr-calendar": "HR Calendar",
  "/leave-management/vacation-control": "Vacation Control",
  "/leave-management/vacation-report": "Vacation Report",
  "/leave-management/vacation-request": "Vacation Request",
  "/login": "Login",
  "/notifications": "Notifications",
  "/offers": "Offers",
  "/organogram": "Organogram",
  "/overview": "Overview",
  "/password-setup": "Password Setup",
  "/payroll": "Payroll",
  "/payroll/expenses": "Payroll Expenses",
  "/payroll/expenses/dashboard": "Expenses Dashboard",
  "/payslips": "Payslips",
  "/pending-approvals": "Pending Approvals",
  "/probation": "Probation",
  "/reports/vacancies": "Vacancy Report",
  "/resignations": "Resignations",
  "/sales": "Sales",
  "/sales/queue": "Sales Queue",
};

const dynamicRouteTitles: Array<[RegExp, string]> = [
  [/^\/coaching\/[^/]+$/, "Coaching Report"],
  [/^\/employee-portals\/coaching\/[^/]+$/, "Coaching Report"],
  [/^\/employee-portals\/training-manager\/field-coaching\/[^/]+$/, "Field Coaching Report"],
  [/^\/offers\/[^/]+\/accept$/, "Offer Acceptance"],
  [/^\/offers\/[^/]+\/reject$/, "Offer Rejection"],
  [/^\/password-setup\/[^/]+$/, "Password Setup"],
];

const titleWordOverrides: Record<string, string> = {
  admin: "Admin",
  cv: "CV",
  dsm: "DSM",
  dsms: "DSMs",
  hr: "HR",
  id: "ID",
  med: "Medical",
  nsm: "NSM",
  rls: "RLS",
  sfe: "SFE",
};

export function normalizePagePath(pathname: string | null | undefined) {
  const pathOnly = (pathname || "/").split("?")[0]?.split("#")[0] || "/";
  const normalized = pathOnly.length > 1 ? pathOnly.replace(/\/+$/, "") : pathOnly;
  return normalized || "/";
}

function titleizeSegment(segment: string) {
  return segment
    .split("-")
    .filter(Boolean)
    .map((word) => {
      const lowered = word.toLowerCase();
      return titleWordOverrides[lowered] ?? `${lowered.charAt(0).toUpperCase()}${lowered.slice(1)}`;
    })
    .join(" ");
}

function fallbackTitle(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const readableSegments = segments.filter((segment) => (
    segment !== "employee-portals" &&
    segment !== "leave-management" &&
    segment !== "reports" &&
    segment !== "admin"
  ));
  const candidateSegments = readableSegments.length ? readableSegments.slice(-2) : segments.slice(-2);
  const title = candidateSegments.map(titleizeSegment).join(" ");

  if (!title) return appTitle;
  if (segments[0] === "admin" && !title.startsWith("Admin")) return `Admin ${title}`;
  return title;
}

export function pageTitleForPathname(pathname: string | null | undefined) {
  const normalized = normalizePagePath(pathname);
  const exactTitle = exactRouteTitles[normalized];
  if (exactTitle) return exactTitle;

  const dynamicMatch = dynamicRouteTitles.find(([pattern]) => pattern.test(normalized));
  if (dynamicMatch) return dynamicMatch[1];

  return fallbackTitle(normalized);
}

export function documentTitleForPathname(pathname: string | null | undefined) {
  const pageTitle = pageTitleForPathname(pathname);
  return pageTitle === appTitle ? appTitle : `${pageTitle} | ${appTitle}`;
}
