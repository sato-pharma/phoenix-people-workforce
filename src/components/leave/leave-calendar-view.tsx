"use client";

import { useMemo, useState } from "react";
import { CalendarRange } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buildLeaveCalendarItems } from "@/lib/leave/insights";
import type { LeaveCalendarItem, LeaveRequest, PublicHoliday } from "@/lib/leave/types";

import {
  fieldClassName,
  formatDate,
  monthName,
  Panel,
  PanelHeader,
  prettyStatus,
  statusVariant,
  uniqueValues,
} from "./leave-ui-primitives";

function shiftPeriod(period: { month: number; year: number }, delta: number) {
  const date = new Date(Date.UTC(period.year, period.month - 1 + delta, 1));
  return { month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
}

export function LeaveCalendarView({
  holidays,
  initialItems,
  requests,
  title,
}: {
  holidays?: PublicHoliday[];
  initialItems?: LeaveCalendarItem[];
  requests: LeaveRequest[];
  title: string;
}) {
  const now = new Date();
  const [period, setPeriod] = useState({ month: now.getUTCMonth() + 1, year: now.getUTCFullYear() });
  const [employeeHrId, setEmployeeHrId] = useState("");
  const [line, setLine] = useState("");
  const [status, setStatus] = useState("");
  const lines = useMemo(() => uniqueValues(requests, (request) => request.employee?.lineName), [requests]);
  const employees = useMemo(() => {
    const map = new Map<string, string>();
    for (const request of requests) {
      map.set(request.employeeHrId, request.employee?.fullName ?? request.employeeHrId);
    }
    return Array.from(map.entries()).sort((left, right) => left[1].localeCompare(right[1]));
  }, [requests]);
  const items = useMemo(() => buildLeaveCalendarItems(requests, holidays ?? [], {
    employeeHrId: employeeHrId || undefined,
    line: line || undefined,
    month: period.month,
    status: status || undefined,
    year: period.year,
  }), [employeeHrId, holidays, line, period.month, period.year, requests, status]);
  const displayItems = items.length ? items : initialItems?.filter((item) => item.startDate.slice(0, 7) === `${period.year}-${String(period.month).padStart(2, "0")}`) ?? [];

  return (
    <Panel>
      <PanelHeader
        action={
          <div className="flex items-center gap-2">
            <button className="h-9 rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-700 hover:bg-slate-50" onClick={() => setPeriod((current) => shiftPeriod(current, -1))} type="button">Prev</button>
            <button className="h-9 rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-700 hover:bg-slate-50" onClick={() => setPeriod((current) => shiftPeriod(current, 1))} type="button">Next</button>
          </div>
        }
        description="Month timeline with approved, pending, rejected, and national vacation entries."
        icon={<CalendarRange className="h-5 w-5" />}
        title={title}
      />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[1fr_180px_180px_180px]">
          <div className="rounded-2xl border border-orange-100 bg-orange-50 px-4 py-3">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-orange-700">Calendar Period</p>
            <p className="mt-1 text-lg font-black text-slate-950">{monthName(period.month, period.year)}</p>
          </div>
          <select className={fieldClassName} onChange={(event) => setEmployeeHrId(event.target.value)} value={employeeHrId}>
            <option value="">All employees</option>
            {employees.map(([hrId, name]) => <option key={hrId} value={hrId}>{name}</option>)}
          </select>
          <select className={fieldClassName} onChange={(event) => setLine(event.target.value)} value={line}>
            <option value="">All teams / lines</option>
            {lines.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className={fieldClassName} onChange={(event) => setStatus(event.target.value)} value={status}>
            <option value="">All statuses</option>
            {["hr_approved", "pending_manager", "pending_hr", "manager_rejected", "hr_rejected", "cancelled"].map((item) => <option key={item} value={item}>{prettyStatus(item)}</option>)}
          </select>
        </div>

        {displayItems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm font-semibold text-slate-500">No leave or national vacation entries for this view.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {displayItems.map((item) => (
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]" key={item.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-950">{item.title}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{formatDate(item.startDate)} - {formatDate(item.endDate)}</p>
                  </div>
                  <Badge variant={item.kind === "holiday" ? "neutral" : statusVariant(item.status)}>{item.kind === "holiday" ? "national vacation" : prettyStatus(item.status)}</Badge>
                </div>
                {item.kind === "request" ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold text-slate-600">
                    <span className="rounded-xl bg-slate-50 px-3 py-2">{item.leaveTypeName}</span>
                    <span className="rounded-xl bg-slate-50 px-3 py-2">{item.totalWorkingDays} day{item.totalWorkingDays === 1 ? "" : "s"}</span>
                    <span className="rounded-xl bg-slate-50 px-3 py-2">{item.lineName ?? "No line"}</span>
                    <span className="rounded-xl bg-slate-50 px-3 py-2">{item.areaName ?? "No area"}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
