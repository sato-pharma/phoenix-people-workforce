import { AppShell } from "@/components/layout/app-shell";
import { VacanciesReport } from "@/components/reports/vacancies-report";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  errorMessage,
  getVacancyReport,
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
  if (!await canAccess(access, "vacancies", "read")) {
    redirect("/employee-portals");
  }
  let initialError: string | null = null;
  let initialReport = null;

  try {
    initialReport = await getVacancyReport();
  } catch (error) {
    initialError = vacanciesPageError(error);
  }

  return (
    <AppShell navigationMode="admin">
      <VacanciesReport
        initialError={initialError}
        initialReport={initialReport}
      />
    </AppShell>
  );
}
