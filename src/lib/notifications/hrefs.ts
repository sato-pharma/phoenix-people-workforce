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
    return fallback.replace("/admin/weekly-plans", "/employee-portals/plans");
  }

  return fallback;
}
