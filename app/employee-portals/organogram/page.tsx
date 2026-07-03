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
  resolveOrganogramLinesForEmployee,
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
  // fixedLine locks the UI filter to one line; for multi-line users it stays null
  // because the report is already pre-filtered server-side via lineNames.
  let fixedLine: string | null = null;

  try {
    if (isCompanyScoped) {
      initialReport = await getOrganogramReport(access, { mode: "company" });
    } else {
      const resolvedLines = await resolveOrganogramLinesForEmployee(access);
      if (!resolvedLines || resolvedLines.length === 0) {
        initialError = "Unable to resolve your Organogram line scope.";
      } else {
        if (resolvedLines.length === 1) fixedLine = resolvedLines[0];
        initialReport = await getOrganogramReport(access, { lineNames: resolvedLines, mode: "line" });
      }
    }
  } catch (error) {
    initialError = organogramPageError(error);
  }

  // Surface the domain diagnostic (denied scope / unresolved line / Head Office)
  // instead of silently rendering an empty "pick a line" chart. Unavailable data
  // must explain itself, never look like a legitimate empty result.
  if (!initialError && initialReport?.diagnostic) {
    initialError = initialReport.diagnostic.message;
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
        showLinePicker={access.role === "Marketing Manager" || access.role === "Training Manager"}
      />
    </EmployeePortalPageShell>
  );
}
