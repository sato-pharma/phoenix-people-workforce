import { ProbationTracker } from "@/components/probation/probation-tracker";
import { redirect } from "next/navigation";

import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import {
  employeeDirectoryErrorMessage,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import {
  canReadAllProbation,
  canViewAllProbation,
  getProbationRows,
  isProbationAdministrator,
  isProbationSchemaMissing,
  probationErrorMessage,
} from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

function probationPageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error)) {
    return "Supabase request timed out. Check your connection and try again.";
  }

  if (isEmployeeDirectoryEnvMissing(error)) {
    return "Supabase environment variables are missing.";
  }

  if (isEmployeeDirectorySchemaMissing(error)) {
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  }

  if (isProbationSchemaMissing(error)) {
    return "Probation review schema is not ready. Run supabase/scripts/20260510_probation_workflow.sql in Supabase SQL editor.";
  }

  return probationErrorMessage(error) || employeeDirectoryErrorMessage(error);
}

export default async function ProbationPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/probation");
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/probation");
  }

  if (!canReadAllProbation(access)) {
    redirect("/employee-portals");
  }
  const canAdminister = isProbationAdministrator(access);

  let initialData: ProbationRow[] | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getProbationRows(access);
  } catch (error) {
    initialError = probationPageError(error);
  }

  return (
    <ProbationTracker
      capabilities={{
        canCreate: canAdminister,
        canExport: canViewAllProbation(access),
        canManageWorkflow: canAdminister,
        canSubmitManagerFeedback: canAdminister,
        viewerMode: access.role === "CEO" ? "executive" : "hr",
      }}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
