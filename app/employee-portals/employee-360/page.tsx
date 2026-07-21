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
import { resolvePeriod, type Employee360Comparison } from "@/lib/employee-360/period";
import { getEmployee360Summary } from "@/lib/employee-360/service";
import { resolveEmployee360RoleCategory } from "@/lib/employee-360/roles";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
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
      {children}
    </EmployeePortalPageShell>
  );
}

export default async function EmployeePortalEmployee360Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  const sp = await searchParams;
  const period = resolvePeriod(sp);

  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const target = rows.find((row) => hrIdsMatch(row.hrId, access.hrId));

  if (!target) {
    return (
      <Shell description="Your field performance, team roll-up, and coaching impact." title="Employee 360">
        <EmployeePortalEmptyState
          message="We could not find your employee record. Please contact HR if this continues."
          title="Profile unavailable"
        />
      </Shell>
    );
  }

  // Self-view is always in scope (everyone may open their own record), but the
  // shared 360 gate stays the single source of truth rather than assuming it inline.
  if (!canViewEmployee360Subject(access, target, await buildEmployee360Scope(rows, access))) {
    redirect("/employee-portals");
  }

  // Employee 360 covers only the six field-force role families. Anyone else (HR,
  // Finance, admin, office…) gets a clear out-of-scope state, matching the admin report.
  const roleCategory = resolveEmployee360RoleCategory(target.jobTitle ?? target.positionTitle);
  if (!roleCategory) {
    return (
      <Shell description="Your field performance, team roll-up, and coaching impact." title="Employee 360">
        <EmployeePortalEmptyState
          message={`${target.jobTitle || "Your role"} isn't covered by Employee 360. The report is scoped to the field force — Medical Reps, District / Regional / National Sales Managers, Product & Group Product Managers, and Training Managers.`}
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
  };

  // Expense analysis is a MANAGER view (DM / RM / NSM / TM / PM / GPM) — an explicit
  // allowlist, not "anyone who isn't a Medical Rep".
  const showExpenses = isExpenseAnalysisRole(target.jobTitle ?? target.positionTitle);

  const nameByHrId = new Map<string, string>(
    rows.map((row) => [row.hrId.trim().toLowerCase(), row.displayName || row.fullName]),
  );

  // Team roll-up: subject + ALL descendants in the org tree, same as the admin report —
  // a manager's own scope includes their team's sales/coaching/expenses.
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
      getEmployee360Profile(target.hrId, nameByHrId, period.current, teamHrIds, showExpenses, access.role, roleCategory),
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
          message="Unable to load your Employee 360 report right now. Please refresh, or contact HR if the problem continues."
          title="Employee 360 unavailable"
        />
      </Shell>
    );
  }

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
        teamHrIds,
        employees: rows,
        window: { from: period.current.from, to: period.current.to },
      });
    } catch {
      teamLifecycle = null;
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
    }
  }

  // PM / Group PM: ROI on the marketing requests they submitted.
  let pmMarketing: PmMarketingSummary | null = null;
  if (roleCategory === "product-manager") {
    try {
      pmMarketing = await getPmMarketingRoi(target.hrId, access, new Date().toISOString());
    } catch {
      pmMarketing = null;
    }
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
    <Shell description="Your field performance, team roll-up, and coaching impact." title="Employee 360">
      <div className="space-y-4">
        <PeriodFilter
          activeKey={period.key}
          basePath={PORTAL_BASE_PATH}
          from={period.current.from}
          hrId={subject.hrId}
          to={period.current.to}
        />
        <Employee360View
          category={roleCategory}
          comparison={comparison}
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
