import { VacationRequestForm } from "@/components/vacation/vacation-request-form";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import {
  getVacationRequestPageData,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import { redirect } from "next/navigation";

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

export default async function EmployeePortalVacationRequestPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/leave-management/vacation-request");
  }

  let initialData: Awaited<ReturnType<typeof getVacationRequestPageData>> | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationRequestPageData(access);
  } catch (error) {
    initialError = vacationRequestPageError(error);
  }

  return (
    <EmployeePortalPageShell
      badge="Leave & HR"
      description="Ask for leave. Your request goes to your manager, then to HR, and you can follow it here."
      title="Vacation Request"
    >
      <VacationRequestForm
        initialData={initialData}
        initialError={initialError ?? initialData?.balanceError ?? null}
        showHero={false}
      />
    </EmployeePortalPageShell>
  );
}
