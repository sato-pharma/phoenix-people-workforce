import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  Fingerprint,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  Network,
  PlusCircle,
  ReceiptText,
  ScrollText,
  Sparkles,
} from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { EmployeeExcusesWorkspace } from "@/components/employee-portal/employee-excuses-workspace";
import { FingerprintAnalytics } from "@/components/employee-portal/fingerprint-analytics";
import { MarketingRequestDecisionConfirmation } from "@/components/employee-portal/marketing-request-decision-confirmation";
import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";
import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";
import { PersonalExpenseWorkloadDashboard } from "@/components/employee-portal/personal-expense-workload-dashboard-dynamic";
import { PlanningCalendar } from "@/components/employee-portal/planning-calendar";
import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
import { PrivateCalendar } from "@/components/employee-portal/private-calendar";
import { DeductionsPortalWorkspace } from "@/components/employee-portal/deductions-workspace";
import { EmployeeProbationDashboard } from "@/components/employee-portal/employee-probation-dashboard";
import {
  ContactHRSupportPage,
  EmployeePortalIncentivePage,
  MedicalRepPayrollPage,
} from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { MobileOutstationWizard } from "@/components/outstation/mobile-outstation-wizard";
import { OutstationPendingActions } from "@/components/outstation/outstation-pending-actions";
import { SubmitExpenseMyClaims } from "@/components/outstation/submit-expense-my-claims";
import { OrganogramReport } from "@/components/reports/organogram-report";
import { VacanciesReport } from "@/components/reports/vacancies-report";
import { VacationReport } from "@/components/vacation/vacation-report";
import { VacationRequestForm } from "@/components/vacation/vacation-request-form";
import { PageTransition } from "@/components/ui/page-transition";
import { PersonalWorkspaceTabs } from "@/components/workspace/personal-workspace-tabs";
import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { writeAuditLog } from "@/lib/admin/audit";
import {
  buildPermissionLookup,
  canAccess,
  permissionMatrix,
  usesHrNamespace,
  type AccessContext,
} from "@/lib/auth/permissions";
import {
  getEmployeePortalIncentiveData,
  getEmployeePortalShellData,
  getMedicalRepPortalData,
  getPayslipPortalData,
  getDsmTeamPerformance,
} from "@/lib/employee-portal/service";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { getPortalDeductionLedger } from "@/lib/deductions/portal.ts";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { hrBundleForRole } from "@/lib/hr/command-center";
import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import {
  getMarketingRequestDecisionSummary,
  parseMarketingRequestDecision,
} from "@/lib/marketing-requests/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import {
  getOutstationEmployeeContext,
  getOwnOutstationPendingActions,
  listOwnOutstationSubmissions,
} from "@/lib/outstation/service";
import { getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";
import { canViewEmptySeatsBoard } from "@/lib/reports/empty-seats";
import {
  canAccessCompanyOrganogram,
  getOrganogramReport,
  getScopedVacancyReport,
  resolveOrganogramLineForEmployee,
} from "@/lib/reports/organogram";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
} from "@/lib/reports/vacancies";
import {
  employeeDirectoryErrorMessage,
  isEmployeeDirectoryEnvMissing,
  isEmployeeDirectorySchemaMissing,
  isEmployeeDirectoryTimeout,
} from "@/lib/employees/employee-directory";
import { canDownloadEmployeeCv } from "@/lib/employees/employee-cv";
import { excuseErrorMessage, getExcuseWorkspace, isExcusesSchemaMissing } from "@/lib/excuses/service";
import { getProbationRows, isProbationSchemaMissing, probationErrorMessage } from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";
import { getSharedPlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar-service";
import { canExportPlanningCalendar } from "@/lib/weekly-planning/calendar";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";
import { availableBalanceAfterPending } from "@/lib/vacation/calculations";
import {
  getVacationReportData,
  getVacationRequestPageData,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import type { VacationReportFilters } from "@/lib/vacation/types";
import {
  requireAdminShellEmployeeWorkspaceAccess,
  workspaceExpenseDashboardRoles,
  workspaceMarketingRoles,
} from "@/lib/workspace/admin-shell-employee";
import {
  PersonalWorkspaceOverview,
  type PersonalWorkspaceOverviewData,
} from "@/components/workspace/personal-workspace-overview";
import { resolvePersonalWorkspaceTabs } from "@/lib/workspace/personal-workspace-nav";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function WorkspaceFrame({
  access,
  badges,
  children,
  description,
  eyebrow = "Employee Workspace",
  hero,
  icon,
  title,
}: {
  /**
   * Pass this on a PERSONAL page and the tab strip appears; omit it and the frame renders bare.
   * Passing it on one of the two HR seats also renders bare — they carry the same list under their
   * identity banner instead, and the reason that is decided here rather than by the strip is in the
   * comment on `const tabs` below.
   *
   * That is the whole switch, and it is a prop rather than something the frame works out for
   * itself because five pages using this frame are not personal at all — the marketing request,
   * inbox, decision, vacancies and organogram pages are module work that happens to render here.
   * Showing them a strip of somebody's payslips and excuses would be wrong, and having the frame
   * guess which is which by pathname would put that decision somewhere nobody would look for it.
   *
   * The tabs are resolved here rather than in the client component so nothing about the permission
   * matrix ships to the browser: the strip receives a plain list of hrefs it may show.
   */
  access?: AccessContext;
  badges?: ReactNode;
  children: ReactNode;
  description: string;
  eyebrow?: string;
  /**
   * Replaces the default AdminPageHero entirely. The overview uses it to draw the personal identity
   * banner the CEO, SFE Manager and Finance Manager pages draw — same component, same person's name
   * and photo. It is a REPLACEMENT rather than an addition on purpose: two stacked heroes is a real
   * defect this repo has shipped three times, and tests/workspace-single-hero.test.ts exists because
   * of it.
   */
  hero?: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  // NOT ON THE TWO HR SEATS — they already carry this exact list, one row higher.
  //
  // The owner's instruction, 2026-09-01: *"Make the my pages as a strip or as a line in the top of
  // the page under the identity banner. And make it fixed in every page she opens."* That strip is
  // `HrMyPagesStrip`, mounted in AppShell inside the sticky header, so it is on EVERY `/hr` page
  // rather than only the ones using this frame. It is built from `resolvePersonalWorkspaceTabs` —
  // the same call, the same permission lookup — so what it lists and what this renders are the
  // same links, and an HR seat opening a personal page got both: two rows of identical tabs,
  // stacked. Measured on the local dev server at 1440px before this gate: 1446px of tab content in
  // a 1082px column, which is also the horizontal scroll the owner's golden rule forbids.
  //
  // Gated on `usesHrNamespace`, the SAME predicate `HrMyPagesStrip` returns null on, so exactly one
  // of the two ever renders. Deriving the condition some other way — a pathname test, an "is this
  // page under /hr" check — would put the two halves of one decision in two places, and the next
  // seat added to `hrNamespaceRoles` would silently get the duplicate back.
  //
  // Every other role is untouched: this strip is the only navigation the fifteen personal pages
  // have (see PersonalWorkspaceTabs), and removing it outright would strand them again.
  const tabs =
    access && !usesHrNamespace(access.role)
      ? resolvePersonalWorkspaceTabs(access, buildPermissionLookup(permissionMatrix, access.role))
      : [];
  return (
    <div className="space-y-6">
      {hero ?? (
        <AdminPageHero
          badges={
            badges ?? (
              <AdminInsightChip tone="orange">Admin shell</AdminInsightChip>
            )
          }
          description={description}
          eyebrow={eyebrow}
          icon={icon}
          title={title}
        />
      )}
      {tabs.length ? <PersonalWorkspaceTabs tabs={tabs} /> : null}
      <PageTransition>{children}</PageTransition>
    </div>
  );
}

function WorkspaceUnavailable({ message, title }: { message: string; title: string }) {
  return <EmployeePortalEmptyState message={message} title={title} />;
}

function employeeDataUnavailable(title = "Workspace Unavailable") {
  return (
    <WorkspaceUnavailable
      message="Your employee profile could not be loaded. Please refresh or contact HR if this continues."
      title={title}
    />
  );
}

function reportPageError(error: unknown) {
  if (isSupabaseTimeout(error)) return "Supabase request timed out. Check your connection and try again.";
  if (isSupabaseEnvMissing(error)) return "Supabase environment variables are missing.";
  if (isDatabaseSchemaMissing(error)) return "Supabase schema is not ready.";
  return errorMessage(error);
}

function probationPageError(error: unknown) {
  if (isEmployeeDirectoryTimeout(error)) return "Supabase request timed out. Check your connection and try again.";
  if (isEmployeeDirectoryEnvMissing(error)) return "Supabase environment variables are missing.";
  if (isEmployeeDirectorySchemaMissing(error)) return "Supabase schema is not ready.";
  if (isProbationSchemaMissing(error)) return "Probation review schema is not ready.";
  return probationErrorMessage(error) || employeeDirectoryErrorMessage(error);
}

function vacationPageError(error: unknown) {
  if (isVacationSchemaMissing(error)) return "Vacation schema is not ready. Apply the vacation migration before using this module.";
  return vacationErrorMessage(error) || "Unable to load vacation data.";
}

function filtersFromSearchParams(searchParams: SearchParams): VacationReportFilters {
  return {
    dateFrom: firstParam(searchParams.dateFrom),
    dateTo: firstParam(searchParams.dateTo),
    department: firstParam(searchParams.department),
    employee: firstParam(searchParams.employee),
    line: firstParam(searchParams.line),
    manager: firstParam(searchParams.manager),
    paymentStatus: firstParam(searchParams.paymentStatus) as VacationReportFilters["paymentStatus"],
    requestId: firstParam(searchParams.requestId),
    search: firstParam(searchParams.search),
    status: firstParam(searchParams.status) as VacationReportFilters["status"],
    vacationType: firstParam(searchParams.vacationType) as VacationReportFilters["vacationType"],
  };
}

function buildResidenceSummary(residence: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
} | null) {
  if (!residence) return "Not configured";
  const parts = [residence.residenceAddress, residence.residenceArea, residence.residenceCity]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(" - ") : "Not configured";
}

function buildResidenceShortSummary(residence: {
  residenceAddress: string | null;
  residenceArea: string | null;
  residenceCity: string | null;
} | null) {
  if (!residence) return "Not configured";
  const parts = [residence.residenceArea, residence.residenceCity]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : buildResidenceSummary(residence);
}

/**
 * The personal workspace overview.
 *
 * REPLACED 2026-08-30 (owner). This page used to render `MedicalRepOverviewPage` — the medical
 * rep's PORTAL dashboard — to whoever opened it, so a Super Admin, an HR seat or the Finance
 * Manager landed on a sales rep's home: company sales totals, achievement rate, gap to target, a
 * team-rank panel that read "not available for this period", and territory insight copy about a
 * territory they do not hold. It was the seat's own landing page and showed the seat nothing.
 *
 * It is now built from this seat's own record, in the command-centre language the owner named —
 * the same section shells and metric tiles the CEO, SFE Manager and Finance Manager pages use,
 * imported rather than copied. It carried their identity banner too until 2026-09-03, when the
 * owner removed that band from every page in the shell; the name and role it showed are in the
 * topbar chip on all of them instead.
 *
 * Each of the three sources is loaded independently and may fail alone: the tile then reads "—"
 * and says which source did not answer. A zero would read as "no leave left" or "never at work
 * this month", which is the misleading-zero this repo's rules forbid.
 *
 * THE TWO HR SEATS DO NOT SEE THIS PAGE. Owner instruction, 2026-09-01: "make the overview
 * dashboard merged between HR overview and my workspace into one landing overview page." Their
 * landing page now carries this content as its own "My Record" section, built from the same three
 * services, so a second copy of it at this address would be exactly the two-overview-pages problem
 * the merge removed. Only the DASHBOARD redirects — every /workspace/* page underneath it
 * (payslips, excuses, vacation request…) is untouched and is linked from that section.
 *
 * Every other admin-shell role still lands here. This is a redirect for two roles, not a retirement
 * of the page.
 */
export async function WorkspaceDashboardPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  if (hrBundleForRole(access.role)) redirect("/hr/admin/hr-command-center");
  const { year, month } = currentCairoDateParts();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const today = currentCairoDateOnlyIso();
  // DATE-ONLY: `monthStart` is the Cairo month's first day as "YYYY-MM-01", parsed as UTC
  // midnight. UTC here is CORRECT and must stay — it is what stops the label slipping back to
  // the previous month. Not an instant; do not "fix" this one to Cairo.
  const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${monthStart}T00:00:00Z`),
  );

  // `viewer` used to be resolved here for the identity banner this page no longer draws
  // (owner, 2026-09-03). Dropping it also drops a round trip: the name and role it fetched are
  // already in the shell topbar, resolved once there.
  const [excuses, leave, attendance] = await Promise.all([
    getExcuseWorkspace(access).catch((error) => {
      logPortalFailure({ route: "/workspace", module: "workspace-overview-excuses", role: access.role, hrId: access.hrId }, error);
      return null;
    }),
    // Asserts leave:create, which every adminShellEmployeeRole holds — but a role added to that
    // list without it must degrade to a dash here, not throw the whole page away.
    // Same number the Vacation Request screen shows: the approved-only balance less the days
    // already requested and awaiting a decision. balanceAfterDays === balanceBeforeDays here (this
    // call passes durationDays 0), and both call sites below only display it.
    getVacationRequestPageData(access)
      .then((data) => (data.balance
        ? { ...data.balance, balanceAfterDays: availableBalanceAfterPending(data.balance.balanceBeforeDays, data.pendingPaidDaysByType?.annual ?? 0) }
        : null))
      .catch((error) => {
        logPortalFailure({ route: "/workspace", module: "workspace-overview-leave", role: access.role, hrId: access.hrId }, error);
        return null;
      }),
    access.hrId
      ? getEmployeeAttendanceData(access.hrId, monthStart, today).catch((error) => {
          logPortalFailure({ route: "/workspace", module: "workspace-overview-attendance", role: access.role, hrId: access.hrId }, error);
          return null;
        })
      : Promise.resolve(null),
  ]);

  const data: PersonalWorkspaceOverviewData = {
    attendance: attendance
      ? {
          exceptions: attendance.rows.filter((row) => row.hasException).length,
          monthLabel,
          recordedDays: attendance.rows.length,
        }
      : null,
    excuses,
    leave,
  };

  return (
    <WorkspaceFrame
      access={access}
      description="Your own record in the admin shell — leave, excuses, attendance and everything this seat can open."
      icon={<LayoutDashboard className="h-3.5 w-3.5" />}
      title="My Workspace"
    >
      <PersonalWorkspaceOverview
        data={data}
        tabs={resolvePersonalWorkspaceTabs(access, buildPermissionLookup(permissionMatrix, access.role))}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceIncentivePage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "incentive" });
  const data = await getEmployeePortalIncentiveData(access).catch((error) => {
    logPortalFailure({ route: "/workspace/incentive", module: "incentive", role: access.role, hrId: access.hrId }, error);
    return null;
  });
  if (!data) return employeeDataUnavailable("Incentive Unavailable");
  return (
    <WorkspaceFrame
      access={access}
      description="Review incentive progress using the same employee-scope calculations in the admin shell."
      icon={<Sparkles className="h-3.5 w-3.5" />}
      title="Incentive"
    >
      <EmployeePortalIncentivePage data={data} />
    </WorkspaceFrame>
  );
}

export async function WorkspacePlansPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "weekly_plans" });
  const selectedPlanId = Array.isArray(searchParams.plan) ? searchParams.plan[0] : searchParams.plan;
  const workspace = await getEmployeePlansWorkspace(access);
  // DR-02 (owner, 14 Nov 2026): Phoenix CRM is the one plan store, so this page is history (legacy-closed.ts).
  return (
    <WorkspaceFrame
      access={access}
      description="Every weekly and monthly plan filed here before 14 November 2026, to read. New plans are made, sent and approved in Phoenix CRM."
      icon={<CalendarDays className="h-3.5 w-3.5" />}
      title="Weekly / Monthly Plan"
    >
      <PlansWorkspace
        access={access}
        basePath="/workspace/plans"
        initialWorkspace={workspace}
        selectedPlanId={selectedPlanId ?? null}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspacePlanningCalendarPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "weekly_plans" });
  const { year, month } = currentCairoDateParts();
  const workspace = await getSharedPlanningCalendarWorkspace(access, year, month);
  const canExport = canExportPlanningCalendar(access.role);
  return (
    <WorkspaceFrame
      access={access}
      description="View submitted planning activity, vacations, and conflicts from your existing employee scope."
      icon={<CalendarRange className="h-3.5 w-3.5" />}
      title="Planning Calendar"
    >
      <PlanningCalendar canExport={canExport} initialWorkspace={workspace} />
    </WorkspaceFrame>
  );
}

export async function WorkspacePrivateCalendarPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  const now = new Date();
  const { year, month } = currentCairoDateParts(now);
  const workspace = await getPrivateCalendarWorkspace({
    access,
    month,
    year,
  }).catch((error) => {
    logPortalFailure({ route: "/workspace/private-calendar", module: "private_calendar", role: access.role, hrId: access.hrId }, error);
    return null;
  });
  return (
    <WorkspaceFrame
      access={access}
      description="Attendance, vacations, excuses, plans, and national vacations for your employee scope."
      icon={<CalendarCheck className="h-3.5 w-3.5" />}
      title="Private Calendar"
    >
      {workspace ? <PrivateCalendar initialWorkspace={workspace} surface="workspace" todayIso={currentCairoDateOnlyIso(now)} /> : (
        <WorkspaceUnavailable message="We could not load the private calendar right now." title="Private Calendar Unavailable" />
      )}
    </WorkspaceFrame>
  );
}

export async function WorkspacePayslipsPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "payslips" });
  const data = await getPayslipPortalData(access).catch(() => null);
  if (!data) {
    return <WorkspaceUnavailable message="Your payslips workspace is temporarily unavailable." title="Payslips Unavailable" />;
  }
  return (
    <WorkspaceFrame
      access={access}
      description="Review your own published payslips inside the admin shell."
      icon={<ScrollText className="h-3.5 w-3.5" />}
      title="Payslips"
    >
      <MedicalRepPayrollPage data={data} />
    </WorkspaceFrame>
  );
}

// The admin shell's own copy of the employee Deductions page. It moved to the ledger read with the
// portal page on 2026-10-09 so the two surfaces keep showing the same thing — the month, type and
// status filters live inside the workspace now, so this takes no searchParams either.
export async function WorkspaceDeductionsPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  const data = await getPortalDeductionLedger({ access }).catch((error) => ({ error }));
  if ("error" in data) {
    return (
      <WorkspaceUnavailable
        message={data.error instanceof Error ? data.error.message : "Unable to load your deductions."}
        title="Deductions Unavailable"
      />
    );
  }
  return (
    <WorkspaceFrame
      access={access}
      description="Every deduction raised against you, and what HR decided on each one."
      icon={<ReceiptText className="h-3.5 w-3.5" />}
      title="Deductions"
    >
      <DeductionsPortalWorkspace
        comments={data.comments}
        firstMonthKey={data.firstMonthKey}
        ownCompactHrId={compactDeductionsHrId(access.hrId ?? access.loginId)}
        rows={data.rows}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceFingerprintReportPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "attendance" });
  if (!access.hrId) redirect("/workspace");
  const dateTo = dateKey(new Date());
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const dateFrom = dateKey(thirtyDaysAgo);
  const initialData = await getEmployeeAttendanceData(access.hrId, dateFrom, dateTo).catch(() => null);
  return (
    <WorkspaceFrame
      access={access}
      description="Your punch history and attendance status, scoped to your employee identity."
      icon={<Fingerprint className="h-3.5 w-3.5" />}
      title="Fingerprint Report"
    >
      <FingerprintAnalytics
        hrId={access.hrId}
        initialData={initialData ?? {
          dateFrom,
          dateTo,
          pendingDisputes: 0,
          policyDetails: [],
          rows: [],
          summary: {
            absentDays: 0,
            completeDays: 0,
            deductionDays: 0,
            exceptionDays: 0,
            lateDays: 0,
            shortDays: 0,
            totalRows: 0,
          },
        }}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceMarketingRequestsPage() {
  await requireAdminShellEmployeeWorkspaceAccess({ allowedRoles: workspaceMarketingRoles });
  return (
    <WorkspaceFrame
      description="Create draft activities, forecast product ROI, and prepare request rows for validation."
      icon={<Megaphone className="h-3.5 w-3.5" />}
      title="Marketing Requests"
    >
      <MarketingRequestDraftWorkspace />
    </WorkspaceFrame>
  );
}

export async function WorkspaceMarketingInboxPage() {
  await requireAdminShellEmployeeWorkspaceAccess({ allowedRoles: workspaceMarketingRoles });
  return (
    <WorkspaceFrame
      description="Review marketing approvals assigned to your employee role and scope, and the History tab of everything already decided."
      icon={<Inbox className="h-3.5 w-3.5" />}
      title="Approval Inbox"
    >
      <MarketingRequestInbox decisionBasePath="/workspace/marketing-requests/decision" />
    </WorkspaceFrame>
  );
}

async function auditMarketingDecisionPage(input: {
  access: AccessContext;
  decision: string | null;
  requestId: string;
  summary: string;
}) {
  await writeAuditLog({
    actorLoginId: input.access.loginId ?? input.access.hrId ?? "anonymous",
    entityId: input.requestId,
    entityType: "marketing_request",
    newValues: {
      decision: input.decision,
      source: "workspace_decision_link",
    },
    summary: input.summary,
  });
}

export async function WorkspaceMarketingDecisionPage({
  requestId,
  searchParams,
}: {
  requestId: string;
  searchParams: SearchParams;
}) {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ allowedRoles: workspaceMarketingRoles });
  const rawDecision = firstParam(searchParams.decision);
  const decision = parseMarketingRequestDecision(rawDecision);

  // No `?decision=` at all means somebody is opening the request to READ it, not deciding it —
  // the shape every pre-2026-08-18 "Request Preview" link from the live sheet had. Send them to the
  // Case File rather than the dead end. A decision that is PRESENT but not one of the three real
  // ones still falls through to the safe state below; that one is a tampered value.
  if (rawDecision === undefined) {
    redirect(`/marketing-requests/${encodeURIComponent(requestId)}`);
  }

  if (!decision) {
    await auditMarketingDecisionPage({
      access,
      decision: rawDecision ?? null,
      requestId,
      summary: "Workspace marketing request decision page blocked: invalid decision.",
    });
    return <WorkspaceUnavailable message="This marketing request decision link is invalid." title="Invalid Decision Link" />;
  }

  const summary = await getMarketingRequestDecisionSummary(requestId, decision, access).catch(async () => {
    await auditMarketingDecisionPage({
      access,
      decision,
      requestId,
      summary: "Workspace marketing request decision page blocked: unauthorized or unavailable.",
    });
    return null;
  });
  if (!summary) {
    return (
      <WorkspaceUnavailable
        message="You are not authorized to decide this marketing request, or it is no longer pending your decision."
        title="Decision Not Available"
      />
    );
  }
  await auditMarketingDecisionPage({
    access,
    decision,
    requestId,
    summary: "Workspace marketing request decision confirmation page opened.",
  });
  return (
    <WorkspaceFrame
      description="Confirm the marketing request decision inside Phoenix."
      icon={<Inbox className="h-3.5 w-3.5" />}
      title="Marketing Decision"
    >
      <MarketingRequestDecisionConfirmation summary={summary} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceVacationRequestPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ action: "create", resource: "leave" });
  let initialData: Awaited<ReturnType<typeof getVacationRequestPageData>> | null = null;
  let initialError: string | null = null;
  try {
    initialData = await getVacationRequestPageData(access);
  } catch (error) {
    initialError = vacationPageError(error);
  }
  return (
    <WorkspaceFrame
      access={access}
      description="Submit leave requests with the same manager approval flow in the admin shell."
      icon={<CalendarDays className="h-3.5 w-3.5" />}
      title="Vacation Request"
    >
      {/* showHero={false}: WorkspaceFrame above already renders the page hero. These portal
          components default showHero to true because they are also mounted standalone, so every
          other workspace page passes false explicitly — this one did not, and the page rendered
          TWO stacked "Vacation Request" heroes. */}
      <VacationRequestForm
        initialData={initialData}
        initialError={initialError ?? initialData?.balanceError ?? null}
        showHero={false}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceVacationReportPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "leave" });
  const filters = filtersFromSearchParams(searchParams);
  let initialData: Awaited<ReturnType<typeof getVacationReportData>> | null = null;
  let initialError: string | null = null;
  try {
    initialData = await getVacationReportData(access, filters);
  } catch (error) {
    initialError = vacationPageError(error);
  }
  return (
    <WorkspaceFrame
      access={access}
      description="Review leave requests and entitlements within your existing employee scope."
      icon={<CalendarCheck className="h-3.5 w-3.5" />}
      title="Vacation Report"
    >
      {/* Same doubled hero as Vacation Request above — both /leave-management and the portal copy
          of this page already pass showHero={false}; only the workspace copy was missed. */}
      <VacationReport initialData={initialData} initialError={initialError} showHero={false} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceVacanciesPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "vacancies" });
  let initialError: string | null = null;
  let initialReport = null;
  try {
    initialReport = await getScopedVacancyReport(access);
  } catch (error) {
    initialError = reportPageError(error);
  }
  // The same capability POST /api/employees asserts — see the vacancies report itself.
  // employees:create, not update, since the HR Operations Specialist seat (2026-10-20): she edits
  // the master but does not add to it, and POST /api/employees asserts create on every add.
  const canAddEmployee = await canAccess(access, "employees", "create");
  const canViewEmptySeats = await canViewEmptySeatsBoard(access);
  return (
    <WorkspaceFrame
      description="View vacancies visible to your existing employee scope."
      icon={<Network className="h-3.5 w-3.5" />}
      title="Vacancies"
    >
      <VacanciesReport canAddEmployee={canAddEmployee} canViewEmptySeats={canViewEmptySeats} initialError={initialError} initialReport={initialReport} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceProbationPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "probation" });
  let initialData: ProbationRow[] | null = null;
  let initialError: string | null = null;
  try {
    initialData = await getProbationRows(access);
  } catch (error) {
    initialError = probationPageError(error);
  }
  if (initialError) return <WorkspaceUnavailable message={initialError} title="Probation Tracker Unavailable" />;
  return (
    <WorkspaceFrame
      access={access}
      description="Track probation records visible to your employee scope."
      icon={<CalendarCheck className="h-3.5 w-3.5" />}
      title="Probation Tracker"
    >
      <EmployeeProbationDashboard
        initialData={initialData ?? []}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceOrganogramPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "organogram" });
  let initialError: string | null = null;
  let initialReport = null;
  try {
    if (canAccessCompanyOrganogram(access)) {
      initialReport = await getOrganogramReport(access, { mode: "company" });
    } else {
      const lineName = await resolveOrganogramLineForEmployee(access);
      initialReport = await getOrganogramReport(access, { lineName, mode: "line" });
    }
    if (initialReport?.diagnostic) initialError = initialReport.diagnostic.message;
  } catch (error) {
    initialError = reportPageError(error);
  }
  return (
    <WorkspaceFrame
      description="View reporting structure using your existing organogram scope."
      icon={<Network className="h-3.5 w-3.5" />}
      title="Organogram"
    >
      {/* Third page with the same doubled hero. */}
      <OrganogramReport
        canReadEmployeeCv={canDownloadEmployeeCv(access)}
        initialError={initialError}
        initialReport={initialReport}
        showHero={false}
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceExpenseDashboardPage() {
  // allowedRoles is explicit ONLY to keep the Finance Manager out (owner, 2026-08-10: "exclude him
  // 100% from outstation or expenses"). He keeps a bare `expenses:read` because that permission also
  // gates every /api/marketing-requests/** route he needs for the finance_execution rung, so the
  // default resource check alone would have let him in here. See workspaceExpenseDashboardRoles.
  const access = await requireAdminShellEmployeeWorkspaceAccess({
    allowedRoles: workspaceExpenseDashboardRoles,
    resource: "expenses",
  });
  if (canonicalHrIdKey(access.hrId) === "a-3") redirect("/workspace");
  const data = await getMedicalRepPortalData(access, {
    includePortalOverview: false,
    includeTeamRank: false,
    includeWorkforceSummary: false,
  }).catch(() => null);
  if (!data || data.empty.profile) {
    return <WorkspaceUnavailable message="Your employee profile is not linked yet. Please contact HR." title="Profile Not Linked" />;
  }
  if (!data.workload?.expenseRows?.length) {
    return <WorkspaceUnavailable message="No visible outstation expense records are available for your expense scope yet." title="No outstation expense records" />;
  }
  return (
    <WorkspaceFrame
      access={access}
      description="Review workload, trip volume, and outstation expense movement for you and your visible expense scope."
      icon={<ReceiptText className="h-3.5 w-3.5" />}
      title="Expense Dashboard"
    >
      <PersonalExpenseWorkloadDashboard
        adminKeyCards={null}
        data={data}
        showHero={false}
        submitExpenseHref="/workspace/submit-expense"
      />
    </WorkspaceFrame>
  );
}

export async function WorkspaceSubmitExpensePage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ action: "create", resource: "outstation" });
  const [portalDataResult, outstationContextResult, teamPerformanceResult, pendingActionsResult, submissionsResult] =
    await Promise.allSettled([
      getEmployeePortalShellData(access),
      getOutstationEmployeeContext(access),
      getDsmTeamPerformance(access),
      getOwnOutstationPendingActions(access),
      listOwnOutstationSubmissions(access),
    ]);
  if (portalDataResult.status === "rejected") {
    return <WorkspaceUnavailable message="Unable to load your employee profile." title="Submit Expense Unavailable" />;
  }
  const portalData = portalDataResult.value;
  const outstationContext = outstationContextResult.status === "fulfilled" ? outstationContextResult.value : null;
  const dsmTeamPerformance = teamPerformanceResult.status === "fulfilled" ? teamPerformanceResult.value : null;
  const employeeName = outstationContext?.employeeName ?? portalData.employee.fullName;
  const employeeRole = outstationContext?.employeeRole ?? portalData.employee.roleLabel;
  const residence = outstationContext?.residence ?? null;
  const hasResidenceCoordinates = residence
    ? residence.residenceLatitude !== null && residence.residenceLongitude !== null
    : false;
  const medicalTripOptions =
    dsmTeamPerformance?.members.map((member) => ({
      hrId: member.hrId,
      name: member.name,
    })) ?? [];
  const pendingActions =
    pendingActionsResult.status === "fulfilled"
      ? pendingActionsResult.value
      : { departurePhotoDue: [], missingTicket: [] };
  const employeeHrId = access.hrId ?? portalData.employee.hrId;
  const submissions = submissionsResult.status === "fulfilled" ? submissionsResult.value : null;
  return (
    <WorkspaceFrame
      access={access}
      description="Start the guided outstation submission using your existing employee permissions."
      icon={<PlusCircle className="h-3.5 w-3.5" />}
      title="Submit Expense"
    >
      <div className="space-y-5">
        <OutstationPendingActions
          departurePhotoDue={pendingActions.departurePhotoDue}
          employeeHrId={employeeHrId}
          missingTicket={pendingActions.missingTicket}
        />
        <MobileOutstationWizard
          employeeHrId={employeeHrId}
          employeeName={employeeName}
          employeeRole={employeeRole}
          hasResidenceCoordinates={hasResidenceCoordinates}
          medicalTripOptions={medicalTripOptions}
          residenceShortSummary={buildResidenceShortSummary(residence)}
          residenceSummary={buildResidenceSummary(residence)}
        />
        <SubmitExpenseMyClaims employeeHrId={employeeHrId} submissions={submissions} />
      </div>
    </WorkspaceFrame>
  );
}

export async function WorkspaceContactSupportPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ action: "create", resource: "support_requests" });
  const data = await getEmployeePortalShellData(access).catch((error) => {
    logPortalFailure({ route: "/workspace/contact-hr-support", module: "contact-hr-support", role: access.role, hrId: access.hrId }, error);
    return null;
  });
  if (!data) return employeeDataUnavailable("Support Unavailable");
  return (
    <WorkspaceFrame
      access={access}
      description="Open support tickets and reach HR with your latest employee profile context."
      icon={<LifeBuoy className="h-3.5 w-3.5" />}
      title="Request Support"
    >
      <ContactHRSupportPage data={data} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceExcusesPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  let data = null;
  let errorMessage: string | null = null;
  try {
    data = await getExcuseWorkspace(access);
  } catch (error) {
    logPortalFailure({ route: "/workspace/excuses", module: "excuses", role: access.role, hrId: access.hrId }, error);
    if (isExcusesSchemaMissing(error)) {
      errorMessage = "Excuse database tables are not deployed yet. Run the latest Supabase migration.";
    } else if (excuseErrorMessage(error).toLowerCase().startsWith("forbidden:")) {
      errorMessage = "Excuses are available for Head Office employees and selected management roles.";
    } else {
      errorMessage = excuseErrorMessage(error) || "Unable to load excuses.";
    }
  }
  if (!data) {
    return <WorkspaceUnavailable message={errorMessage ?? "Unable to load excuses."} title="Excuses Unavailable" />;
  }
  return (
    <WorkspaceFrame
      access={access}
      description="Submit a morning or afternoon 2-hour excuse, send it to your direct manager, and track monthly usage."
      icon={<CalendarClock className="h-3.5 w-3.5" />}
      title="Excuses"
    >
      <EmployeeExcusesWorkspace initialData={data} />
    </WorkspaceFrame>
  );
}
