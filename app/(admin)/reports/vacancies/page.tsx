import { VacanciesReport } from "@/components/reports/vacancies-report";
import { redirect } from "next/navigation";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
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

  return (
    <VacanciesReport
      initialError={initialError}
      initialReport={initialReport}
    />
  );
}
