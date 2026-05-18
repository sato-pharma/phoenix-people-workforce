import { HrCalendar } from "@/components/hr-calendar/hr-calendar";
import { AppShell } from "@/components/layout/app-shell";
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

  return (
    <AppShell navigationMode="admin">
      <HrCalendar
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
