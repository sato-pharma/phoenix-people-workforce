import { redirect } from "next/navigation";

import { VacationControl } from "@/components/vacation/vacation-control";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getVacationControlData, vacationErrorMessage } from "@/lib/vacation/service";
import type { VacationControlData } from "@/lib/vacation/types";

export const dynamic = "force-dynamic";

export default async function VacationControlPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "leave", "update")) {
    redirect("/leave-management/vacation-request");
  }

  let initialData: VacationControlData | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getVacationControlData(access);
  } catch (error) {
    initialError = vacationErrorMessage(error);
  }

  return <VacationControl initialData={initialData} initialError={initialError} />;
}
