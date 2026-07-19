import type { PhoenixRole } from "@/lib/auth/permissions";

// Role gates for the dual-mode Sales Analytics module (/admin/analytics and
// /employee-portals/sales-analytics). Single source of truth for every page in both trees — the
// hub pages (which filter their own tile lists) and the data-bearing dashboard pages must both
// import from here so the two can never drift, which is exactly what happened before this file
// grew these exports: the admin hub filtered its Executive Comparison / Reconciliation tiles to
// Super Admin / CEO, but the two pages those tiles link to had NO role check of their own — any
// role holding the broad `sales:read` permission (e.g. Finance Manager, company-scope) could open
// them directly by URL and get the unrestricted, company-wide view. Likewise every core dashboard
// page (Source of Sales / Monthly Closing / Weekly, both mounts) previously relied on `sales:read`
// / `weekly_sales:read` alone, which the generic `Employee` and `Manager` roles also hold by
// default — neither is a sales role and neither has a Sales Analytics nav link, but without a
// page-level allowlist that only hid the door, it didn't lock it.

// ── Portal mount (/employee-portals/sales-analytics) ──────────────────────────────────────────
// Every sales-facing field/manager role gets the 3 core dashboards (Source of Sales, Monthly
// Closing, Weekly), each scoped to the viewer via resolveAnalyticsViewerScope. Mirrors
// showSalesAnalyticsTab in src/lib/employee-portal/navigation.ts exactly (including "Manager" as
// the legacy alias for District Manager — see access-scope.ts / permissions.ts scopeForRole) —
// keep both lists in lockstep.
const PORTAL_CORE_ANALYTICS_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Medical Rep",
  "District Manager",
  "Manager",
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
]);

export function canViewPortalCoreAnalytics(role: PhoenixRole): boolean {
  return PORTAL_CORE_ANALYTICS_ROLES.has(role);
}

// The two DETAILED dashboards — Executive Comparison and Cross-Source Reconciliation — are
// additionally shown to the Regional Manager (region-scoped, per owner: "RM must see detailed
// sales analytics") and the line-scoped managers. Medical Rep and District Manager get the core
// three only. CEO / Super Admin / SFE Manager use the /admin analytics tree instead.
const PORTAL_DETAILED_ANALYTICS_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Regional Manager",
  "National Sales Manager",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
]);

export function canViewPortalDetailedAnalytics(role: PhoenixRole): boolean {
  return PORTAL_DETAILED_ANALYTICS_ROLES.has(role);
}

// ── Admin mount (/admin/analytics) ────────────────────────────────────────────────────────────
// Company-scope roles who reach the full module via /admin (portal-mode roles never reach this
// tree at all — the (admin) route group layout bounces them to /employee-portals first).
const ADMIN_CORE_ANALYTICS_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
  "SFE Manager",
]);

export function canViewAdminCoreAnalytics(role: PhoenixRole): boolean {
  return ADMIN_CORE_ANALYTICS_ROLES.has(role);
}

// Executive Comparison / Reconciliation on the admin side are CEO / Super Admin only — SFE
// Manager gets the three core dashboards but not these two, same tiering idea as the portal side.
const ADMIN_DETAILED_ANALYTICS_ROLES: ReadonlySet<PhoenixRole> = new Set<PhoenixRole>([
  "Super Admin",
  "CEO",
]);

export function canViewAdminDetailedAnalytics(role: PhoenixRole): boolean {
  return ADMIN_DETAILED_ANALYTICS_ROLES.has(role);
}
