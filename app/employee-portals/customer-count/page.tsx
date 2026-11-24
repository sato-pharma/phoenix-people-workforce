import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { CustomerCountDashboard } from "@/components/sales/customer-count-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessPortalClosing } from "@/lib/sales/monthly-closing-portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Customer Count dashboard in a manager's own portal (owner, 24 Nov 2026: "Managers, own team").
// The same gates as the portal Monthly Closing — canAccessPortalClosing and sales:read — minus the
// Medical Rep; the data route reads the viewer's own closing scope and published months only.
export default async function PortalCustomerCountPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!canAccessPortalClosing(access) || access.role === "Medical Rep") redirect(resolveLandingPathForRole(access.role));
  await assertPermission(access, "sales", "read");

  return (
    <EmployeePortalPageShell
      badge="Sales Operations"
      title="Customer Count"
      description="How many pharmacies in your team bought each month, from the published closings. A pharmacy counts once per month whatever it bought."
      errorBoundaryTitle="Customer Count unavailable"
    >
      <CustomerCountDashboard endpoint="/api/employee-portals/customer-count" />
    </EmployeePortalPageShell>
  );
}
