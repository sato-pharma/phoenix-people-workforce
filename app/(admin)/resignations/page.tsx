import { ResignationsWorkspace } from "@/components/resignations/resignations-workspace";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canChangeResignationDates,
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
  if (!await canAccess(access, "resignations", "read")) {
    redirect("/employee-portals");
  }

  let initialData: ResignationDashboardData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getResignationsDashboardData(access);
  } catch (error) {
    initialError = resignationsPageError(error);
  }

  return (
    <ResignationsWorkspace
      canExportHistory={await canAccess(access, "resignations", "export")}
      canCreate={await canAccess(access, "resignations", "create")}
      canDecide={await canAccess(access, "resignations", "approve")}
      canEditDates={await canChangeResignationDates(access)}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
