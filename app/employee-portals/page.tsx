import { redirect } from "next/navigation";

import { PortalCommandCenter } from "@/components/employee-portal/portal-command-center";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { getPortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { isForbiddenError } from "@/lib/auth/server";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

export default async function EmployeePortalsHomePage() {
  const access = await resolveAuthenticatedPageAccess();
  const mode = resolveNavigationMode(access);

  if (mode !== "employee-portal") {
    redirect("/overview");
  }
  // The Training Manager used to be bounced into the coaching dashboard here. That whole section is
  // now hidden from the portal (owner, 2026-09-29: hide training manager + coaching system-wide), so
  // a Training Manager lands on the normal portal home like every other portal role.
  try {
    await assertPermission(access, "employee_profile", "read");
  } catch (error) {
    if (isForbiddenError(error)) redirect("/login");
    throw error;
  }

  let snapshot;
  try {
    snapshot = await getPortalHomeSnapshot(access);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals", module: "home-snapshot", role: access.role, hrId: access.hrId },
      error,
    );
    return (
      <EmployeePortalEmptyState
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
      />
    );
  }

  return <PortalCommandCenter snapshot={snapshot} access={access} />;
}
