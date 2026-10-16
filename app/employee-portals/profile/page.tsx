import {
  BriefcaseBusiness,
  CalendarCheck2,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Fingerprint,
  Hourglass,
  MapPin,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { BottomNavCustomizer } from "@/components/employee-portal/bottom-nav-customizer";
import { EmployeePhotoEditor } from "@/components/employee-portal/employee-photo-editor";
import { ScopeBadge } from "@/components/employee-portal/scope-badge";
import { BiometricDevicesCard } from "@/components/auth/biometric-devices-card";
import { ChangePasswordForm } from "@/components/auth/change-password-form";
import { NotificationSettingsPanel } from "@/components/notifications/notification-settings-panel";
import { Card } from "@/components/ui/card";
import { employeeHasActiveDeviceMapping } from "@/lib/attendance/device-user-mapping";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { formatDateOnly } from "@/lib/date-only";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getEmployeePortalShellData } from "@/lib/employee-portal/service";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { NO_PHOENIX_CRM_ENTRIES, phoenixCrmSidebarEntries, type PhoenixCrmSidebarEntries } from "@/lib/phoenix-crm/server/page";
import { hasInterviewCalendarAccess } from "@/lib/recruitment/interview-calendar";

export const dynamic = "force-dynamic";

function prettyDate(value: string | null) {
  return formatDateOnly(
    value,
    "en-GB",
    { day: "2-digit", month: "short", year: "numeric" },
    "Not available",
  );
}

function renewalTone(daysUntilRenewal: number | null) {
  if (daysUntilRenewal === null) return "text-slate-600";
  if (daysUntilRenewal <= 0) return "text-rose-600";
  if (daysUntilRenewal <= 30) return "text-amber-600";
  if (daysUntilRenewal <= 90) return "text-sky-600";
  return "text-emerald-600";
}

// The status is stored as a code ("active", "on_leave"); an employee reads a word.
function employmentStatusLabel(status: string | null | undefined) {
  const words = (status || "active").replace(/_+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function probationTone(status: "Completed" | "Not Started" | "On Probation") {
  if (status === "Completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "On Probation") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default async function EmployeePortalProfilePage() {
  const access = await resolveAuthenticatedPageAccess();

  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  await assertPermission(access, "employee_profile", "read");

  // STARTED TOGETHER (2026-10-01, "slow to transfer between page and page"): the three sidebar flags
  // read `access` alone — never the shell data — so they run beside it instead of queueing behind
  // it. Each settles to false on its own failure, so this can never reject unobserved, and it is
  // awaited below at the point where it used to be started.
  const navFlags: Promise<[boolean, boolean, PhoenixCrmSidebarEntries]> = access.hrId
    ? Promise.all([
        employeeHasActiveDeviceMapping(access.hrId).catch(() => false),
        hasInterviewCalendarAccess(access).catch(() => false),
        // The same gate the portal shell asks, asked again because this page builds its own chrome.
        // A flag left out here is a sidebar row that disappears the moment the rep opens his profile.
        phoenixCrmSidebarEntries(access).catch(() => NO_PHOENIX_CRM_ENTRIES),
      ])
    : Promise.resolve<[boolean, boolean, PhoenixCrmSidebarEntries]>([false, false, NO_PHOENIX_CRM_ENTRIES]);

  let data: Awaited<ReturnType<typeof getEmployeePortalShellData>> | null = null;
  try {
    data = await getEmployeePortalShellData(access);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/profile", module: "profile", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  if (!data) {
    return (
      <EmployeePortalPageShell
        badge="My Profile"
        description="We could not load your profile right now. Please refresh, or contact HR if the problem continues."
        title="My Profile"
      >
        <EmployeePortalEmptyState
          message="Unable to load your profile data at the moment."
          title="Profile Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  const { employee, hrContract } = data;
  const displayHrId = formatHrIdForDisplay(employee.hrId) ?? employee.hrId;
  const uploadedPhoto = employee.photoUrl ?? null;
  const currentPhotoUrl = uploadedPhoto ?? employeeProfileImageForHrId(employee.hrId);
  const photoInitials = employee.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();
  const [hasDeviceMapping, sharedInterviewCalendar, phoenixCrm] = await navFlags;
  const navVisibility = resolveEmployeePortalNavVisibility(
    employee.roleLabel,
    access.role,
    employee.line,
    employee.department,
    employee.hrId,
    hasDeviceMapping,
    sharedInterviewCalendar,
    phoenixCrm.crm,
    phoenixCrm.forecast,
    phoenixCrm.placeChecks,
    phoenixCrm.doubleVisitRequests,
  );

  const employmentRows: Array<{
    icon: typeof CalendarDays;
    label: string;
    tone?: string;
    value: string;
  }> = [
    { icon: CalendarDays, label: "Hire date", value: prettyDate(hrContract.hireDate) },
    { icon: CalendarCheck2, label: "Contract signed", value: prettyDate(hrContract.contractSignedDate) },
    {
      icon: CalendarClock,
      label: "Contract renewal",
      tone: renewalTone(hrContract.daysUntilRenewal),
      value:
        hrContract.contractRenewalDate
          ? hrContract.daysUntilRenewal !== null
            ? `${prettyDate(hrContract.contractRenewalDate)} (${hrContract.daysUntilRenewal} days)`
            : prettyDate(hrContract.contractRenewalDate)
          : "Not scheduled",
    },
    {
      icon: Hourglass,
      label: "Service duration",
      value: hrContract.serviceDurationText || "Not available",
    },
    {
      icon: ShieldCheck,
      label: "Employment status",
      value: employmentStatusLabel(hrContract.employmentStatus),
    },
    {
      icon: ClipboardList,
      label: "Payroll eligibility",
      value: hrContract.payrollEligibility,
    },
  ];

  const placementRows: Array<{
    icon: typeof BriefcaseBusiness;
    label: string;
    value: string;
  }> = [
    { icon: BriefcaseBusiness, label: "Job title", value: employee.roleLabel || "Not assigned" },
    { icon: Users, label: "Reporting manager", value: employee.manager ?? "Unassigned" },
    { icon: BriefcaseBusiness, label: "Line", value: employee.line ?? "Unassigned" },
    { icon: MapPin, label: "Area", value: employee.area ?? "Unassigned" },
    { icon: MapPin, label: "Territory", value: employee.territory ?? "Unassigned" },
    { icon: BriefcaseBusiness, label: "Department", value: employee.department ?? "Unassigned" },
  ];

  return (
    <EmployeePortalPageShell
      badge="My Profile"
      description="Your identity, contract, and reporting details. Reach out to HR if anything looks wrong."
      title="My Profile"
    >
      <div className="space-y-6">
        <EmployeePhotoEditor
          currentPhotoUrl={currentPhotoUrl}
          fullName={employee.fullName}
          hasUploadedPhoto={Boolean(uploadedPhoto)}
          initials={photoInitials}
        />
        <div className="flex flex-wrap items-center gap-3">
          <ScopeBadge scope={access.scope} />
        </div>

        {/* Who you are first — identity, contract and placement — then the settings below them.
            The settings cards used to come first, full width, so at 1440 the password form ran
            ~1,000px wide above the details a rep opens this page to read. */}
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
            <div className="mb-4 flex items-center gap-2">
              <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
                Identity
              </span>
              <span className="text-phx-xs font-medium text-slate-400">
                Phoenix employee record
              </span>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                  Full name
                </dt>
                <dd className="mt-1 break-words text-sm font-bold text-slate-900">
                  {employee.fullName}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                  HR ID
                </dt>
                <dd className="mt-1 flex items-center gap-2 break-words font-mono text-sm font-bold text-slate-900">
                  <Fingerprint className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                  {displayHrId}
                </dd>
              </div>
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                  Probation
                </dt>
                <dd className="mt-1">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-phx-xs font-semibold uppercase tracking-[0.08em] ${probationTone(hrContract.probationStatus)}`}
                  >
                    <Hourglass className="h-3 w-3" />
                    {hrContract.probationStatus}
                  </span>
                </dd>
              </div>
            </dl>
          </Card>

          <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6">
            <div className="mb-4 flex items-center gap-2">
              <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
                Employment
              </span>
              <span className="text-phx-xs font-medium text-slate-400">
                Contract and tenure
              </span>
            </div>
            <ul className="divide-y divide-slate-100">
              {employmentRows.map((row) => {
                const Icon = row.icon;
                return (
                  <li className="flex items-center gap-3 py-2.5" key={row.label}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-slate-100 text-slate-500">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                        {row.label}
                      </p>
                      <p
                        className={`mt-0.5 break-words text-sm font-semibold ${row.tone ?? "text-slate-900"}`}
                      >
                        {row.value}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card className="rounded border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-6 lg:col-span-2">
            <div className="mb-4 flex items-center gap-2">
              <span className="inline-flex rounded border border-orange-200 bg-orange-50 px-2.5 py-0.5 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
                Placement
              </span>
              <span className="text-phx-xs font-medium text-slate-400">
                Role, line, area, and reporting
              </span>
            </div>
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {placementRows.map((row) => {
                const Icon = row.icon;
                return (
                  <div className="min-w-0" key={row.label}>
                    <dt className="flex items-center gap-2 text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
                      <Icon className="h-3.5 w-3.5 text-slate-400" />
                      {row.label}
                    </dt>
                    <dd className="mt-1 break-words text-sm font-semibold text-slate-900">
                      {row.value}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </Card>

          {/* ONE way to reach HR, and it goes somewhere. This used to be two identical
              "Contact HR to update this information" chips (here and beside the scope badge) that
              looked like buttons and did nothing. */}
          <Card className="rounded border border-orange-100 bg-orange-50/40 p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-6 lg:col-span-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
                  Need a correction?
                </p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  Your profile is read-only. HR can update your contract, area, manager, or contact details.
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  Send HR a request and they will follow up with confirmation.
                </p>
              </div>
              <Link
                className="inline-flex min-h-10 shrink-0 items-center gap-2 self-start rounded border border-orange-300 bg-white px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-orange-700 transition-colors hover:border-orange-400 hover:bg-orange-50 sm:self-center md:min-h-9"
                href="/employee-portals/contact-hr-support"
              >
                <UserCog className="h-3.5 w-3.5 shrink-0" />
                Contact HR
              </Link>
            </div>
          </Card>
        </div>

        {/* Settings — two across on a wide screen instead of four full-width cards. */}
        <div className="grid gap-5 xl:grid-cols-2">
          <NotificationSettingsPanel />
          <ChangePasswordForm />
          <BiometricDevicesCard />
          <BottomNavCustomizer visibility={navVisibility} />
        </div>
      </div>
    </EmployeePortalPageShell>
  );
}
