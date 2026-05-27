import { redirect } from "next/navigation";

import { EmployeeOrganogramDashboard } from "@/components/employee-portal/employee-organogram-dashboard";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, normalizeHrId, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  errorMessage,
  getVacancyReport,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

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
      badge="People Operations"
      description="Understand reporting structure and role relationships for your territory."
      title="Organogram"
    >
      {/* Print stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: printStyles }} />

      <EmployeeOrganogramDashboard
        fixedLine={fixedLine}
        initialError={initialError}
        initialReport={initialReport}
      />
    </EmployeePortalPageShell>
  );
}
