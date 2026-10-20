import { redirect } from "next/navigation";

import { Employee360View, type Employee360Subject } from "@/components/employee-360/employee-360-view";
import { PeriodFilter } from "@/components/employee-360/period-filter";
import {
  EmployeeSearchList,
  type Employee360ListItem,
} from "@/components/employee-360/employee-search-list";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { assertPermission, resolveNavigationMode, type AccessContext } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import {
  buildEmployee360Scope,
  canViewEmployee360Subject,
  isCompany360Viewer,
  resolveEmployee360VisibleRows,
} from "@/lib/employee-360/access";
import { getEmployee360Profile } from "@/lib/employee-360/deep-service";
import { buildEmployee360ListItems } from "@/lib/employee-360/list-items";
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

/**
 * The "Select Employee" picker: every role sees THEMSELVES plus everyone in their own reporting
 * subtree, so a manager can open any of their people's 360 report. A Regional Manager gets their
 * District Managers AND the Medical Reps under those DSMs; a District Manager gets their reps.
 *
 * The viewer is included when they are a viewable subject (EmployeeSearchList groups by role family
 * into tabs, so they appear as a selectable option on their own family's tab beside the Medical Reps
 * and District Mgrs tabs). An owner-excluded person (isEmployee360ExcludedSubject) is dropped by the
 * gate below, so they simply do not appear — not even to themselves.
 *
 * Scope comes from resolveEmployee360VisibleRows, the same subtree-aware gate the [hrId] route and
 * the admin index already enforce (canViewEmployee360Subject), so this only surfaces people the
 * viewer could already open by direct URL: it widens navigation, never access.
 *
 * Never throws — for anyone with a team this picker IS the page, so a roster failure must degrade
 * to "no team visible", never to a blank Employee 360.
 */
async function buildEmployee360Picker(
  access: AccessContext,
  viewerHrId: string,
): Promise<Employee360ListItem[]> {
  try {
    const activeRows = await getEmployeeDirectoryRows({ includeInactive: false });
    const visibleRows = await resolveEmployee360VisibleRows(activeRows, access);
    // The shared card builder: canonical line spelling, and each card's manager chain for the filter.
    return buildEmployee360ListItems(visibleRows, activeRows);
  } catch (rosterError) {
    logPortalFailure(
      { route: PORTAL_BASE_PATH, module: "employee-360-team-roster", role: access.role, hrId: viewerHrId },
      rosterError,
    );
    return [];
  }
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
  const roleCategory = target ? resolveEmployee360RoleCategory(target.jobTitle ?? target.positionTitle) : null;

  // A company-wide viewer (Training Manager today — the retired Talent Acquisition seat's
  // successors, HR Advisory and HR Operations, are admin-shell now and never reach this portal
  // page) whose own record isn't field-force — or has no directory row at all — gets the same
  // browse-all-field-force list the admin index page offers, instead of a self-view empty state
  // that could never apply to them. Everyone else keeps the self-only states below.
  if ((!target || !roleCategory) && isCompany360Viewer(access)) {
    const activeRows = await getEmployeeDirectoryRows({ includeInactive: false });
    const visibleRows = await resolveEmployee360VisibleRows(activeRows, access);
    const employees: Employee360ListItem[] = buildEmployee360ListItems(visibleRows, activeRows);

    return (
      <Shell description="Company-wide field-force directory." title="Employee 360">
        {employees.length === 0 ? (
          <EmployeePortalEmptyState message="No field-force employees are visible right now." title="Employee 360" />
        ) : (
          <EmployeeSearchList employees={employees} basePath={PORTAL_BASE_PATH} />
        )}
      </Shell>
    );
  }

  if (!target) {
    return (
      <Shell description="Your field performance and team roll-up." title="Employee 360">
        <EmployeePortalEmptyState
          message="We could not find your employee record. Please contact HR if this continues."
          title="Profile unavailable"
        />
      </Shell>
    );
  }

  // Every role sees themselves plus everyone in their own reporting subtree, so the roster is built
  // before any branch decides what to render. It drives both picker paths: the normal
  // manager-with-a-team browse list, and the case where the viewer's OWN record is not a viewable
  // 360 subject (an owner-excluded person — see isEmployee360ExcludedSubject), where their team is
  // still legitimately theirs to open, so we show the picker instead of bouncing them out.
  const teamRoster = await buildEmployee360Picker(access, target.hrId);

  // The shared 360 gate stays the single source of truth rather than assuming self-view inline.
  if (!canViewEmployee360Subject(access, target, await buildEmployee360Scope(rows, access))) {
    return (
      <Shell description="Your team's field performance and roll-up." title="Employee 360">
        {teamRoster.length > 0 ? (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-500">Select Employee</h2>
              <span className="whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-widest text-slate-400">
                {teamRoster.length} in your team
              </span>
            </div>
            <EmployeeSearchList employees={teamRoster} basePath={PORTAL_BASE_PATH} defaultTab={roleCategory} />
          </section>
        ) : (
          <EmployeePortalEmptyState
            message="Your own Employee 360 report is not available. If you manage a team, their reports will appear here."
            title="Employee 360"
          />
        )}
      </Shell>
    );
  }

  // Owner rule (2026-08-05): the picker and the viewer's OWN report must never share the
  // screen. A manager used to see their own card under "District Mgrs" sitting directly above
  // their own rendered report — the same person drawn twice — and pressing that card opened a
  // THIRD copy on the detail route. So whenever there is somebody to pick, this page is the
  // browse list and nothing else: pressing a name (their own included) opens that person's
  // report on /employee-portals/employee-360/[hrId], exactly like the admin surface.
  //
  // Returning here also skips the entire profile / team-health / lifecycle load below, which is
  // pure waste when no report is rendered — and every one of those calls is its own cross-region
  // round trip (Railway `europe-west4` → Supabase `eu-central-1`), so this is the difference
  // between a slow page and an instant one. It sits above the !roleCategory check on purpose: a
  // manager whose own job title is outside the six field-force families still owns their team's
  // reports, and must not be shown "Not covered by Employee 360" now that there is no self report
  // to fall back on.
  if (teamRoster.length > 1) {
    return (
      <Shell description="Pick yourself or anyone in your team to open their 360 report." title="Employee 360">
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-phx-2xs font-bold uppercase tracking-widest text-slate-500">Select Employee</h2>
            <span className="whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-widest text-slate-400">
              you + {teamRoster.length - 1} in your team
            </span>
          </div>
          {/* Open on the viewer's OWN role tab, not Medical Reps (which is first in
              EMPLOYEE_360_ROLE_ORDER and would otherwise always win) — so a Regional Manager
              lands on "Regional Mgrs" with their own card first, and reaches their DSMs and reps
              on the neighbouring tabs. */}
          <EmployeeSearchList employees={teamRoster} basePath={PORTAL_BASE_PATH} defaultTab={roleCategory} />
        </section>
      </Shell>
    );
  }

  // Employee 360 covers only the six field-force role families. Anyone else (HR,
  // Finance, admin, office…) gets a clear out-of-scope state, matching the admin report.
  if (!roleCategory) {
    return (
      <Shell description="Your field performance and team roll-up." title="Employee 360">
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
        subjectHrId: target.hrId,
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
    <Shell description="Your field performance and team roll-up." title="Employee 360">
      <div className="space-y-4">
        <PeriodFilter
          activeKey={period.key}
          basePath={PORTAL_BASE_PATH}
          from={period.current.from}
          hrId={subject.hrId}
          to={period.current.to}
        />
        {/* No picker here by design — this branch is only reached when the viewer is the ONLY
            visible subject (a Medical Rep, or a manager whose reports are all inactive), so there
            is nobody to pick and the report is the whole page. Anyone with a team returned above
            with the browse list instead. */}
        <Employee360View
          bare
          // The shell above renders the page <h1>; this makes the subject name an <h2>.
          chrome="portal"
          category={roleCategory}
          comparison={comparison}
          pmMarketing={pmMarketing}
          showExpenses={showExpenses}
          subject={subject}
          summary={summary}
          teamHealth={teamHealth}
          teamLifecycle={teamLifecycle}
          tmAnalytics={tmAnalytics}
          suppressCoaching
        />
      </div>
    </Shell>
  );
}
