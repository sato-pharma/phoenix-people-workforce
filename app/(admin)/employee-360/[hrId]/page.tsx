import Link from "next/link";
import { AlertTriangle, ArrowLeft, UserX } from "lucide-react";
import { redirect } from "next/navigation";

import { Employee360View, type Employee360Subject } from "@/components/employee-360/employee-360-view";
import { Employee360IncentiveSection } from "@/components/employee-360/incentive-section";
import { PeriodFilter } from "@/components/employee-360/period-filter";
import { Card } from "@/components/ui/card";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { buildEmployee360Scope, canViewEmployee360Subject } from "@/lib/employee-360/access";
import { getEmployee360Profile } from "@/lib/employee-360/deep-service";
import { loadEmployee360PersonnelRecords } from "@/lib/employee-360/personnel-records";
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
import { continuousServiceStartDate } from "@/lib/employees/continuous-service";

export const dynamic = "force-dynamic";

export default async function Employee360DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hrId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hrId } = await params;
  const sp = await searchParams;
  const period = resolvePeriod(sp);
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/employee-360/[hrId]");

  const rows = await getEmployeeDirectoryRows({ includeInactive: true });
  const target = rows.find((row) => hrIdsMatch(row.hrId, hrId));

  if (!target) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="border-slate-200/80 bg-white p-6 text-center shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <span className="mx-auto flex h-12 w-12 items-center justify-center bg-slate-100 text-slate-400">
            <UserX className="h-5 w-5" />
          </span>
          <h1 className="mt-3 text-lg font-black text-slate-900">Employee not found</h1>
          <p className="mt-1 text-sm text-slate-500">No employee record matches this link.</p>
          <Link href="/employee-360" className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:underline">
            <ArrowLeft className="h-4 w-4" />
            Back to Employee 360
          </Link>
        </Card>
      </div>
    );
  }

  // 360-specific scope gate (self / team / hierarchy / line / reps / company),
  // separate from the global canSeeEmployee used by payroll/directory.
  const scope = await buildEmployee360Scope(rows, access);
  if (!canViewEmployee360Subject(access, target, scope)) {
    redirect("/employee-360");
  }

  // Employee 360 covers only the six field-force role families. A person outside
  // that scope (HR, Finance, CEO, admin, office…) has no tailored report — show a
  // clear out-of-scope state instead of a half-empty generic one.
  const roleCategory = resolveEmployee360RoleCategory(target.jobTitle ?? target.positionTitle);
  if (!roleCategory) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card className="border-slate-200/80 bg-white p-6 text-center shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
          <span className="mx-auto flex h-12 w-12 items-center justify-center bg-slate-100 text-slate-400">
            <UserX className="h-5 w-5" />
          </span>
          <h1 className="mt-3 text-lg font-black text-slate-900">{target.displayName || target.fullName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {target.jobTitle || "This role"} isn’t covered by Employee 360. The report is scoped to the field force — Medical
            Reps, District / Regional / National Sales Managers, Product &amp; Group Product Managers, and Training Managers.
          </p>
          <Link href="/employee-360" className="mt-4 inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:underline">
            <ArrowLeft className="h-4 w-4" />
            Back to Employee 360
          </Link>
        </Card>
      </div>
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
    // A re-hired person's tenure counts from their first record's first day (continuous-service.ts).
    hireDate: continuousServiceStartDate(target.hrId, target.hireDate) ?? target.hireDate,
    // Tenure stops on the day they left, never keeps counting on a closed record.
    leftOn: isActiveLifecycleStatus(target.employmentStatus) ? null : employeeExitDay(target),
  };

  // Expense analysis is a MANAGER view (DM / RM / NSM / TM / PM / GPM) — an explicit
  // allowlist, not "anyone who isn't a Medical Rep" (HR/Finance/CEO/admin titles
  // must not see or fetch this section either). Job-function classification (not
  // the security role parser) is the right, sanctioned source here.
  const showExpenses = isExpenseAnalysisRole(target.jobTitle ?? target.positionTitle);

  const nameByHrId = new Map<string, string>(
    rows.map((row) => [row.hrId.trim().toLowerCase(), row.displayName || row.fullName]),
  );

  // Team roll-up: subject + ALL descendants in the org tree. A manager's sales are
  // the sum of their whole team's sales/target (DM = their reps, NSM = the line).
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

  // Never rejects: each section inside it fails on its own and is named on the page.
  const personnelRead = loadEmployee360PersonnelRecords({ access, target, scope });

  let summary: Awaited<ReturnType<typeof getEmployee360Profile>> | null = null;
  let previous: Awaited<ReturnType<typeof getEmployee360Summary>> | null = null;
  let error: string | null = null;
  try {
    const [cur, prev] = await Promise.all([
      getEmployee360Profile(target.hrId, nameByHrId, period.current, teamHrIds, showExpenses, access.role, roleCategory, access.hrId),
      getEmployee360Summary(target.hrId, period.previous, { hrId: access.hrId, role: access.role }),
    ]);
    summary = cur;
    previous = prev;
  } catch (loadError) {
    error = loadError instanceof Error ? loadError.message : "Failed to load profile data.";
  }

  const backAndFilter = (
    <div className="mx-auto max-w-5xl space-y-3 px-4 pt-4 sm:px-6">
      <Link
        href="/employee-360"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition hover:text-orange-600"
      >
        <ArrowLeft className="h-4 w-4" />
        All employees
      </Link>
      <PeriodFilter hrId={subject.hrId} activeKey={period.key} from={period.current.from} to={period.current.to} />
    </div>
  );

  if (!summary) {
    return (
      <div>
        {backAndFilter}
        <div className="mx-auto max-w-3xl p-6">
          <Card className="border-red-200 bg-red-50/60 p-6 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-red-100 text-red-600 ring-1 ring-inset ring-red-200">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h1 className="text-base font-black text-slate-900">{subject.displayName}</h1>
                <p className="mt-1 text-sm text-red-700">{error ?? "No data."}</p>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  // A section whose read fails says so on the page; it never silently disappears.
  const unreadSections: string[] = [];

  // Team Health — coaching coverage of a field manager's own reps (DM/RM/NSM).
  // PMs have no reps; Training Managers get their own richer analysis.
  let teamHealth: TeamHealthSummary | null = null;
  if (
    summary &&
    (roleCategory === "district-manager" ||
      roleCategory === "regional-manager" ||
      roleCategory === "national-sales-manager")
  ) {
    try {
      teamHealth = await getEmployee360TeamHealth({
        teamHrIds,
        employees: rows,
        window: { from: period.current.from, to: period.current.to },
        // Reps this manager double-visited (from the leadership activity already loaded).
        dvRepHrIds: (summary.leadership?.byRep ?? []).filter((r) => r.doubleVisits > 0).map((r) => r.hrId),
      });
    } catch {
      teamHealth = null;
      unreadSections.push("Team Development");
    }
  }

  // Team Compliance — weekly plans, field discipline & probation of the manager's
  // reps (same leader scope as Team Development above).
  let teamLifecycle: TeamLifecycleSummary | null = null;
  if (
    summary &&
    (roleCategory === "district-manager" ||
      roleCategory === "regional-manager" ||
      roleCategory === "national-sales-manager")
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

  // Training Manager god-mode analytics — coverage/neglect/concentration + verdict
  // across the whole active-Medical-Rep pool.
  let tmAnalytics: TrainingManagerAnalytics | null = null;
  if (summary && roleCategory === "training-manager") {
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
  if (summary && roleCategory === "product-manager") {
    try {
      pmMarketing = await getPmMarketingRoi(target.hrId, access, new Date().toISOString());
    } catch {
      pmMarketing = null;
      unreadSections.push("Marketing ROI");
    }
  }

  // Phoenix CRM: plan compliance and visit frequency by grade, read in the subject's own scope.
  let crmInsights: Employee360CrmInsights | null = null;
  if (summary) {
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
  }

  // The Team Coaching Skills Survey (owner, 2026-10-31) — managers only. Never read when the viewer is
  // the person rated, and the service refuses that case again on its own.
  let skillsSurveyHistory: Awaited<ReturnType<typeof getSkillsSurveyHistoryForMember>> = null;
  if (summary && isSkillsSurveyMember(target) && !isSkillsSurveySubject(access, target.hrId)) {
    try {
      skillsSurveyHistory = await getSkillsSurveyHistoryForMember(access, target.hrId);
    } catch {
      unreadSections.push("Team Coaching Skills Survey");
    }
  }

  const personnel = await personnelRead;

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
    <div>
      {backAndFilter}
      <Employee360View
        // Passed explicitly because it is load-bearing: this route renders the view with NO shell,
        // so the subject name IS the page heading and must stay an <h1>.
        chrome="admin"
        subject={subject}
        summary={summary}
        comparison={comparison}
        showExpenses={showExpenses}
        category={roleCategory}
        teamHealth={teamHealth}
        teamLifecycle={teamLifecycle}
        tmAnalytics={tmAnalytics}
        pmMarketing={pmMarketing}
        crmInsights={crmInsights}
        skillsSurvey={
          skillsSurveyHistory
            ? { history: skillsSurveyHistory, memberHref: `/coaching/skills-survey/${encodeURIComponent(target.hrId)}` }
            : null
        }
        unreadSections={unreadSections}
        personnel={personnel}
        incentiveSection={
          personnel.incentiveSignIn ? (
            <Employee360IncentiveSection access={access} scope={scope} signIn={personnel.incentiveSignIn} target={target} />
          ) : null
        }
      />
    </div>
  );
}
