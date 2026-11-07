import { CalendarDays, Link2Off } from "lucide-react";
import type { Metadata } from "next";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { InterviewCalendarView } from "@/components/recruitment/interview-calendar/interview-calendar-view";
import { RecruitmentEmptyState, RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isUuid } from "@/lib/http/uuid";
import { interviewCalendarAbilities } from "@/lib/recruitment/interview-calendar";
import { openInterviewCalendarLink } from "@/lib/recruitment/interview-calendar-links";
import { interviewCalendarLinkPath } from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, isDateKey, upcomingWeekStart, weekStartFor } from "@/lib/recruitment/interview-calendar-week";
import { isZoomConfigured } from "@/lib/zoom/meetings";

export const dynamic = "force-dynamic";

// A copy link must never be indexed: a crawled copy would outlive the owner's off switch and his
// delete, which are the only controls a link with no password has.
export const metadata: Metadata = {
  robots: { follow: false, index: false, nocache: true },
  title: "Interview Calendar — Phoenix",
};

/**
 * The interview calendar opened from a COPY LINK (the owner, 2026-09-18: "exactly as Google Sheets").
 *
 * Deliberately OUTSIDE both shells and outside any session check: the holder may have no Phoenix
 * account. The token is the credential, checked here and again by every API route the screen calls.
 * Without signing in the link VIEWS (his choice); signed in, it gives the level he set on it. A link
 * limited to one week opens that week only, and the week cannot be changed.
 */
export default async function SharedInterviewCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const access = await resolveAccessContextFromPage();
  const opened = await openInterviewCalendarLink(token, access).catch(() => null);

  if (!opened) {
    return (
      <main className="min-h-screen bg-[#F3F6FA] px-4 py-6 sm:px-6 sm:py-10">
        <div className="mx-auto max-w-xl">
          <RecruitmentPageHeader
            description="Sato Pharma recruitment."
            icon={<CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />}
            title="Interview Calendar"
          />
          <div className={`border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
            <RecruitmentEmptyState
              icon={<Link2Off aria-hidden="true" className="h-5 w-5" />}
              message="It was switched off or deleted by the person who shared it. Ask them for a new link."
              title="This link does not open anything"
            />
          </div>
        </div>
      </main>
    );
  }

  const now = new Date();
  // Someone who holds the calendar in their own right may move between weeks; a week-limited link
  // alone may not.
  const lockedWeek = opened.grant.weekStart && !opened.own ? opened.grant.weekStart : null;
  const asked = typeof query.week === "string" && isDateKey(query.week) ? weekStartFor(query.week) : null;
  const week = lockedWeek ?? asked ?? opened.grant.weekStart ?? upcomingWeekStart(now);
  const open = typeof query.open === "string" && isUuid(query.open) ? query.open : null;
  const abilities = await interviewCalendarAbilities(access);

  return (
    <main className="min-h-screen bg-[#F3F6FA] px-4 py-6 sm:px-6 sm:py-8">
      <div className="mx-auto max-w-7xl">
        <RecruitmentPageHeader
          badges={
            <>
              <AdminInsightChip tone="orange">Every day · Cairo time</AdminInsightChip>
              {lockedWeek ? <AdminInsightChip tone="slate">This link opens one week</AdminInsightChip> : null}
            </>
          }
          description="Sato Pharma recruitment. Click a name to open the CV."
          icon={<CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />}
          title="Interview Calendar"
        />
        <InterviewCalendarView
          abilities={abilities}
          initialOpen={open}
          initialWeek={week}
          link={{
            accessLevel: opened.grant.accessLevel,
            guestCvs: opened.grant.guestCvs,
            signInHref: opened.signedIn ? null : `/login?returnUrl=${encodeURIComponent(interviewCalendarLinkPath(token))}`,
            signedIn: opened.signedIn,
            token,
            weekStart: opened.grant.weekStart,
          }}
          lockedWeek={lockedWeek}
          role={opened.role}
          todayKey={cairoDateKey(now)}
          zoomConnected={isZoomConfigured()}
        />
      </div>
    </main>
  );
}
