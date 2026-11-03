import { VacanciesReport } from "@/components/reports/vacancies-report";
import { redirect } from "next/navigation";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canViewEmptySeatsBoard } from "@/lib/reports/empty-seats";
import { getScopedVacancyReport } from "@/lib/reports/organogram";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";

export const dynamic = "force-dynamic";

function vacanciesPageError(error: unknown) {
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

export default async function VacanciesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/vacancies");
  }

  if (!await canAccess(access, "vacancies", "read")) {
    redirect("/employee-portals");
  }
  let initialError: string | null = null;
  let initialReport = null;

  try {
    initialReport = await getScopedVacancyReport(access);
  } catch (error) {
    initialError = vacanciesPageError(error);
  }

  // The same capability POST /api/employees asserts. Decides only whether an OPEN row
  // offers the one-press hire — the vacancies report is readable by roles that may not hire.
  // employees:create, not update, since the HR Operations Specialist seat (2026-10-20): she edits
  // the master but does not add to it, and POST /api/employees asserts create on every add.
  const canAddEmployee = await canAccess(access, "employees", "create");
  const canViewEmptySeats = await canViewEmptySeatsBoard(access);

  return (
    <VacanciesReport
      canAddEmployee={canAddEmployee}
      canViewEmptySeats={canViewEmptySeats}
      initialError={initialError}
      initialReport={initialReport}
    />
  );
}
