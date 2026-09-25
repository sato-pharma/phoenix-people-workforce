import { redirect } from "next/navigation";

import { ContactHRSupportPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

// dir="auto", print stylesheet, prefers-reduced-motion, and a page-level
// WorkspaceErrorBoundary are now provided automatically by
// EmployeePortalPageShell.

export default async function EmployeePortalContactHRSupportPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "support_requests", "create");

  let data = null;
  try {
    data = await getEmployeePortalShellData(access);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/contact-hr-support", module: "contact-hr-support", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your profile. Please try again or contact your administrator."
        title="Something Went Wrong"
      />
    );
  }

  return (
    // Badge and title follow the sidebar (section "Leave & HR", row "Request Support"), so the
    // page a rep lands on is named exactly what he tapped.
    <EmployeePortalPageShell
      badge="Leave & HR"
      description="Ask HR for help, and follow every request you have sent."
      errorBoundaryTitle="Request Support unavailable"
      title="Request Support"
    >
      <ContactHRSupportPage data={data} />
    </EmployeePortalPageShell>
  );
}
