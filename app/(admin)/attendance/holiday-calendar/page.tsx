import { redirect } from "next/navigation";

import { HolidayCalendarManager } from "@/components/attendance/holiday-calendar-manager";
import { buildHolidayCalendarYearView } from "@/lib/attendance/holiday-overrides";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AttendanceHolidayCalendarPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }
  const canEdit = await canAccessAttendanceSetup(access, "update");

  const year = new Date().getUTCFullYear();
  let initialView: Awaited<ReturnType<typeof buildHolidayCalendarYearView>> | null = null;
  let initialError: string | null = null;
  try {
    initialView = await buildHolidayCalendarYearView(year);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Holiday calendar failed to load.";
  }

  return <HolidayCalendarManager canEdit={canEdit} initialError={initialError} initialView={initialView} initialYear={year} />;
}
