import { redirect } from "next/navigation";
import { OrganogramReport } from "@/components/reports/organogram-report";
import { assertPermission, normalizeHrId, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  EmployeePortalPageShell,
  EmployeePortalEmptyState,
} from "@/components/employee-portal/enterprise-shell";
import {
  errorMessage,
  getVacancyReport,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

function organogramPageError(error: unknown) {
  if (isSupabaseTimeout(error)) return "Supabase request timed out. Check your Supabase connection and try again.";
  if (isSupabaseEnvMissing(error)) return "Supabase environment variables are missing. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local.";
  if (isDatabaseSchemaMissing(error)) return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in the Supabase SQL editor.";
  return errorMessage(error);
}

export default async function EmployeePortalOrganogramPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  if (!access.role.toLowerCase().includes("national sales manager")) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "organogram", "read");
  let initialError: string | null = null;
  let initialReport = null;
  let fixedLine: string | null = null;

  try {
    initialReport = await getVacancyReport();
    const currentHrId = normalizeHrId(access.hrId);
    const currentEmployee = (initialReport?.organogramRows ?? []).find(
      (row) => row.type === "employee" && normalizeHrId(row.hrId) === currentHrId,
    );
    fixedLine = currentEmployee?.lineName ?? null;
  } catch (error) {
    initialError = organogramPageError(error);
  }

  if (initialError) {
    return (
      <EmployeePortalEmptyState
        message={initialError}
        title="Organogram Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      description="Understand reporting structure and role relationships for your territory."
      title="Organogram"
    >
      <OrganogramReport fixedLine={fixedLine} initialError={initialError} initialReport={initialReport} showHero={false} />
    </EmployeePortalPageShell>
  );
}
