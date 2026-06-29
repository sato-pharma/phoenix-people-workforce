import { Activity, BarChart3, BriefcaseBusiness, Building2, CalendarDays, CalendarX2, CheckCircle2, ClipboardCheck, FilePlus2, FileText } from "lucide-react";
import { redirect } from "next/navigation";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import {
  GlanceStrip,
  MarketingToolRow,
  PendingActions,
  ProfileIntelBar,
  PremiumNavTile,
  QuickActions,
} from "@/components/employee-portal/portal-command-center";
import { EmployeePortalEmptyState } from "@/components/employee-portal/enterprise-shell";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCoachingReports } from "@/lib/coaching/service";
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

  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1;

  const [snapshotResult, coachingResult] = await Promise.allSettled([
    getPortalHomeSnapshot(access),
    access.hrId
      ? getCoachingReports({ year: currentYear }, access)
      : Promise.resolve([]),
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

  const { shell, pendingVacationCount, pendingExcuseCount, leaveEntitlementDays } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  const reportsThisMonth = coachingReports.filter((r) => r.coachingMonth === currentMonth).length;

  return (
    <div className="mx-auto w-full space-y-4" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />

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
          { href: "/employee-portals/training-manager/create-coaching-report", icon: FilePlus2, label: "New Report" },
          { href: "/employee-portals/training-manager/field-coaching", icon: ClipboardCheck, label: "Field Coaching" },
          { href: "/employee-portals/double-visit-analytics", icon: Activity, label: "DV Analytics" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
        ]}
      />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      {/* Coaching — primary domain */}
      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Coaching</h2>
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-3">
          <PremiumNavTile
            href="/employee-portals/training-manager/coaching"
            icon={BarChart3}
            label="Coaching Dashboard"
            description="Field coaching performance & quarterly analytics"
          />
          <PremiumNavTile
            href="/employee-portals/training-manager/field-coaching"
            icon={ClipboardCheck}
            label="Field Coaching"
            description="View and manage all field coaching reports"
          />
          <PremiumNavTile
            href="/employee-portals/training-manager/create-coaching-report"
            icon={FilePlus2}
            label="New Report"
            description="Create a new coaching report for a medical rep"
          />
        </div>
      </div>

      {/* Team Operations */}
      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Team Operations</h2>
        </div>
        <div className="divide-y divide-slate-100 bg-white">
          <MarketingToolRow
            href="/employee-portals/double-visit-analytics"
            icon={Activity}
            label="DV Analytics"
            sub="Double-visit field coverage and per-rep intensity"
          />
          <MarketingToolRow
            href="/employee-portals/vacancies"
            icon={BriefcaseBusiness}
            label="Vacancies"
            sub="Open positions and DSM vacancies across your scope"
          />
          <MarketingToolRow
            href="/employee-portals/probation"
            icon={ClipboardCheck}
            label="Probation Tracker"
            sub="Monitor probation timelines and risk zones"
          />
          <MarketingToolRow
            href="/employee-portals/organogram"
            icon={Building2}
            label="Organogram"
            sub="Reporting structure and role relationships for your line"
          />
        </div>
      </div>

      {/* Pharmacovigilance */}
      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-4 py-2.5 sm:px-5 sm:py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Pharmacovigilance</h2>
        </div>
        <div className="bg-white">
          <MarketingToolRow
            href="/employee-portals/report-it"
            icon={FileText}
            label="Report It"
            sub="Submit and track adverse drug reaction reports"
          />
        </div>
      </div>

      {totalPending === 0 && (
        <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="text-sm font-medium text-emerald-800">All clear — nothing needs your attention right now.</span>
        </div>
      )}
    </div>
  );
}
