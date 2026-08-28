const portalLandingRoleNames = new Set([
  "employee",
  "medical rep",
  "district manager",
  "regional manager",
  "national sales manager",
  "product manager",
  "group product manager",
  "marketing manager",
  "training manager",
  "manager",
]);

export function resolveLandingPathForRole(role: string | null | undefined) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "hr specialist" || normalized === "hr manager") return "/admin";
  // Admin-shell employee roles land in their personal /workspace home rather than the org-wide
  // /admin marketing module. Marketing Manager uses the employee portal alongside PM/GPM.
  // His own command center, peer to the CEO's and the SFE Manager's. He previously landed on
  // /admin/outstation/expense-command — one module of a job that spans payroll, direct orders,
  // marketing execution, expenses and leave. Outstation is still one click away in the sidebar.
  if (normalized === "finance manager") return "/admin/finance-command-center";
  if (normalized === "sfe manager") return "/admin/sfe-command-center";
  // Financial Advisor's job is executing the marketing finance step — land on its workspace inbox.
  if (normalized === "financial advisor") return "/workspace/marketing-requests/inbox";
  if (normalized === "training manager") return "/employee-portals/training-manager";
  // The two HR seats (owner, 2026-08-28). Admin-shell, so they must NOT be in the portal set
  // above — but /admin is the Super Admin home and shows them a shell of modules they do not
  // hold, so they get their own command centre, composed from the function bundle each seat
  // actually holds.
  //
  // The ADDRESS is what selects the HR shell, not the role (`resolveNavigationMode` never returns
  // "hr" — see its comment), so this must be the /hr spelling. Landing on the bare
  // /admin/hr-command-center would render the right page wearing the ADMIN sidebar for exactly one
  // paint, until AppShell's namespace redirect bounced it here anyway. Naming the /hr address
  // directly saves that round trip on every single sign-in.
  //
  // Until 2026-08-28 this returned "/workspace" — the personal admin-shell workspace — as a
  // placeholder while the namespace was being built.
  if (normalized === "hr advisory" || normalized === "hr operations") {
    return "/hr/admin/hr-command-center";
  }
  if (normalized === "ceo") return "/admin/ceo-command-center";
  return portalLandingRoleNames.has(normalized) ? "/employee-portals" : "/admin";
}
