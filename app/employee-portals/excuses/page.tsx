import { redirect } from "next/navigation";

import { EmployeeExcusesWorkspace } from "@/components/employee-portal/employee-excuses-workspace";
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  excuseErrorMessage,
  getExcuseWorkspace,
  isExcusesSchemaMissing,
} from "@/lib/excuses/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

export default async function EmployeeExcusesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin");
  }

  let data = null;
  let errorMessage: string | null = null;

  try {
    data = await getExcuseWorkspace(access);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/excuses", module: "excuses", role: access.role, hrId: access.hrId },
      error,
    );
    if (isExcusesSchemaMissing(error)) {
      errorMessage = "Excuse database tables are not deployed yet. Run the latest Supabase migration.";
    } else if (isForbiddenError(error) || excuseErrorMessage(error).toLowerCase().startsWith("forbidden:")) {
      errorMessage = "Excuses are available for Head Office employees and National Sales Managers only.";
    } else {
      errorMessage = excuseErrorMessage(error) || "Unable to load excuses.";
    }
  }

  if (!data) {
    return (
      <EmployeePortalEmptyState
        message={errorMessage ?? "Unable to load excuses."}
        title="Excuses Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Leave Management"
      description="Submit a morning or afternoon 2-hour excuse, send it to your direct manager, and track the monthly usage from one focused workspace."
      title="Excuses"
    >
      <EmployeeExcusesWorkspace initialData={data} />
    </EmployeePortalPageShell>
  );
}
