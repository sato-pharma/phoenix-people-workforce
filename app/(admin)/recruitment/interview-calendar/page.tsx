import { CalendarDays, LockKeyhole } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { PageContainer } from "@/components/layout/page-container";
import { InterviewCalendarView } from "@/components/recruitment/interview-calendar/interview-calendar-view";
import { RecruitmentEmptyState, RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { interviewCalendarAbilities, mayRequestInterviews, resolveInterviewCalendarRole } from "@/lib/recruitment/interview-calendar";
import { readsInterviewRequestInbox } from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, isDateKey, upcomingWeekStart } from "@/lib/recruitment/interview-calendar-week";
import { isZoomConfigured } from "@/lib/zoom/meetings";

export const dynamic = "force-dynamic";

// Interview Calendar — the week-by-week schedule of interviews the owner asked for on 2026-09-18,
// modelled on his own "DAILY SCHEDULE" sheet: a column per day, every day of the week since 7 Nov 2026, a row per half
// hour from 9:00 AM to 5:00 PM, every name opening that candidate's CV, exportable as PDF or Excel
// with the names still linked, and shared from here with Viewer, Commenter or Editor access.
//
// NOT gated on a recruitment permission, on purpose. The calendar belongs to its owner and is seen
// by exactly the people he shares it with; a shared viewer may hold no recruitment grant at all. So
// the gate is the calendar's own (resolveInterviewCalendarRole), which every API route behind this
// page enforces again. A portal-shell viewer is forwarded to the portal twin with the week and the
// open interview intact.
function preservedQuery(params: Record<string, string | string[] | undefined>) {
  const query = new URLSearchParams();
  for (const key of ["week", "open"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) query.set(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export default async function InterviewCalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  const params = await searchParams;
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/interview-calendar${preservedQuery(params)}`);
  }

  const role = await resolveInterviewCalendarRole(access).catch(() => null);
  const now = new Date();
  const week = typeof params.week === "string" && isDateKey(params.week) ? params.week : upcomingWeekStart(now);
  const open = typeof params.open === "string" && isUuid(params.open) ? params.open : null;
  const zoomConnected = isZoomConfigured();

  return (
    <PageContainer>
      <RecruitmentPageHeader
        badges={
          role ? (
            <>
              <AdminInsightChip tone="orange">Every day · Cairo time</AdminInsightChip>
              <AdminInsightChip tone={zoomConnected ? "emerald" : "slate"}>{zoomConnected ? "Zoom connected" : "Zoom not connected"}</AdminInsightChip>
            </>
          ) : null
        }
        description="Every interview booked from a CV, a week at a time. Click a name to open the CV; export the week as PDF or Excel."
        icon={<CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />}
        title="Interview Calendar"
      />
      {role ? (
        <InterviewCalendarView
          abilities={await interviewCalendarAbilities(access)}
          canReadRequests={readsInterviewRequestInbox(access)}
          canRequest={await mayRequestInterviews(access)}
          initialOpen={open}
          initialWeek={week}
          role={role}
          todayKey={cairoDateKey(now)}
          zoomConnected={zoomConnected}
        />
      ) : (
        <div className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
          <RecruitmentEmptyState
            icon={<LockKeyhole aria-hidden="true" className="h-5 w-5" />}
            message="The interview calendar has not been shared with you. Only its owner can share it."
            title="Not shared with you"
          />
        </div>
      )}
    </PageContainer>
  );
}
