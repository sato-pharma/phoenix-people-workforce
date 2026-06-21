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
  // Financial Advisor's job is executing the marketing finance step — land on its workspace inbox.
  if (normalized === "financial advisor") return "/workspace/marketing-requests/inbox";
  if (normalized === "training manager") return "/employee-portals/training-manager";
  // Product / Group Product Managers are Sales-Intelligence-first: their portal home (the rep
  // performance chart) is empty for them, so land them on their Weekly Sales SI surface instead.
  if (normalized === "product manager" || normalized === "group product manager") {
    return "/employee-portals/weekly-sales";
  }
  if (normalized === "ceo") return "/admin/ceo-command-center";
  return portalLandingRoleNames.has(normalized) ? "/employee-portals" : "/admin";
}
