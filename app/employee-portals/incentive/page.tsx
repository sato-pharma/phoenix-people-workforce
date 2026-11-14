import { redirect } from "next/navigation";

import { EmployeePortalIncentivePage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getEmployeePortalIncentiveData } from "@/lib/employee-portal/service";
import { recordShownIncentive } from "@/lib/incentives/shown-figures-store";

export const dynamic = "force-dynamic";

// The sidebar's own words: "Incentive" under "Pay & Expenses". The unavailable state keeps the same
// header, so the page never loses its title when the data does not load.
const PAGE_BADGE = "Pay & Expenses";
const PAGE_TITLE = "Incentive";
const PAGE_DESCRIPTION = "Review your incentive progress and earnings incentives in the same place.";

export default async function EmployeePortalIncentivePageRoute() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }
  if (access.role === "Marketing Manager") {
    redirect("/employee-portals");
  }

  await assertPermission(access, "incentive", "read");

  let data = null;
  try {
    data = await getEmployeePortalIncentiveData(access);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/incentive", module: "incentive", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }
  // The figure this tab shows the person is stored the first time, and again only when it changes
  // (REC-066). Best-effort: it never costs the person their tab.
  await recordShownIncentive(access, data);

  if (!data) {
    return (
      <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
        <EmployeePortalEmptyState
          message="Unable to load incentive data. Please try again later."
          title="Portal Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  return (
    <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
      <EmployeePortalIncentivePage data={data} />
    </EmployeePortalPageShell>
  );
}
