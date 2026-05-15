import { CalendarDays, ScrollText, ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import { AppShell } from "@/components/layout/app-shell";
import { AdminLeaveManagementWorkspace } from "@/components/leave/leave-workspaces";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getAdminLeaveWorkspace } from "@/lib/leave/service";
import type { LeaveRequestFilters } from "@/lib/leave/types";

export const dynamic = "force-dynamic";

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(searchParams: Record<string, string | string[] | undefined>): LeaveRequestFilters {
  const month = firstValue(searchParams.month);
  const year = firstValue(searchParams.year);
  return {
    area: firstValue(searchParams.area),
    employee: firstValue(searchParams.employee),
    employeeHrId: firstValue(searchParams.employeeHrId),
    endDate: firstValue(searchParams.endDate),
    leaveTypeId: firstValue(searchParams.leaveTypeId),
    line: firstValue(searchParams.line),
    managerHrId: firstValue(searchParams.managerHrId),
    month: month ? Number(month) : undefined,
    paymentStatus: firstValue(searchParams.paymentStatus),
    startDate: firstValue(searchParams.startDate),
    status: firstValue(searchParams.status),
    year: year ? Number(year) : undefined,
  };
}

export default async function AdminLeavePage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "leave", "read"))) {
    redirect("/employee-portals/leave");
  }

  const searchParams = await props.searchParams;
  const filters = parseFilters(searchParams);
  const section = firstValue(searchParams.section);
  const viewMode = section === "request" || section === "reports" ? section : "management";
  const data = await getAdminLeaveWorkspace(access, filters);

  return (
    <AppShell navigationMode="admin">
      <div className="space-y-6">
        <AdminPageHero
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Leave Engine</AdminInsightChip>
              <AdminInsightChip tone="orange">Ledger-backed balances</AdminInsightChip>
              <AdminInsightChip tone="slate">Egypt Annual Policy</AdminInsightChip>
            </div>
          }
          description={
            viewMode === "request"
              ? "Submit and track your own vacation request as the linked employee."
              : viewMode === "reports"
                ? "Review vacation reports without the request form mixed into the reporting screen."
                : "Review leave demand, approve HR decisions, manage policy settings, national vacations, and audited balance adjustments."
          }
          eyebrow="People Operations"
          icon={<CalendarDays className="h-3.5 w-3.5" />}
          title={viewMode === "request" ? "Vacation Request" : viewMode === "reports" ? "Vacation Reports" : "Leave Management"}
          actions={(
            <div className="flex flex-wrap gap-2">
              <a
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-orange-200 bg-orange-50 px-4 text-sm font-black text-orange-700 shadow-sm transition hover:bg-orange-100"
                href="/admin/logs?module=leave"
              >
                <ScrollText className="h-4 w-4" />
                View Audit Trail
              </a>
              {data.capabilities?.canExport ? (
                <a
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-black text-slate-800 shadow-sm transition hover:bg-slate-50"
                  href="/api/leave/export"
                >
                  <ShieldCheck className="h-4 w-4 text-orange-600" />
                  Export Report
                </a>
              ) : null}
            </div>
          )}
        />
        <AdminLeaveManagementWorkspace
          {...data}
          defaultManagementTab={viewMode === "management" ? "accrual" : undefined}
          defaultVacationTab={viewMode === "reports" ? "company" : undefined}
          key={`admin-leave-${section ?? "default"}`}
          viewMode={viewMode}
        />
      </div>
    </AppShell>
  );
}
