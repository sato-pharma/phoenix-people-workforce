import { redirect } from "next/navigation";

import { EmployeePortalIncentivePage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePortalIncentiveData } from "@/lib/employee-portal/service";

export const dynamic = "force-dynamic";

export default async function EmployeePortalIncentivePageRoute() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }

  await assertPermission(access, "employee_profile", "read");

  let data = null;
  try {
    data = await getEmployeePortalIncentiveData(access);
  } catch (error) {
    console.error("[employee-portal] incentive data load failed:", error);
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load incentive data. Please try again later."
        title="Portal Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Review your incentive progress and earnings incentives in the same place."
      title="Incentive Center"
    >
      <EmployeePortalIncentivePage data={data} />
    </EmployeePortalPageShell>
  );
}
