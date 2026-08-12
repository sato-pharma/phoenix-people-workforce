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
  // "/admin/weekly-plans?plan=<id>" (the planner) before the dedicated Approvals Hub plan page
  // existed. Portal-mode managers clicking those links otherwise land on the planner/home instead
  // of their plan approval page. Rewrite at read time so existing notifications land correctly.
  if (role && PORTAL_PLAN_ROLES.has(role) && fallback.startsWith("/admin/weekly-plans")) {
    const planMatch = /[?&]plan=([^&]+)/.exec(fallback);
    const planId = planMatch ? planMatch[1] : null;
    return planId ? `/employee-portals/approvals/plan/${planId}` : "/employee-portals/approvals/plan";
  }

  const isPortal = Boolean(role && PORTAL_PLAN_ROLES.has(role));

  // Vacation approvals now live on the dedicated per-request page (Approvals Hub › Vacation
  // Approvals). Route the new canonical URL, the legacy vacation-action-center / vacation-report
  // links, AND the legacy combined-hub approvals-hub?module=leave link to the correct shell so old
  // and new notifications all land there (never back in the residual "Other Approvals" inbox).
  {
    const legacyActionCenter = fallback.startsWith("/leave-management/vacation-action-center");
    const legacyHub = /approvals-hub\?/.test(fallback) && /module=leave/.test(fallback);
    const current = fallback.startsWith("/admin/approvals/vacation") || fallback.startsWith("/employee-portals/approvals/vacation");
    if (legacyActionCenter || legacyHub || current) {
      const requestId =
        /[?&]requestId=([^&]+)/.exec(fallback)?.[1] ??
        /[?&]id=([^&]+)/.exec(fallback)?.[1] ??
        /\/approvals\/vacation\/([^/?#]+)/.exec(fallback)?.[1] ??
        null;
      const base = isPortal ? "/employee-portals/approvals/vacation" : "/admin/approvals/vacation";
      return requestId ? `${base}/${requestId}` : base;
    }
  }

  // Excuse approvals — route new canonical URL and the legacy approvals-hub?module=excuse link.
  {
    const legacyHub = /approvals-hub\?/.test(fallback) && /module=excuse/.test(fallback);
    const current = fallback.startsWith("/admin/approvals/excuse") || fallback.startsWith("/employee-portals/approvals/excuse");
    if (legacyHub || current) {
      const id =
        /[?&]id=([^&]+)/.exec(fallback)?.[1] ??
        /\/approvals\/excuse\/([^/?#]+)/.exec(fallback)?.[1] ??
        null;
      const base = isPortal ? "/employee-portals/approvals/excuse" : "/admin/approvals/excuse";
      return id ? `${base}/${id}` : base;
    }
  }

  // Plan approvals — route the new canonical URL and the legacy approvals-hub?module=weekly_plan
  // link to the correct shell for the viewer, mirroring vacation/excuse.
  {
    const legacyHub = /approvals-hub\?/.test(fallback) && /module=weekly_plan/.test(fallback);
    const current = fallback.startsWith("/admin/approvals/plan") || fallback.startsWith("/employee-portals/approvals/plan");
    if (legacyHub || current) {
      const id =
        /[?&]id=([^&]+)/.exec(fallback)?.[1] ??
        /\/approvals\/plan\/([^/?#]+)/.exec(fallback)?.[1] ??
        null;
      const base = isPortal ? "/employee-portals/approvals/plan" : "/admin/approvals/plan";
      return id ? `${base}/${id}` : base;
    }
  }

  // Direct-order approvals — notifyDirectOrder always writes the ADMIN path, so a portal-shell
  // manager (District / Regional / National Sales / Product Manager — every direct-order requester
  // role except Super Admin and CEO) landed outside their own shell. Remapping here rather than at
  // the write site also repairs every notification already sitting in the table, because this runs
  // at read time.
  {
    const retired =
      fallback.startsWith("/admin/approvals/direct-orders") ||
      fallback.startsWith("/employee-portals/approvals/direct-orders");
    const live =
      fallback.startsWith("/admin/direct-orders") || fallback.startsWith("/employee-portals/direct-orders");
    if (retired || live) {
      const id =
        /\/approvals\/direct-orders\/([^/?#]+)/.exec(fallback)?.[1] ??
        /\/(?:admin|employee-portals)\/direct-orders\/([^/?#]+)/.exec(fallback)?.[1] ??
        null;
      // Emits the LIVE workspace route. It used to emit the retired approvals path, which resolved
      // only because next.config.ts redirects it — so every already-stored row got repaired into a
      // URL that still needed rescuing. Rows written before 2026-08-12 carry the old path and are
      // matched by `retired` above, so they land on the current route in one hop.
      const base = isPortal ? "/employee-portals/direct-orders" : "/admin/direct-orders";
      return id ? `${base}/${id}` : `${base}?view=needs-action`;
    }
  }

  return fallback;
}
