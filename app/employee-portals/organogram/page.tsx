import { redirect } from "next/navigation";

import { EmployeeOrganogramDashboard } from "@/components/employee-portal/employee-organogram-dashboard";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canAccessCompanyOrganogram,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLineForEmployee,
} from "@/lib/reports/organogram";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

// Print stylesheet + dir="auto" are now provided automatically by
// EmployeePortalPageShell.

/* ---------- error handling ---------- */

function organogramPageError(error: unknown) {
  if (isSupabaseTimeout(error))
    return "Supabase request timed out. Check your connection and try again.";
  if (isSupabaseEnvMissing(error))
    return "Supabase environment variables are missing.";
  if (isDatabaseSchemaMissing(error))
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in Supabase SQL editor.";
  return errorMessage(error);
}

/* ---------- page ---------- */

export default async function EmployeePortalOrganogramPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  // Company-wide roles (Training Manager / Marketing Manager / CEO / Super Admin) reach the
  // organogram via canAccessCompanyOrganogram; line roles via isLineScopedOrganogramRole.
  // The page previously checked only the latter, redirecting TM/MM away despite their access.
  const isCompanyScoped = canAccessCompanyOrganogram(access);
  if (!isCompanyScoped && !isLineScopedOrganogramRole(access)) {
    redirect("/employee-portals");
  }

  await assertPermission(access, "organogram", "read");

  let initialError: string | null = null;
  let initialReport = null;
  let fixedLine: string | null = null;

  try {
    if (isCompanyScoped) {
      initialReport = await getOrganogramReport(access, { mode: "company" });
    } else {
      fixedLine = await resolveOrganogramLineForEmployee(access);
      if (!fixedLine) {
        initialError = "Unable to resolve your Organogram line scope.";
      } else {
        initialReport = await getOrganogramReport(access, { lineName: fixedLine, mode: "line" });
      }
    }
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
      badge="People Operations"
      description="Understand reporting structure and role relationships for your territory."
      errorBoundaryTitle="Organogram unavailable"
      title="Organogram"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ScopeBadge scope={access.scope} />
      </div>
      <EmployeeOrganogramDashboard
        fixedLine={fixedLine}
        initialError={initialError}
        initialReport={initialReport}
      />
    </EmployeePortalPageShell>
  );
}
