import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import {
  CalendarCheck,
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
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { FingerprintAnalytics } from "@/components/employee-portal/fingerprint-analytics";
import { MarketingRequestDecisionConfirmation } from "@/components/employee-portal/marketing-request-decision-confirmation";
import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";
import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";
import { MarketingRoiTrackingWorkspace } from "@/components/employee-portal/marketing-roi-tracking-workspace";
import { MarketingValidationWorkspace } from "@/components/employee-portal/marketing-validation-workspace";
import { PersonalExpenseWorkloadDashboard } from "@/components/employee-portal/personal-expense-workload-dashboard";
import { PlanningCalendar } from "@/components/employee-portal/planning-calendar";
import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
import { PrivateCalendar } from "@/components/employee-portal/private-calendar";
import { DeductionsPortalWorkspace } from "@/components/employee-portal/deductions-workspace";
import { EmployeeProbationDashboard } from "@/components/employee-portal/employee-probation-dashboard";
import {
  ContactHRSupportPage,
  EmployeePortalIncentivePage,
  MedicalRepOverviewPage,
  MedicalRepPayrollPage,
} from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { MobileOutstationWizard } from "@/components/outstation/mobile-outstation-wizard";
import { OrganogramReport } from "@/components/reports/organogram-report";
import { VacanciesReport } from "@/components/reports/vacancies-report";
import { VacationReport } from "@/components/vacation/vacation-report";
import { VacationRequestForm } from "@/components/vacation/vacation-request-form";
import { PageTransition } from "@/components/ui/page-transition";
import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { writeAuditLog } from "@/lib/admin/audit";
import type { AccessContext } from "@/lib/auth/permissions";
import {
  getEmployeePortalIncentiveData,
  getEmployeePortalShellData,
  getMedicalRepPortalData,
  getPayslipPortalData,
  getDsmTeamPerformance,
} from "@/lib/employee-portal/service";
import { compactDeductionHrId, listPublishedDeductionsForPortal } from "@/lib/deductions-governance/service";
import { canonicalHrIdKey } from "@/lib/hr-id";
import {
  getMarketingRequestDecisionSummary,
  parseMarketingRequestDecision,
} from "@/lib/marketing-requests/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { getOutstationEmployeeContext } from "@/lib/outstation/service";
import { getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";
import {
  canAccessCompanyOrganogram,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLineForEmployee,
  scopeOrganogramReportData,
} from "@/lib/reports/organogram";
import {
  errorMessage,
  getVacancyReport,
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
import { getProbationRows, isProbationSchemaMissing, probationErrorMessage } from "@/lib/probation/service";
import type { ProbationRow } from "@/lib/probation/types";
import { getSharedPlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar-service";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";
import {
  getVacationReportData,
  getVacationRequestPageData,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import type { VacationReportFilters } from "@/lib/vacation/types";
import {
  requireAdminShellEmployeeWorkspaceAccess,
  workspaceMarketingRoles,
} from "@/lib/workspace/admin-shell-employee";

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function WorkspaceFrame({
  badges,
  children,
  description,
  eyebrow = "Employee Workspace",
  icon,
  title,
}: {
  badges?: ReactNode;
  children: ReactNode;
  description: string;
  eyebrow?: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={
          badges ?? (
            <>
              <AdminInsightChip>Employee scope</AdminInsightChip>
              <AdminInsightChip tone="orange">Admin shell</AdminInsightChip>
            </>
          )
        }
        description={description}
        eyebrow={eyebrow}
        icon={icon}
        title={title}
      />
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

export async function WorkspaceDashboardPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  let data = null;
  try {
    data = await getMedicalRepPortalData(access);
  } catch (error) {
    logPortalFailure({ route: "/workspace", module: "workspace-dashboard", role: access.role, hrId: access.hrId }, error);
  }
  if (!data) return employeeDataUnavailable("Dashboard Unavailable");
  return (
    <WorkspaceFrame
      description="Your employee dashboard in the admin shell, with the same employee-scope data and no additional authority."
      icon={<LayoutDashboard className="h-3.5 w-3.5" />}
      title="My Dashboard"
    >
      <MedicalRepOverviewPage data={data} surface="workspace" />
    </WorkspaceFrame>
  );
}

export async function WorkspaceIncentivePage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  const data = await getEmployeePortalIncentiveData(access).catch((error) => {
    logPortalFailure({ route: "/workspace/incentive", module: "incentive", role: access.role, hrId: access.hrId }, error);
    return null;
  });
  if (!data) return employeeDataUnavailable("Incentive Unavailable");
  return (
    <WorkspaceFrame
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
  return (
    <WorkspaceFrame
      description="Submit, review, and follow up on weekly and monthly plans from the admin shell."
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
  const now = new Date();
  const workspace = await getSharedPlanningCalendarWorkspace(access, now.getUTCFullYear(), now.getUTCMonth() + 1);
  return (
    <WorkspaceFrame
      description="View submitted planning activity, vacations, and conflicts from your existing employee scope."
      icon={<CalendarRange className="h-3.5 w-3.5" />}
      title="Planning Calendar"
    >
      <PlanningCalendar initialWorkspace={workspace} />
    </WorkspaceFrame>
  );
}

export async function WorkspacePrivateCalendarPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  const now = new Date();
  const workspace = await getPrivateCalendarWorkspace({
    access,
    month: now.getUTCMonth() + 1,
    year: now.getUTCFullYear(),
  }).catch((error) => {
    logPortalFailure({ route: "/workspace/private-calendar", module: "private_calendar", role: access.role, hrId: access.hrId }, error);
    return null;
  });
  return (
    <WorkspaceFrame
      description="Attendance, vacations, excuses, plans, and national vacations for your employee scope."
      icon={<CalendarCheck className="h-3.5 w-3.5" />}
      title="Private Calendar"
    >
      {workspace ? <PrivateCalendar initialWorkspace={workspace} surface="workspace" /> : (
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
      description="Review your own published payslips inside the admin shell."
      icon={<ScrollText className="h-3.5 w-3.5" />}
      title="Payslips"
    >
      <MedicalRepPayrollPage data={data} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceDeductionsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "employee_profile" });
  const monthKey = firstParam(searchParams.monthKey)?.trim() || undefined;
  const data = await listPublishedDeductionsForPortal({ access, monthKey }).catch((error) => ({ error }));
  if ("error" in data) {
    return (
      <WorkspaceUnavailable
        message={data.error instanceof Error ? data.error.message : "Unable to load published deductions."}
        title="Deductions Unavailable"
      />
    );
  }
  return (
    <WorkspaceFrame
      description="Approved and finalized salary deductions visible to your existing employee scope."
      icon={<ReceiptText className="h-3.5 w-3.5" />}
      title="Deductions"
    >
      <DeductionsPortalWorkspace
        comments={data.comments}
        lines={data.lines}
        ownCompactHrId={compactDeductionHrId(access.hrId ?? access.loginId)}
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

export async function WorkspaceMarketingValidationPage() {
  await requireAdminShellEmployeeWorkspaceAccess({ allowedRoles: workspaceMarketingRoles });
  return (
    <WorkspaceFrame
      description="Validate healthcare providers, pharmacies, and distributor codes before marketing request use."
      icon={<ShieldCheck className="h-3.5 w-3.5" />}
      title="Customer Validation"
    >
      <MarketingValidationWorkspace />
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
      description="Review marketing approvals assigned to your employee role and scope."
      icon={<Inbox className="h-3.5 w-3.5" />}
      title="Approval Inbox"
    >
      <MarketingRequestInbox decisionBasePath="/workspace/marketing-requests/decision" />
    </WorkspaceFrame>
  );
}

export async function WorkspaceMarketingRoiPage() {
  await requireAdminShellEmployeeWorkspaceAccess({ allowedRoles: workspaceMarketingRoles });
  return (
    <WorkspaceFrame
      description="Track marketing request ROI using the same source data in the admin shell."
      icon={<WalletCards className="h-3.5 w-3.5" />}
      title="ROI Tracking"
    >
      <MarketingRoiTrackingWorkspace />
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
      description="Submit leave requests with the same manager approval flow in the admin shell."
      icon={<CalendarDays className="h-3.5 w-3.5" />}
      title="Vacation Request"
    >
      <VacationRequestForm
        initialData={initialData}
        initialError={initialError ?? initialData?.balanceError ?? null}
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
      description="Review leave requests and entitlements within your existing employee scope."
      icon={<CalendarCheck className="h-3.5 w-3.5" />}
      title="Vacation Report"
    >
      <VacationReport initialData={initialData} initialError={initialError} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceVacanciesPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "vacancies" });
  let initialError: string | null = null;
  let initialReport = null;
  try {
    const full = await getVacancyReport();
    if (isLineScopedOrganogramRole(access)) {
      const lineName = await resolveOrganogramLineForEmployee(access);
      initialReport = scopeOrganogramReportData(full, { lineName, mode: "line" });
    } else {
      initialReport = full;
    }
  } catch (error) {
    initialError = reportPageError(error);
  }
  return (
    <WorkspaceFrame
      description="View vacancies visible to your existing employee scope."
      icon={<Network className="h-3.5 w-3.5" />}
      title="Vacancies"
    >
      <VacanciesReport initialError={initialError} initialReport={initialReport} />
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
      description="Track probation records visible to your employee scope."
      icon={<CalendarCheck className="h-3.5 w-3.5" />}
      title="Probation Tracker"
    >
      <EmployeeProbationDashboard
        canSubmitManagerFeedback={["District Manager", "Regional Manager", "National Sales Manager", "Manager"].includes(access.role)}
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
      <OrganogramReport initialError={initialError} initialReport={initialReport} />
    </WorkspaceFrame>
  );
}

export async function WorkspaceExpenseDashboardPage() {
  const access = await requireAdminShellEmployeeWorkspaceAccess({ resource: "expenses" });
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
  const [portalDataResult, outstationContextResult, teamPerformanceResult] = await Promise.allSettled([
    getEmployeePortalShellData(access),
    getOutstationEmployeeContext(access),
    getDsmTeamPerformance(access),
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
  return (
    <WorkspaceFrame
      description="Start the guided outstation submission using your existing employee permissions."
      icon={<PlusCircle className="h-3.5 w-3.5" />}
      title="Submit Expense"
    >
      <MobileOutstationWizard
        employeeHrId={access.hrId ?? portalData.employee.hrId}
        employeeName={employeeName}
        employeeRole={employeeRole}
        hasResidenceCoordinates={hasResidenceCoordinates}
        medicalTripOptions={medicalTripOptions}
        residenceShortSummary={buildResidenceShortSummary(residence)}
        residenceSummary={buildResidenceSummary(residence)}
        showIntro={false}
      />
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
      description="Open support tickets and reach HR with your latest employee profile context."
      icon={<LifeBuoy className="h-3.5 w-3.5" />}
      title="Request Support"
    >
      <ContactHRSupportPage data={data} />
    </WorkspaceFrame>
  );
}
