import { VacationRequestForm } from "@/components/vacation/vacation-request-form";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getVacationRequestPageData,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const dynamic = "force-dynamic";

function vacationRequestPageError(error: unknown) {
  if (isVacationSchemaMissing(error)) {
    return "Vacation schema is not ready. Apply the new v2 vacation migration before using this module.";
  }
  if (isForbiddenError(error)) {
    return vacationErrorMessage(error);
  }
  return vacationErrorMessage(error) || "Unable to load vacation request data.";
}

export default async function VacationRequestPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/leave-management/vacation-request");
  let initialData: Awaited<ReturnType<typeof getVacationRequestPageData>> | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationRequestPageData(access);
  } catch (error) {
    initialError = vacationRequestPageError(error);
  }

  // The (admin) group layout redirects every portal-mode viewer to /employee-portals before this
  // page runs, so navigation mode is ALWAYS "admin" here. A second branch wrapping this in
  // EmployeePortalPageShell lived below until 2026-08-30 and could not execute: it was written for
  // a reader the layout had already sent away. Portal viewers have their own page at
  // /employee-portals/vacation-request, which is what their sidebar links and what the twin of this file
  // forwards an admin-mode viewer back from. The group layout's own comment used to name
  // leave-management as living OUTSIDE the group; it does not, and that note is corrected there.
  return <VacationRequestForm initialData={initialData} initialError={initialError ?? initialData?.balanceError ?? null} />;
}
