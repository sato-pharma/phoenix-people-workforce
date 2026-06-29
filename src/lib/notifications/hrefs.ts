type RoleHrefMap = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function internalHref(value: unknown) {
  const href = cleanText(value);
  return href.startsWith("/") ? href : "";
}

function roleHrefMap(metadata: Record<string, unknown> | null | undefined): RoleHrefMap {
  const value = metadata?.roleHrefs;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RoleHrefMap
    : {};
}

// Roles that live in the employee-portal shell and must never land on admin plan pages.
// Mirrors the portalNavigationRoles set in permissions.ts — kept here as a plain Set
// so hrefs.ts stays free of auth imports.
const PORTAL_PLAN_ROLES = new Set([
  "Employee",
  "Medical Rep",
  "District Manager",
  "Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
  "Training Manager",
]);

export function notificationHrefForViewerRole(input: {
  fallbackHref?: string | null;
  metadata?: Record<string, unknown> | null;
  role?: string | null;
}) {
  const role = cleanText(input.role);
  const roleSpecificHref = role ? internalHref(roleHrefMap(input.metadata)[role]) : "";
  if (roleSpecificHref) return roleSpecificHref;

  const fallback = internalHref(input.fallbackHref);

  // Retroactive remap: old plan-submitted notifications stored action_url as
  // "/admin/weekly-plans?plan=<id>" before roleHrefs was added. Portal-mode managers
  // clicking those links get redirected to the portal home instead of the plan page.
  // Rewrite the URL here at read time so existing notifications work correctly.
  if (role && PORTAL_PLAN_ROLES.has(role) && fallback.startsWith("/admin/weekly-plans")) {
    const planMatch = /[?&]plan=([^&]+)/.exec(fallback);
    const planId = planMatch ? planMatch[1] : null;
    return planId
      ? `/employee-portals/approvals-hub?id=${planId}&module=weekly_plan`
      : "/employee-portals/approvals-hub?module=weekly_plan";
  }

  // Remap: vacation action center is guarded by Super Admin access in the admin shell.
  // Portal-mode managers (DM, RM, NSM, etc.) who receive a vacation approval notification
  // must be sent to the portal Approvals Hub instead, where the request is actionable.
  if (role && PORTAL_PLAN_ROLES.has(role) && fallback.startsWith("/leave-management/vacation-action-center")) {
    const requestIdMatch = /[?&]requestId=([^&]+)/.exec(fallback);
    const requestId = requestIdMatch ? decodeURIComponent(requestIdMatch[1]) : null;
    return requestId
      ? `/employee-portals/approvals-hub?module=leave&id=${encodeURIComponent(requestId)}`
      : "/employee-portals/approvals-hub?module=leave";
  }

  return fallback;
}
