const portalLandingRoleNames = new Set([
  "employee",
  "medical rep",
  "district manager",
  "regional manager",
  "national sales manager",
  "product manager",
  "group product manager",
  "training manager",
  "marketing manager",
  "finance manager",
  "manager",
]);

export function resolveLandingPathForRole(role: string | null | undefined) {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "hr specialist" || normalized === "hr manager") return "/admin";
  if (normalized === "sfe manager") return "/admin/marketing-requests";
  if (normalized === "training manager") return "/employee-portals/training-manager";
  if (normalized === "ceo") return "/admin/sales-command";
  return portalLandingRoleNames.has(normalized) ? "/employee-portals" : "/admin";
}
