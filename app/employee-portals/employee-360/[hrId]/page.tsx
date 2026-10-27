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
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

const PORTAL_BASE_PATH = "/employee-portals/employee-360";

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

  // A section whose read fails says so on the page; it never silently disappears.
  const unreadSections: string[] = [];

  // Team Health — coaching coverage of a field manager's own reps (DM/RM/NSM).
  let teamHealth: TeamHealthSummary | null = null;
  if (
    roleCategory === "district-manager" ||
    roleCategory === "regional-manager" ||
    roleCategory === "national-sales-manager"
  ) {
    try {
      teamHealth = await getEmployee360TeamHealth({
        teamHrIds,
        employees: rows,
        window: { from: period.current.from, to: period.current.to },
        dvRepHrIds: (summary.leadership?.byRep ?? []).filter((r) => r.doubleVisits > 0).map((r) => r.hrId),
      });
    } catch {
      teamHealth = null;
      unreadSections.push("Team Development");
    }
  }

  // Team Compliance — weekly plans, field discipline & probation of the manager's reps.
  let teamLifecycle: TeamLifecycleSummary | null = null;
  if (
    roleCategory === "district-manager" ||
    roleCategory === "regional-manager" ||
    roleCategory === "national-sales-manager"
  ) {
    try {
      teamLifecycle = await getEmployee360TeamLifecycle({
        subjectHrId: target.hrId,
        teamHrIds,
        employees: rows,
        window: { from: period.current.from, to: period.current.to },
      });
    } catch {
      teamLifecycle = null;
      unreadSections.push("Team Compliance");
    }
  }

  // Training Manager god-mode analytics — coverage/neglect/concentration + verdict.
  let tmAnalytics: TrainingManagerAnalytics | null = null;
  if (roleCategory === "training-manager") {
    try {
      tmAnalytics = await getTrainingManagerAnalytics({
        tmHrId: target.hrId,
        employees: rows,
        window: { from: period.current.from, to: period.current.to },
      });
    } catch {
      tmAnalytics = null;
      unreadSections.push("Training-Manager Effectiveness");
    }
  }

  // PM / Group PM: ROI on the marketing requests they submitted.
  let pmMarketing: PmMarketingSummary | null = null;
  if (roleCategory === "product-manager") {
    try {
      pmMarketing = await getPmMarketingRoi(target.hrId, access, new Date().toISOString());
    } catch {
      pmMarketing = null;
      unreadSections.push("Marketing ROI");
    }
  }

  // Phoenix CRM: plan compliance and visit frequency by grade, read in the subject's own scope.
  let crmInsights: Employee360CrmInsights | null = null;
  try {
    crmInsights = await loadEmployee360CrmInsights({
      viewerAccess: access,
      subjectHrId: target.hrId,
      category: roleCategory,
      from: period.current.from,
      to: period.current.to,
    });
  } catch {
    crmInsights = unreadCrmInsights(roleCategory);
  }

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
