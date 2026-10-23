import { redirect } from "next/navigation";

import { HolidayCalendarManager } from "@/components/attendance/holiday-calendar-manager";
import { buildHolidayCalendarYearView } from "@/lib/attendance/holiday-overrides";
import { canAccessAttendanceSetup } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function focusDateFromSearchParams(searchParams: Record<string, string | string[] | undefined>): string | null {
  const raw = searchParams.confirm;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && ISO_DATE_PATTERN.test(value) ? value : null;
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AttendanceHolidayCalendarPage({ searchParams }: Props) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/holiday-calendar");
  if (!await canAccessAttendanceSetup(access, "read")) {
    redirect("/employee-portals");
  }
  const canEdit = await canAccessAttendanceSetup(access, "update");

  const resolvedSearchParams = await searchParams;
  const focusDate = focusDateFromSearchParams(resolvedSearchParams);
  // A confirmation CTA can point at a holiday from a different year than "now"
  // (e.g. an email sent in late December about an early-January holiday) — load
  // the year the focused holiday actually falls in so the CTA always lands on
  // the right page instead of an empty/wrong year.
  const year = focusDate ? Number(focusDate.slice(0, 4)) : new Date().getUTCFullYear();
  let initialView: Awaited<ReturnType<typeof buildHolidayCalendarYearView>> | null = null;
  let initialError: string | null = null;
  try {
    initialView = await buildHolidayCalendarYearView(year);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Holiday calendar failed to load.";
  }

  return (
    <HolidayCalendarManager
      canEdit={canEdit}
      focusDate={focusDate}
      initialError={initialError}
      initialView={initialView}
      initialYear={year}
    />
  );
}
