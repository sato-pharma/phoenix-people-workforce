import type { PhoenixRole } from "@/lib/auth/permissions";

// Tile matrix for the employee-portal sales-analytics module (/employee-portals/sales-analytics).
// Every sales portal role gets the three CORE dashboards (Source of Sales, Monthly Closing, Weekly),
// each scoped to the viewer. The two DETAILED dashboards — Executive Comparison and Cross-Source
// Reconciliation — are additionally shown to the Regional Manager (region-scoped, per owner: "RM must
// see detailed sales analytics") and the line-scoped managers. Medical Rep and District Manager get
// the core three only. CEO / Super Admin / SFE Manager use the /admin analytics tree instead.
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
