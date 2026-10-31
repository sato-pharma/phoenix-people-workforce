import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";

import { Employee360View, type Employee360Subject } from "@/components/employee-360/employee-360-view";
import { PeriodFilter } from "@/components/employee-360/period-filter";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { buildEmployee360Scope, canViewEmployee360Subject } from "@/lib/employee-360/access";
import { getEmployee360Profile } from "@/lib/employee-360/deep-service";
import { getEmployee360TeamHealth, type TeamHealthSummary } from "@/lib/employee-360/team-health";
import { getEmployee360TeamLifecycle, type TeamLifecycleSummary } from "@/lib/employee-360/team-lifecycle";
import { getTrainingManagerAnalytics, type TrainingManagerAnalytics } from "@/lib/employee-360/tm-analytics";
import { getPmMarketingRoi, type PmMarketingSummary } from "@/lib/employee-360/pm-marketing";
import { loadEmployee360CrmInsights, unreadCrmInsights, type Employee360CrmInsights } from "@/lib/employee-360/crm-insights";
import { resolvePeriod, type Employee360Comparison } from "@/lib/employee-360/period";
import { getEmployee360Summary } from "@/lib/employee-360/service";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { employeeExitDay, getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { isExpenseAnalysisRole } from "@/lib/employees/job-function";
import { bridgeEmployeeLineToOfficial } from "@/lib/sales/access-scope";
import { hrIdsMatch } from "@/lib/hr-id";
import { isSkillsSurveyMember, isSkillsSurveySubject } from "@/lib/coaching/skills-survey/access";
import { getSkillsSurveyHistoryForMember } from "@/lib/coaching/skills-survey/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

const PORTAL_BASE_PATH = "/employee-portals/employee-360";

type SectionResult<T> = { ok: true; value: T } | { ok: false };

// Starts one section's read and turns its failure into a value at once, so a read still in flight when
// the profile fails (and the page returns early) is never an unhandled rejection.
function startSection<T>(read: () => Promise<T>): Promise<SectionResult<T>> {
  return Promise.resolve()
    .then(read)
    .then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
}

function sectionValue<T>(result: SectionResult<T> | null): T | null {
  return result?.ok ? result.value : null;
}

function Shell({
  children,
  description,
  title,
}: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <EmployeePortalPageShell badge="Employee 360" description={description} title={title}>
      <Link
        href={PORTAL_BASE_PATH}
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition hover:text-orange-600"
      >
        <ArrowLeft className="h-4 w-4" />
        All employees
      </Link>
      {children}
    </EmployeePortalPageShell>
  );
}

export default async function EmployeePortalEmployee360DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hrId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  const { hrId } = await params;
  const sp = await searchParams;
  const period = resolvePeriod(sp);

  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const target = rows.find((row) => hrIdsMatch(row.hrId, hrId));

  if (!target) {
    return (
      <Shell description="Employee 360" title="Employee 360">
        <EmployeePortalEmptyState message="No employee record matches this link." title="Employee not found" />
      </Shell>
    );
  }

  // Same 360-specific scope gate as the index page (self / team / hierarchy /
  // line / reps / company) — a viewer who can't open this subject is bounced back
  // to the browse list rather than seeing a half-built report.
  if (!canViewEmployee360Subject(access, target, await buildEmployee360Scope(rows, access))) {
    redirect(PORTAL_BASE_PATH);
  }

  // Employee 360 covers only the six field-force role families. A person outside
  // that scope has no tailored report — show a clear out-of-scope state.
  const roleCategory = resolveEmployee360RoleCategory(target.jobTitle ?? target.positionTitle);
  if (!roleCategory) {
    return (
      <Shell description={target.displayName || target.fullName} title="Employee 360">
        <EmployeePortalEmptyState
          message={`${target.jobTitle || "This role"} isn't covered by Employee 360. The report is scoped to the field force — Medical Reps, District / Regional / National Sales Managers, Product & Group Product Managers, and Training Managers.`}
          title="Not covered by Employee 360"
        />
      </Shell>
    );
  }

  const subject: Employee360Subject = {
    hrId: target.hrId,
    displayName: target.displayName || target.fullName,
    jobTitle: target.jobTitle,
    // Canonical line spelling — collapses the duplicate "Anti Inf" / "Anti infective" master rows.
    lineName: bridgeEmployeeLineToOfficial(target.lineName),
    areaName: target.areaName,
    regionName: target.regionName,
    managerName: target.managerName,
    employmentStatus: target.employmentStatus,
    hireDate: target.hireDate,
    // Tenure stops on the day they left, never keeps counting on a closed record.
    leftOn: isActiveLifecycleStatus(target.employmentStatus) ? null : employeeExitDay(target),
  };

  // Expense analysis is a MANAGER view (DM / RM / NSM / TM / PM / GPM) — an explicit
  // allowlist, not "anyone who isn't a Medical Rep".
  const showExpenses = isExpenseAnalysisRole(target.jobTitle ?? target.positionTitle);

  const nameByHrId = new Map<string, string>(
    rows.map((row) => [row.hrId.trim().toLowerCase(), row.displayName || row.fullName]),
  );

  // Team roll-up: subject + ALL descendants in the org tree, same as the admin report.
  const childrenByManager = new Map<string, string[]>();
  for (const row of rows) {
    const mgr = row.managerHrId ? row.managerHrId.trim().toLowerCase() : null;
    if (!mgr) continue;
    const list = childrenByManager.get(mgr) ?? [];
    list.push(row.hrId);
    childrenByManager.set(mgr, list);
  }
  const teamHrIds: string[] = [target.hrId];
  const seenTeam = new Set<string>([target.hrId.trim().toLowerCase()]);
  const queue = [target.hrId.trim().toLowerCase()];
  while (queue.length && teamHrIds.length < 1000) {
    const current = queue.shift() as string;
    for (const child of childrenByManager.get(current) ?? []) {
      const key = child.trim().toLowerCase();
      if (seenTeam.has(key)) continue;
      seenTeam.add(key);
      teamHrIds.push(child);
      queue.push(key);
    }
  }

  const periodWindow = { from: period.current.from, to: period.current.to };
  const isFieldManager =
    roleCategory === "district-manager" ||
    roleCategory === "regional-manager" ||
    roleCategory === "national-sales-manager";

  // The sections that do not read the profile start WITH it, not in line after it: a manager's open
  // used to pay profile + team health + team compliance + CRM insights one after another. Same reads,
  // same arguments, same fallbacks — only the start time moved. Team Health still waits, because it
  // reads the profile's double visits.
  const teamLifecycleRead = isFieldManager
    ? startSection(() => getEmployee360TeamLifecycle({ subjectHrId: target.hrId, teamHrIds, employees: rows, window: periodWindow }))
    : null;
  const tmAnalyticsRead =
    roleCategory === "training-manager"
      ? startSection(() => getTrainingManagerAnalytics({ tmHrId: target.hrId, employees: rows, window: periodWindow }))
      : null;
  const pmMarketingRead =
    roleCategory === "product-manager"
      ? startSection(() => getPmMarketingRoi(target.hrId, access, new Date().toISOString()))
      : null;
  // The Team Coaching Skills Survey (owner, 2026-10-31) — managers only. Never read when the viewer is
  // the person rated, and the service refuses that case again on its own.
  const skillsSurveyRead =
    isSkillsSurveyMember(target) && !isSkillsSurveySubject(access, target.hrId)
      ? startSection(() => getSkillsSurveyHistoryForMember(access, target.hrId))
      : null;
  // Phoenix CRM: plan compliance and visit frequency by grade, read in the subject's own scope.
  const crmInsightsRead = startSection(() =>
    loadEmployee360CrmInsights({
      viewerAccess: access,
      subjectHrId: target.hrId,
      category: roleCategory,
      from: period.current.from,
      to: period.current.to,
    }),
  );

  let summary: Awaited<ReturnType<typeof getEmployee360Profile>> | null = null;
  let previous: Awaited<ReturnType<typeof getEmployee360Summary>> | null = null;
  try {
    const [cur, prev] = await Promise.all([
      getEmployee360Profile(target.hrId, nameByHrId, period.current, teamHrIds, showExpenses, access.role, roleCategory, access.hrId),
      getEmployee360Summary(target.hrId, period.previous),
    ]);
    summary = cur;
    previous = prev;
  } catch (loadError) {
    logPortalFailure(
      { route: PORTAL_BASE_PATH, module: "employee-360", role: access.role, hrId: access.hrId },
      loadError,
    );
  }

  if (!summary) {
    return (
      <Shell description={subject.displayName} title="Employee 360">
        <EmployeePortalEmptyState
          message="Unable to load this Employee 360 report right now. Please refresh, or contact HR if the problem continues."
          title="Employee 360 unavailable"
        />
      </Shell>
    );
  }

  const profile = summary;
  // Team Health — coaching coverage of a field manager's own reps (DM/RM/NSM). The only section that
  // needs the profile, so it starts now and runs beside the reads already in flight.
  const [teamHealthResult, teamLifecycleResult, tmAnalyticsResult, pmMarketingResult, crmInsightsResult, skillsSurveyResult] =
    await Promise.all([
      isFieldManager
        ? startSection(() =>
            getEmployee360TeamHealth({
              teamHrIds,
              employees: rows,
              window: periodWindow,
              dvRepHrIds: (profile.leadership?.byRep ?? []).filter((r) => r.doubleVisits > 0).map((r) => r.hrId),
            }),
          )
        : null,
      // Team Compliance — weekly plans, field discipline & probation of the manager's reps.
      teamLifecycleRead,
      // Training Manager god-mode analytics — coverage/neglect/concentration + verdict.
      tmAnalyticsRead,
      // PM / Group PM: ROI on the marketing requests they submitted.
      pmMarketingRead,
      crmInsightsRead,
      skillsSurveyRead,
    ]);

  // A section whose read fails says so on the page; it never silently disappears. Same order as before.
  const unreadSections: string[] = [];
  if (teamHealthResult && !teamHealthResult.ok) unreadSections.push("Team Development");
  if (teamLifecycleResult && !teamLifecycleResult.ok) unreadSections.push("Team Compliance");
  if (tmAnalyticsResult && !tmAnalyticsResult.ok) unreadSections.push("Training-Manager Effectiveness");
  if (pmMarketingResult && !pmMarketingResult.ok) unreadSections.push("Marketing ROI");
  if (skillsSurveyResult && !skillsSurveyResult.ok) unreadSections.push("Team Coaching Skills Survey");
  const skillsSurveyHistory = sectionValue(skillsSurveyResult);
  const teamHealth: TeamHealthSummary | null = sectionValue(teamHealthResult);
  const teamLifecycle: TeamLifecycleSummary | null = sectionValue(teamLifecycleResult);
  const tmAnalytics: TrainingManagerAnalytics | null = sectionValue(tmAnalyticsResult);
  const pmMarketing: PmMarketingSummary | null = sectionValue(pmMarketingResult);
  const crmInsights: Employee360CrmInsights = crmInsightsResult.ok
    ? crmInsightsResult.value
    : unreadCrmInsights(roleCategory);

  const comparison: Employee360Comparison | null = previous
    ? {
        previousLabel: period.previous.label,
        productiveVisits: { cur: summary.productiveVisits, prev: previous.productiveVisits },
        visitsPerActiveDay: { cur: summary.visitsPerActiveDay, prev: previous.visitsPerActiveDay },
        distinctCustomers: { cur: summary.distinctCustomers, prev: previous.distinctCustomers },
        campaignShare: { cur: summary.campaignShare, prev: previous.campaignShare },
        checkinCoverage: { cur: summary.checkinCoverage, prev: previous.checkinCoverage },
        checkinCount: { cur: summary.checkinCount, prev: previous.checkinCount },
      }
    : null;

  return (
    <Shell description={subject.displayName} title="Employee 360">
      <div className="space-y-4">
        <PeriodFilter
          activeKey={period.key}
          basePath={`${PORTAL_BASE_PATH}/${encodeURIComponent(target.hrId)}`}
          from={period.current.from}
          hrId={subject.hrId}
          to={period.current.to}
        />
        <Employee360View
          bare
          // The shell above renders the page <h1>; this makes the subject name an <h2>.
          chrome="portal"
          category={roleCategory}
          comparison={comparison}
          crmInsights={crmInsights}
          skillsSurvey={
            skillsSurveyHistory
              ? {
                  history: skillsSurveyHistory,
                  memberHref: `/employee-portals/coaching-skills-survey/${encodeURIComponent(target.hrId)}`,
                }
              : null
          }
          unreadSections={unreadSections}
          pmMarketing={pmMarketing}
          showExpenses={showExpenses}
          subject={subject}
          summary={summary}
          teamHealth={teamHealth}
          teamLifecycle={teamLifecycle}
          tmAnalytics={tmAnalytics}
        />
      </div>
    </Shell>
  );
}
