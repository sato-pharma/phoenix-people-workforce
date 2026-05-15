"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { CalendarDays, FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { LeaveRequest } from "@/lib/leave/types";

import { LeaveDetailModal } from "./leave-detail-modal";
import {
  formatDate,
  Panel,
  PanelHeader,
  prettyStatus,
  statusVariant,
  SyncedTableContainer,
} from "./leave-ui-primitives";

function paymentStatusLabel(status: LeaveRequest["paymentStatus"]) {
  if (status === "paid") return "Paid";
  if (status === "unpaid") return "Unpaid";
  if (status === "non_deducted") return "Non-Deducted";
  return "In Review";
}

export function LeaveRequestHistory({
  actions,
  detailActions,
  requests,
  title = "Leave Requests",
}: {
  actions?: (request: LeaveRequest) => ReactNode;
  detailActions?: (request: LeaveRequest) => ReactNode;
  requests: LeaveRequest[];
  title?: string;
}) {
  const [selected, setSelected] = useState<LeaveRequest | null>(null);

  return (
    <>
      <Panel className="overflow-hidden">
        <PanelHeader
          description={`${requests.length} request${requests.length === 1 ? "" : "s"} in the current view.`}
          icon={<FileText className="h-5 w-5" />}
          title={title}
        />
        {requests.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
              <CalendarDays className="h-5 w-5" />
            </div>
            <p className="mt-4 text-base font-black text-slate-950">No leave requests found.</p>
            <p className="mt-1 text-sm text-slate-500">Submitted leave requests will appear here.</p>
          </div>
        ) : (
          <SyncedTableContainer>
            <table className="w-full min-w-[1180px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
                  {["Request Date", "Employee", "Leave Type", "From", "To", "Duration", "Payment", "Status", "Manager", "HR", "Updated", "Actions"].map((column) => (
                    <th className="px-4 py-3" key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {requests.map((request) => (
                  <tr className="transition hover:bg-slate-50/70" key={request.id}>
                    <td className="px-4 py-4 font-semibold text-slate-600">{formatDate(request.requestedAt)}</td>
                    <td className="px-4 py-4">
                      <p className="font-black text-slate-950">{request.employee?.fullName ?? request.employeeHrId}</p>
                      <p className="mt-1 font-mono text-xs text-slate-500">{request.employeeHrId}</p>
                    </td>
                    <td className="px-4 py-4 font-semibold text-slate-700">{request.leaveType?.name ?? "Leave"}</td>
                    <td className="px-4 py-4 text-slate-600">{formatDate(request.startDate)}</td>
                    <td className="px-4 py-4 text-slate-600">{formatDate(request.endDate)}</td>
                    <td className="px-4 py-4 font-black text-slate-950">{request.totalWorkingDays} <span className="text-xs font-bold text-slate-500">{request.durationUnit === "full_day" ? "" : request.durationUnit.toUpperCase()}</span></td>
                    <td className="px-4 py-4"><Badge variant={request.paymentStatus === "unpaid" ? "danger" : request.paymentStatus === "paid" ? "success" : "warning"}>{paymentStatusLabel(request.paymentStatus)}</Badge></td>
                    <td className="px-4 py-4"><Badge variant={statusVariant(request.status)}>{prettyStatus(request.status)}</Badge></td>
                    <td className="px-4 py-4"><Badge variant={statusVariant(request.managerStatus)}>{prettyStatus(request.managerStatus)}</Badge></td>
                    <td className="px-4 py-4"><Badge variant={statusVariant(request.hrStatus)}>{prettyStatus(request.hrStatus)}</Badge></td>
                    <td className="px-4 py-4 text-slate-600">{formatDate(request.updatedAt)}</td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-700 hover:bg-white" onClick={() => setSelected(request)} type="button">
                          View
                        </button>
                        {actions?.(request)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SyncedTableContainer>
        )}
      </Panel>
      <LeaveDetailModal actions={selected ? detailActions?.(selected) : null} onClose={() => setSelected(null)} request={selected} />
    </>
  );
}
