import { OrganogramReport } from "@/components/reports/organogram-report";
import { redirect } from "next/navigation";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessCompanyOrganogram, getOrganogramReport, isLineScopedOrganogramRole, resolveOrganogramLineForEmployee } from "@/lib/reports/organogram";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

function organogramPageError(error: unknown) {
  if (isSupabaseTimeout(error)) {
    return "Supabase request timed out. Check your Supabase connection and try again.";
  }

  if (isSupabaseEnvMissing(error)) {
    return "Supabase environment variables are missing. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local.";
  }

  if (isDatabaseSchemaMissing(error)) {
    return "Supabase schema is not ready. Run supabase/phoenix-schema.sql in the Supabase SQL editor.";
  }

  return errorMessage(error);
}

export default async function OrganogramPage() {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "organogram", "read")) {
    redirect("/employee-portals");
  }

  if (!canAccessCompanyOrganogram(access)) {
    if (isLineScopedOrganogramRole(access) && resolveNavigationMode(access) === "admin") {
      // fall through — line-scoped fetch below
    } else if (resolveNavigationMode(access) === "employee-portal") {
      redirect("/employee-portals/organogram");
    } else {
      redirect("/employee-portals");
    }
  }

  let initialError: string | null = null;
  let initialReport = null;
  let fixedLine: string | null = null;

  try {
    if (canAccessCompanyOrganogram(access)) {
      initialReport = await getOrganogramReport(access, { mode: "company" });
    } else {
      const lineName = await resolveOrganogramLineForEmployee(access);
      fixedLine = lineName;
      initialReport = await getOrganogramReport(access, { mode: "line", lineName });
    }
    if (initialReport?.diagnostic) {
      initialError = initialReport.diagnostic.message;
    }
  } catch (error) {
    initialError = organogramPageError(error);
  }

  // The same capability POST /api/employees asserts. Decides only whether an OPEN SEAT
  // popup offers the way through to a pre-filled Add Employee form — the organogram is
  // readable by plenty of roles that may not hire.
  // employees:create, not update, since the HR Operations Specialist seat (2026-10-20): she edits
  // the master but does not add to it, and POST /api/employees asserts create on every add.
  const canAddEmployee = await canAccess(access, "employees", "create");

  return (
    <OrganogramReport
      canAddEmployee={canAddEmployee}
      fixedLine={fixedLine}
      initialError={initialError}
      initialReport={initialReport}
    />
  );
}
