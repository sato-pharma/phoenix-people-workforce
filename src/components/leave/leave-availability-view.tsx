"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CalendarCheck, Clock3, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buildTeamAvailability } from "@/lib/leave/insights";
import type { LeaveRequest, PublicHoliday, TeamAvailabilityDay } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import {
  addDaysIso,
  fieldClassName,
  formatDate,
  MetricCard,
  Panel,
  PanelHeader,
  todayIso,
  uniqueValues,
} from "./leave-ui-primitives";

export function LeaveAvailabilityView({
  holidays,
  initialDays,
  requests,
  title,
}: {
  holidays?: PublicHoliday[];
  initialDays?: TeamAvailabilityDay[];
  requests: LeaveRequest[];
  title: string;
}) {
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(addDaysIso(todayIso(), 14));
  const [line, setLine] = useState("");
  const [area, setArea] = useState("");
  const lines = useMemo(() => uniqueValues(requests, (request) => request.employee?.lineName), [requests]);
  const areas = useMemo(() => uniqueValues(requests, (request) => request.employee?.areaName), [requests]);
  const days = useMemo(() => {
    if (!startDate || !endDate || endDate < startDate) return initialDays ?? [];
    return buildTeamAvailability(requests, holidays ?? [], {
      area: area || undefined,
      endDate,
      line: line || undefined,
      startDate,
    });
  }, [area, endDate, holidays, initialDays, line, requests, startDate]);
  const conflictDays = days.filter((day) => day.conflictCount > 0 || (day.approved.length > 0 && day.pending.length > 0));

  return (
    <Panel>
      <PanelHeader
        description="Availability view is scoped by the server to the current manager hierarchy or HR/Admin access."
        icon={<Users className="h-5 w-5" />}
        title={title}
      />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-4">
          <input className={fieldClassName} onChange={(event) => setStartDate(event.target.value)} type="date" value={startDate} />
          <input className={fieldClassName} min={startDate} onChange={(event) => setEndDate(event.target.value)} type="date" value={endDate} />
          <select className={fieldClassName} onChange={(event) => setLine(event.target.value)} value={line}>
            <option value="">All lines</option>
            {lines.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select className={fieldClassName} onChange={(event) => setArea(event.target.value)} value={area}>
            <option value="">All areas</option>
            {areas.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <MetricCard icon={<CalendarCheck className="h-5 w-5" />} label="Days With Leave" value={days.filter((day) => day.approved.length || day.pending.length).length} />
          <MetricCard icon={<AlertTriangle className="h-5 w-5" />} label="Conflict Days" value={conflictDays.length} />
          <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Pending Items" value={days.reduce((sum, day) => sum + day.pending.length, 0)} />
        </div>

        {days.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm font-semibold text-slate-500">Select a valid date range to review team availability.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {days.filter((day) => day.approved.length || day.pending.length || day.publicHolidays.length).slice(0, 12).map((day) => (
              <div className={cn("rounded-2xl border px-4 py-4", day.conflictCount > 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-white")} key={day.date}>
                <div className="flex items-center justify-between gap-3">
                  <p className="font-black text-slate-950">{formatDate(day.date)}</p>
                  {day.conflictCount > 0 ? <Badge variant="warning">overlap</Badge> : <Badge variant="neutral">available</Badge>}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge variant="success">{day.approved.length} approved</Badge>
                  <Badge variant="warning">{day.pending.length} pending</Badge>
                  <Badge variant="danger">{day.rejected.length} rejected</Badge>
                  {day.publicHolidays.length ? <Badge variant="neutral">{day.publicHolidays.length} holiday</Badge> : null}
                </div>
                <div className="mt-3 space-y-2">
                  {[...day.approved, ...day.pending].slice(0, 5).map((request) => (
                    <p className="rounded-xl bg-white/70 px-3 py-2 text-xs font-bold text-slate-700" key={`${day.date}-${request.id}`}>
                      {request.employee?.fullName ?? request.employeeHrId} - {request.leaveType?.name ?? "Leave"}
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
