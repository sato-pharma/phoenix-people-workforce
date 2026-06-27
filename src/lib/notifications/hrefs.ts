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

export function notificationHrefForViewerRole(input: {
  fallbackHref?: string | null;
  metadata?: Record<string, unknown> | null;
  role?: string | null;
}) {
  const role = cleanText(input.role);
  const roleSpecificHref = role ? internalHref(roleHrefMap(input.metadata)[role]) : "";
  if (roleSpecificHref) return roleSpecificHref;

  return internalHref(input.fallbackHref);
}
