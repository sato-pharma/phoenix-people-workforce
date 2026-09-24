import { HrCalendar } from "@/components/hr-calendar/hr-calendar";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getHrCalendarData, hrCalendarErrorMessage } from "@/lib/hr-calendar/service";
import type { HrCalendarEmployee } from "@/lib/hr-calendar/types";

export const dynamic = "force-dynamic";

export default async function HrCalendarPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "hr_calendar", "read")) {
    redirect("/employee-portals");
  }
  let initialData: HrCalendarEmployee[] | null = null;
  let initialError: string | null = null;

  try {
    initialData = await getHrCalendarData();
  } catch (error) {
    initialError = hrCalendarErrorMessage(error);
  }

  // Printing a milestone card is Super Admin only (the milestones gate). The calendar chips link
  // there only for someone who holds it; everyone else sees the same events without a link.
  const canPrintCards = await canAccess(access, "milestones", "export");

  return (
    <HrCalendar
      canPrintCards={canPrintCards}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
