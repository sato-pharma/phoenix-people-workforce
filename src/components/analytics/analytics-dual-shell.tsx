import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { EmployeePortalServerShell } from "@/components/employee-portal/employee-portal-server-shell";
import { resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";

/**
 * Shell selector for the sales-analytics dashboards.
 *
 * These pages live OUTSIDE the `(admin)` route group so portal-nav sales roles
 * (Med Rep / DSM / RM / NSM / PM / GPM / MM) can reach them — the `(admin)` group
 * layout hard-redirects portal-mode users away, which is correct for payroll/HR
 * but would block field roles from their own scoped analytics. Living outside the
 * group means each page renders its own chrome instead of inheriting the group
 * AppShell, so this helper picks the right one:
 *   - admin-nav viewers  → the admin AppShell (sidebar/topbar they already know)
 *   - portal-nav viewers → the employee-portal chrome
 *
 * This only chooses the surrounding chrome. Access control still rests entirely
 * on each page's own `assertPermission(access, "sales", "read")` call plus the
 * per-viewer `AnalyticsViewerScope` folded into every query — there is no
 * middleware, so removing the group layout does not remove a security boundary.
 */
export function AnalyticsDualShell({
  access,
  children,
}: {
  access: AccessContext;
  children: ReactNode;
}) {
  if (resolveNavigationMode(access) === "employee-portal") {
    return <EmployeePortalServerShell access={access}>{children}</EmployeePortalServerShell>;
  }
  return (
    <AppShell accessContext={access} navigationMode="admin">
      {children}
    </AppShell>
  );
}
