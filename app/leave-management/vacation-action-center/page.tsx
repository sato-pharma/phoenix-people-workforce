import { redirect } from "next/navigation";

import { VacationActionCenter } from "@/components/vacation/vacation-action-center";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getVacationActionCenterData, vacationErrorMessage } from "@/lib/vacation/service";
import type { VacationActionCenterData } from "@/lib/vacation/types";

export const dynamic = "force-dynamic";

export default async function VacationActionCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ requestId?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "leave", "read"))) {
    redirect("/leave-management/vacation-request");
  }

  const { requestId } = await searchParams;

  let initialData: VacationActionCenterData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationActionCenterData(access);
  } catch (error) {
    initialError = vacationErrorMessage(error);
  }

  return (
    <VacationActionCenter
      initialData={initialData}
      initialError={initialError}
      initialRequestId={requestId ?? null}
    />
  );
}
