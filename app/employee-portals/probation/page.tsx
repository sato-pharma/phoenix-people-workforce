import { redirect } from "next/navigation";

import { EmployeeProbationDashboard } from "@/components/employee-portal/employee-probation-dashboard";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  employeeDirectoryErrorMessage,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import {
  getProbationRows,
  isProbationSchemaMissing,
  probationErrorMessage,
} from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

/* ---------- error handling ---------- */

function probationPageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error))
    return "Supabase request timed out. Check your connection and try again.";
  if (isEmployeeDirectoryEnvMissing(error))
    return "Supabase environment variables are missing.";
  if (isEmployeeDirectorySchemaMissing(error))
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  if (isProbationSchemaMissing(error))
    return "Probation review schema is not ready.";
  return (
    probationErrorMessage(error) || employeeDirectoryErrorMessage(error)
  );
}

/* ---------- page ---------- */

export default async function EmployeePortalProbationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/probation");
  }

  await assertPermission(access, "probation", "read");

  const params = await searchParams;
  const feedbackEmployeeHrId = typeof params.feedbackEmployeeHrId === "string" ? params.feedbackEmployeeHrId : null;
  const feedbackCycle = typeof params.cycle === "string" ? parseInt(params.cycle, 10) : null;

  const canSubmitManagerFeedback =
    access.role === "District Manager" ||
    access.role === "Regional Manager" ||
    access.role === "National Sales Manager" ||
    access.role === "Training Manager" ||
    access.role === "Product Manager" ||
    access.role === "Group Product Manager" ||
    access.role === "Manager";

  const canManageDvCheckboxes = access.role === "Super Admin";

  let initialData: ProbationRow[] | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getProbationRows(access);
  } catch (error) {
    initialError = probationPageError(error);
  }

  if (initialError) {
    return (
      <EmployeePortalEmptyState
        message={initialError}
        title="Probation Tracker Unavailable"
      />
    );
  }

  if (!initialData || initialData.length === 0) {
    return (
      <EmployeePortalEmptyState
        message="No active probation records found for your current scope."
        title="Probation Tracker"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="People Operations"
      description="Track probation timelines and risk zones for your scoped team."
      errorBoundaryTitle="Probation Tracker unavailable"
      title="Probation Tracker"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>
      <EmployeeProbationDashboard
        canManageDvCheckboxes={canManageDvCheckboxes}
        canSubmitManagerFeedback={canSubmitManagerFeedback}
        feedbackCycle={feedbackCycle}
        feedbackEmployeeHrId={feedbackEmployeeHrId}
        initialData={initialData}
      />
    </EmployeePortalPageShell>
  );
}
