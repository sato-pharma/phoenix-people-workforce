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
  if (normalized === "marketing manager") return "/admin/marketing-requests";
  if (normalized === "finance manager") return "/admin/outstation/expense-command";
  if (normalized === "sfe manager") return "/admin/marketing-requests";
  if (normalized === "training manager") return "/employee-portals/training-manager";
  if (normalized === "ceo") return "/sales";
  return portalLandingRoleNames.has(normalized) ? "/employee-portals" : "/admin";
}
