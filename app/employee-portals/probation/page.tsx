import { redirect } from "next/navigation";

import { EmployeeProbationDashboard } from "@/components/employee-portal/employee-probation-dashboard";
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
import {
  getProbationRows,
  isProbationSchemaMissing,
  probationErrorMessage,
} from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";

export const dynamic = "force-dynamic";

/* ---------- print stylesheet ---------- */

const printStyles = `
@media print {
  body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  nav, header, footer, button, [data-no-print] { display: none !important; }
  .print\\:break-inside-avoid { break-inside: avoid; }
  .print\\:shadow-none { box-shadow: none !important; }
  * { border-color: #e2e8f0 !important; }
}
`;

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

export default async function EmployeePortalProbationPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  await assertPermission(access, "probation", "read");

  const canSubmitManagerFeedback =
    access.role === "District Manager" ||
    access.role === "Regional Manager" ||
    access.role === "National Sales Manager" ||
    access.role === "Manager";

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
      title="Probation Tracker"
    >
      {/* Print stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      <EmployeeProbationDashboard
        canSubmitManagerFeedback={canSubmitManagerFeedback}
        initialData={initialData}
      />
    </EmployeePortalPageShell>
  );
}
