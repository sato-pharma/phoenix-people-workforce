import { redirect } from "next/navigation";

import { ResignationsWorkspace } from "@/components/resignations/resignations-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getResignationsDashboardData,
  isResignationsSchemaMissing,
  resignationErrorMessage,
} from "@/lib/resignations/service";
import type { ResignationDashboardData } from "@/lib/resignations/types";

export const dynamic = "force-dynamic";

function resignationsPageError(error: unknown) {
  if (isResignationsSchemaMissing(error)) {
    return "Resignations schema is not ready. Run the Supabase migration for employee_resignations.";
  }
  return resignationErrorMessage(error);
}

// Portal mirror of app/(admin)/resignations/page.tsx.
export default async function EmployeePortalResignationsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/resignations");
  }
  if (!(await canAccess(access, "resignations", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Resignations are available to the HR seats and the Super Admin only."
        title="Resignations Unavailable"
      />
    );
  }

  let initialData: ResignationDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getResignationsDashboardData(access);
  } catch (error) {
    initialError = resignationsPageError(error);
  }

  return (
    <EmployeePortalPageShell
      badge="Employee Records"
      description="Track and process employee resignations."
      errorBoundaryTitle="Resignations unavailable"
      title="Resignations"
    >
      <ResignationsWorkspace
        canExportHistory={await canAccess(access, "resignations", "export")}
        canCreate={await canAccess(access, "resignations", "create")}
        initialData={initialData}
        initialError={initialError}
        surface="portal"
      />
    </EmployeePortalPageShell>
  );
}
