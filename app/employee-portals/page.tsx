import { redirect } from "next/navigation";

import { PortalCommandCenter } from "@/components/employee-portal/portal-command-center";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { getPortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

export default async function EmployeePortalsHomePage() {
  const access = await resolveAccessContextFromPage();
  const mode = resolveNavigationMode(access);

  if (mode !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }
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
