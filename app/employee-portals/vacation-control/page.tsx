import { redirect } from "next/navigation";

import { VacationControl } from "@/components/vacation/vacation-control";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, isHrAuthorityRole, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getVacationControlData, vacationErrorMessage } from "@/lib/vacation/service";
import type { VacationControlData } from "@/lib/vacation/types";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/leave-management/vacation-control/page.tsx.
export default async function EmployeePortalVacationControlPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/leave-management/vacation-control");
  }
  if (!isHrAuthorityRole(access.role) || !(await canAccess(access, "leave", "update"))) {
    return (
      <EmployeePortalEmptyState
        message="Vacation policy control is available to Talent Acquisition and Super Admin only."
        title="Vacation Control Unavailable"
      />
    );
  }

  let initialData: VacationControlData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationControlData(access);
  } catch (error) {
    initialError = vacationErrorMessage(error);
  }

  return (
    <EmployeePortalPageShell
      badge="Talent Acquisition"
      description="Configure vacation policy and entitlement rules."
      errorBoundaryTitle="Vacation Control unavailable"
      title="Vacation Control"
    >
      <VacationControl initialData={initialData} initialError={initialError} />
    </EmployeePortalPageShell>
  );
}
