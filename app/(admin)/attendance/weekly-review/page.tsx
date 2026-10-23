import { redirect } from "next/navigation";

import { WeeklyAttendanceReview } from "@/components/attendance/weekly-attendance-review";
import { canManageWeeklyReview, canReviewDisputes, getDigestSettings, listReviewWeeks, loadReviewWeek } from "@/lib/attendance/digest-service.ts";
import { pickDefaultReviewWeek } from "@/lib/attendance/digest-rules.ts";
import { canAccess } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function WeeklyAttendanceReviewPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/attendance/weekly-review");
  if (!(await canAccess(access, "attendance", "read"))) {
    redirect("/employee-portals");
  }

  // Fail CLOSED: this page lists every employee's flagged days and amounts, and its Release
  // button is what notifies them. A lookup that throws means "not verifiably a reviewer".
  const authorized = await canReviewDisputes(access).catch(() => false);
  if (!authorized) {
    redirect("/employee-portals");
  }

  let initialWeeks: Awaited<ReturnType<typeof listReviewWeeks>> = [];
  let initialWeek: Awaited<ReturnType<typeof loadReviewWeek>> = null;
  let initialError: string | null = null;
  let answerWorkingDays = 2;
  try {
    const [weeks, settings] = await Promise.all([listReviewWeeks(), getDigestSettings()]);
    initialWeeks = weeks;
    answerWorkingDays = settings.answerWorkingDays;
    const chosen = pickDefaultReviewWeek(weeks);
    initialWeek = chosen ? await loadReviewWeek(chosen) : null;
  } catch (error) {
    // Say it failed rather than showing an empty page, which reads as "nothing to release".
    initialError = error instanceof Error ? error.message : "The weekly attendance review failed to load.";
  }

  return (
    <WeeklyAttendanceReview
      answerWorkingDays={answerWorkingDays}
      canManage={canManageWeeklyReview(access)}
      initialError={initialError}
      initialWeek={initialWeek}
      initialWeeks={initialWeeks}
    />
  );
}
