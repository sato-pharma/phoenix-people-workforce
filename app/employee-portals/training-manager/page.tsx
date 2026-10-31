import { CalendarDays, CalendarX2, CheckCircle2, ClipboardCheck, ListChecks, Receipt } from "lucide-react";
import { redirect } from "next/navigation";

import { CoachingQualityRadarCard } from "@/components/coaching/coaching-quality-radar-card";
import { CoachingScoreTrendCard } from "@/components/coaching/coaching-score-trend-card";
import { CoachingStarsOfMonthCard } from "@/components/coaching/coaching-stars-of-month-card";
import { LineTopAchieversCard } from "@/components/employee-portal/line-top-achievers-card";
import {
  GlanceStrip,
  PendingActions,
  PortalIdentityBand,
  QuickActions,
} from "@/components/employee-portal/portal-command-center";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { hasDepartedEmployment } from "@/lib/auth/session-lifecycle";
import { getCoachingReports } from "@/lib/coaching/service";
import {
  buildCoachingQualityRadar,
  buildMonthlyCoachingScoreTrend,
  buildTopCoachingScores,
} from "@/lib/coaching/landing-insights";
import { getCompanyLineTopAchievers } from "@/lib/employee-portal/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { getEmployeePhotoMap, resolveEmployeePhotoSrc } from "@/lib/employees/employee-photo";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { getPortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

export default async function TrainingManagerOverviewPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role !== "Training Manager") {
    redirect("/employee-portals");
  }

  // Cairo's year and month, NOT the server's. Railway production sets no TZ, so `getFullYear()`
  // and `getMonth()` here returned UTC's — and between 00:00 and 03:00 Cairo on the 1st of a month
  // UTC is still on the 31st. This page's whole leaderboard hangs off the pair: opening it just
  // after midnight on the 1st showed the "previous month" board still on the month before last,
  // and the coaching report year would roll over three hours late every New Year's Day.
  const now = new Date();
  const { year: currentYear, month: currentMonth } = currentCairoDateParts(now);
  // Previous calendar month, normalized across year boundaries (January → last
  // December) so the "top scores" leaderboard rolls to last month automatically
  // on the 1st of each month.
  const previousMonthAnchor = new Date(currentYear, currentMonth - 2, 1);
  const previousMonth = previousMonthAnchor.getMonth() + 1;
  const previousMonthYear = previousMonthAnchor.getFullYear();
  const previousMonthLabel = previousMonthAnchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const [snapshotResult, coachingResult, previousMonthResult, topAchieversResult] =
    await Promise.allSettled([
      getPortalHomeSnapshot(access),
      access.hrId
        ? getCoachingReports({ year: currentYear }, access)
        : Promise.resolve([]),
      access.hrId
        ? getCoachingReports({ year: previousMonthYear, month: previousMonth }, access)
        : Promise.resolve([]),
      getCompanyLineTopAchievers(access, { perLine: 3 }),
    ]);

  if (snapshotResult.status === "rejected") {
    logPortalFailure(
      { route: "/employee-portals/training-manager", module: "home-snapshot", role: access.role, hrId: access.hrId },
      snapshotResult.reason,
    );
    return (
      <EmployeePortalEmptyState
        message="Your command center is temporarily unavailable. Please try again in a moment."
        title="Portal Unavailable"
      />
    );
  }

  const snapshot = snapshotResult.value;
  const coachingReports = coachingResult.status === "fulfilled" ? coachingResult.value : [];
  const previousMonthReports = previousMonthResult.status === "fulfilled" ? previousMonthResult.value : [];
  const lineTopAchievers = topAchieversResult.status === "fulfilled" ? topAchieversResult.value : [];

  const { shell, pendingVacationCount, pendingExcuseCount, leaveEntitlementDays } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  const reportsThisMonth = coachingReports.filter((r) => r.coachingMonth === currentMonth).length;
  const scoreTrend = buildMonthlyCoachingScoreTrend(coachingReports);
  const qualityRadar = buildCoachingQualityRadar(coachingReports);
  // Stars of the month: the previous month's top 3 coaching-report scores, shown
  // with the reps' photos (uploaded photo → bundled static → initials fallback).
  // A rep who has since resigned is skipped and the next score fills the slot (owner, 2026-10-24),
  // so the directory is read WITH inactive rows — the default read drops exactly those people.
  const [photoMap, fullDirectory] = await Promise.all([
    getEmployeePhotoMap(),
    getEmployeeDirectoryRows({ includeInactive: true }).catch(() => []),
  ]);
  const departedHrIds = new Set(
    fullDirectory
      .filter((employee) => hasDepartedEmployment(employee.employmentStatus))
      .map((employee) => employee.hrId.toUpperCase()),
  );
  const topScoresLastMonth = buildTopCoachingScores(previousMonthReports, 3, departedHrIds);
  const starsOfMonth = topScoresLastMonth.map((entry) => ({
    hrId: entry.medicalRepHrId,
    name: entry.medicalRepName,
    photoSrc: resolveEmployeePhotoSrc(entry.medicalRepHrId, photoMap),
    scorePercent: entry.finalScorePercent,
    zone: entry.performanceZone,
  }));

  return (
    <div className="mx-auto w-full space-y-4" dir="auto">
      {/* planAdherence={null} and myInterviews={[]}: this is the Training Manager MODULE page, not a
          landing surface. The plan score and the "My interviews" card belong on /employee-portals,
          which is StandardCommandCenter for this role and already carries them. */}
      <PortalIdentityBand shell={shell} planAdherence={null} myInterviews={[]} />

      <GlanceStrip
        items={[
          {
            icon: ClipboardCheck,
            value: String(reportsThisMonth),
            label: reportsThisMonth === 1 ? "report this month" : "reports this month",
            href: "/employee-portals/training-manager/field-coaching",
          },
          {
            icon: CalendarX2,
            value: String(totalPending),
            label: totalPending === 1 ? "pending request" : "pending requests",
            href: "/employee-portals/approvals-hub",
            urgent: totalPending > 0,
          },
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "Not set",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
        ]}
      />

      <QuickActions
        actions={[
          { href: "/employee-portals/coaching-skills-survey", icon: ListChecks, label: "Skills Survey" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Submit Vacation" },
          { href: "/employee-portals/excuses", icon: CalendarX2, label: "Submit Excuse" },
          { href: "/employee-portals/submit-expense", icon: Receipt, label: "Submit Expense" },
        ]}
      />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      {/* Coaching performance insights — mirror the coaching analytics widgets, above the DV trend */}
      <CoachingScoreTrendCard data={scoreTrend} />
      <CoachingQualityRadarCard data={qualityRadar} />
      <CoachingStarsOfMonthCard stars={starsOfMonth} monthLabel={previousMonthLabel} />

      {/* Sales: top 3 medical-rep achievers in each line (snapshot of Medical Reps Performance) */}
      <LineTopAchieversCard groups={lineTopAchievers} />

      <DoubleVisitFocusSection focus={snapshot.dvFocus} />

      {totalPending === 0 && (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}
