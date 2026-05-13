"use client";

import { useMemo } from "react";
import { BarChart3 } from "lucide-react";

import { buildLeaveAnalytics } from "@/lib/leave/insights";
import type { LeaveAnalytics, LeaveRequest, PublicHoliday } from "@/lib/leave/types";

import {
  formatDate,
  MiniBars,
  Panel,
  PanelHeader,
} from "./leave-ui-primitives";

export function LeaveAnalyticsPanel({
  analytics,
  holidays,
  requests,
}: {
  analytics?: LeaveAnalytics;
  holidays?: PublicHoliday[];
  requests: LeaveRequest[];
}) {
  const resolved = useMemo(() => analytics ?? buildLeaveAnalytics(requests, holidays ?? []), [analytics, holidays, requests]);

  return (
    <Panel>
      <PanelHeader
        description="Executive leave analytics for demand, utilization, aging, upcoming absences, and public holiday impact."
        icon={<BarChart3 className="h-5 w-5" />}
        title="Executive Leave Analytics"
      />
      <div className="grid gap-4 p-4 sm:p-5 xl:grid-cols-3" data-testid="leave-admin-analytics">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-4 text-sm font-black text-slate-950">Requests by Status</p>
          <MiniBars rows={resolved.requestsByStatus} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-4 text-sm font-black text-slate-950">Consumption by Month</p>
          <MiniBars rows={resolved.consumptionByMonth} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-4 text-sm font-black text-slate-950">Top Leave Types</p>
          <MiniBars rows={resolved.topLeaveTypes} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-4 text-sm font-black text-slate-950">Highest Usage Lines</p>
          <MiniBars rows={resolved.usageByLine} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-4 text-sm font-black text-slate-950">Pending Approval Aging</p>
          <MiniBars rows={resolved.pendingApprovalAging} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="mb-4 text-sm font-black text-slate-950">Public Holiday Impact</p>
          <MiniBars rows={resolved.publicHolidayImpact} />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4 xl:col-span-3">
          <p className="mb-4 text-sm font-black text-slate-950">Upcoming Approved Leave</p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {resolved.upcomingApprovedLeave.length ? resolved.upcomingApprovedLeave.map((request) => (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3" key={request.id}>
                <p className="truncate text-sm font-black text-slate-900">{request.employee?.fullName ?? request.employeeHrId}</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">{formatDate(request.startDate)} - {formatDate(request.endDate)}</p>
              </div>
            )) : <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500 md:col-span-2 xl:col-span-4">No upcoming approved leave.</p>}
          </div>
        </div>
      </div>
    </Panel>
  );
}
