import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { InterviewCalendarView } from "@/components/recruitment/interview-calendar/interview-calendar-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { interviewCalendarAbilities, mayRequestInterviews, resolveInterviewCalendarRole } from "@/lib/recruitment/interview-calendar";
import { readsInterviewRequestInbox } from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, isDateKey, upcomingWeekStart } from "@/lib/recruitment/interview-calendar-week";
import { isZoomConfigured } from "@/lib/zoom/meetings";

export const dynamic = "force-dynamic";

// Portal mirror of app/(admin)/recruitment/interview-calendar/page.tsx. The calendar's owner shares
// it with whoever he chooses, and most of the people a hiring panel is made of — District and
// Regional Managers, National Sales Managers — work out of the employee portal. The portal sidebar
// shows the row only to someone the calendar is shared with (showInterviewCalendarTab); anyone
// else who follows a link here gets the plain "not shared" answer, never the calendar.
function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["week", "open"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export default async function EmployeePortalInterviewCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  // Admin-shell viewers (the owner among them) belong on the admin twin.
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`/recruitment/interview-calendar${preservedQuery(params)}`);
  }

  // STARTED TOGETHER (1 Nov 2026, the speed root cause): the three answers about this viewer are
  // independent, so the two the calendar needs start beside the role instead of after it. A viewer
  // the calendar is not shared with still gets the plain "not shared" answer below and never awaits
  // them; the guards keep their rejections, if any, from surfacing unhandled.
  const abilitiesLoad = interviewCalendarAbilities(access);
  const canRequestLoad = mayRequestInterviews(access);
  abilitiesLoad.catch(() => {});
  canRequestLoad.catch(() => {});
  const role = await resolveInterviewCalendarRole(access).catch(() => null);
  if (!role) {
    return (
      <EmployeePortalEmptyState
        message="The interview calendar has not been shared with you. Only its owner can share it."
        title="Calendar Unavailable"
      />
    );
  }

  const [abilities, canRequest] = await Promise.all([abilitiesLoad, canRequestLoad]);
  const now = new Date();
  const week = typeof params.week === "string" && isDateKey(params.week) ? params.week : upcomingWeekStart(now);
  const open = typeof params.open === "string" && isUuid(params.open) ? params.open : null;

  return (
    <EmployeePortalPageShell
      badge="Hiring"
      description="Every interview on the calendar, a week at a time. Click a name to open the CV; export the week as PDF or Excel."
      errorBoundaryTitle="Interview calendar unavailable"
      title="Interview Calendar"
    >
      <InterviewCalendarView
        abilities={abilities}
        canReadRequests={readsInterviewRequestInbox(access)}
        canRequest={canRequest}
        initialOpen={open}
        initialWeek={week}
        role={role}
        todayKey={cairoDateKey(now)}
        zoomConnected={isZoomConfigured()}
      />
    </EmployeePortalPageShell>
  );
}
