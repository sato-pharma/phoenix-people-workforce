import { AppShell } from "@/components/layout/app-shell";
import { ResignationsReport } from "@/components/reports/resignations-report";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getResignationsDashboardData,
  isResignationsSchemaMissing,
  resignationErrorMessage,
} from "@/lib/resignations/service";
import type { ResignationDashboardData } from "@/lib/resignations/types";

export const dynamic = "force-dynamic";

function resignationsPageError(error: unknown) {
  if (isResignationsSchemaMissing(error)) {
    return "Resignations schema is not ready. Run the Supabase migration for employee_resignations.";
  }
  return resignationErrorMessage(error);
}

export default async function ResignationsPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "resignations", "read");

  let initialData: ResignationDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getResignationsDashboardData();
  } catch (error) {
    initialError = resignationsPageError(error);
  }

  return (
    <AppShell>
      <ResignationsReport initialData={initialData} initialError={initialError} />
    </AppShell>
  );
}
