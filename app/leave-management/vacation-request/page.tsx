import { VacationRequestForm } from "@/components/vacation/vacation-request-form";
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
  let initialData: Awaited<ReturnType<typeof getVacationRequestPageData>> | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationRequestPageData(access);
  } catch (error) {
    initialError = vacationRequestPageError(error);
  }

  return <VacationRequestForm initialData={initialData} initialError={initialError ?? initialData?.balanceError ?? null} />;
}
