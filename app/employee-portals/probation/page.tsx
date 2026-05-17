import { redirect } from "next/navigation";
import { ProbationTracker } from "@/components/probation/probation-tracker";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
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
import { getProbationRows, isProbationSchemaMissing, probationErrorMessage } from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

function probationPageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error)) return "Supabase request timed out. Check your connection and try again.";
  if (isEmployeeDirectoryEnvMissing(error)) return "Supabase environment variables are missing.";
  if (isEmployeeDirectorySchemaMissing(error)) return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  if (isProbationSchemaMissing(error)) return "Probation review schema is not ready.";
  return probationErrorMessage(error) || employeeDirectoryErrorMessage(error);
}

export default async function EmployeePortalProbationPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  await assertPermission(access, "probation", "read");
  const canSubmitManagerFeedback = access.role === "District Manager" || access.role === "Regional Manager" || access.role === "National Sales Manager" || access.role === "Manager";
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
      description="Track probation timelines for your own profile or scoped team."
      title="Probation Tracker"
    >
      <ProbationTracker
        capabilities={{ canCreate: false, canExport: false, canManageWorkflow: false, canSubmitManagerFeedback, viewerMode: canSubmitManagerFeedback ? "manager" : "employee" }}
        initialData={initialData}
        initialError={initialError}
      />
    </EmployeePortalPageShell>
  );
}
