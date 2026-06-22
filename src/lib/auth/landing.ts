const portalLandingRoleNames = new Set([
  "employee",
  "medical rep",
  "district manager",
  "regional manager",
  "national sales manager",
  "product manager",
  "group product manager",
  "training manager",
  "manager",
]);

export function resolveLandingPathForRole(role: string | null | undefined) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "hr specialist" || normalized === "hr manager") return "/admin";
  // Admin-shell employee roles land in their personal /workspace home (the single, de-duplicated
  // surface for SFE/Marketing Manager) rather than the org-wide /admin marketing module. The
  // Marketing Manager lands on the at-a-glance Overview (approvals + in-flight + validation).
  if (normalized === "marketing manager") return "/workspace/marketing-requests/overview";
  if (normalized === "finance manager") return "/admin/outstation/expense-command";
  if (normalized === "sfe manager") return "/workspace/marketing-requests";
  // Talent Acquisition is an admin-shell HR role but has no admin/overview grant, so the
  // generic "/admin" fallback redirects it straight back out to the portal — an infinite
  // bounce (/admin -> /employee-portals -> /overview -> /admin). Land it on its actual home
  // surface (Recruitment), which its hrAuthority permissions allow.
  if (normalized === "talent acquisition") return "/recruitment";
  // Financial Advisor's job is executing the marketing finance step — land on its workspace inbox.
  if (normalized === "financial advisor") return "/workspace/marketing-requests/inbox";
  if (normalized === "training manager") return "/employee-portals/training-manager";
  // Product / Group Product Managers land on the portal command center (their hub) not on
  // weekly-sales directly — weekly-sales is reachable from the Sales Hub section.
  if (normalized === "product manager" || normalized === "group product manager") {
    return "/employee-portals";
  }
  if (normalized === "ceo") return "/admin/ceo-command-center";
  return portalLandingRoleNames.has(normalized) ? "/employee-portals" : "/admin";
}
