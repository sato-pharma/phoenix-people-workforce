import { AppShell } from "@/components/layout/app-shell";
import { OrganogramReport } from "@/components/reports/organogram-report";
import { redirect } from "next/navigation";

import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessCompanyOrganogram, getOrganogramReport } from "@/lib/reports/organogram";
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
    if (resolveNavigationMode(access) === "employee-portal") {
      redirect("/employee-portals/organogram");
    }

    redirect("/employee-portals");
  }

  let initialError: string | null = null;
  let initialReport = null;

  try {
    initialReport = await getOrganogramReport(access, { mode: "company" });
  } catch (error) {
    initialError = organogramPageError(error);
  }

  return (
    <AppShell contentWidth="full" navigationMode="admin">
      <OrganogramReport
        initialError={initialError}
        initialReport={initialReport}
      />
    </AppShell>
  );
}
