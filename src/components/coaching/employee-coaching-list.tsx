import Link from "next/link";
import { ArrowUpRight, CalendarDays, ClipboardCheck, UserRound } from "lucide-react";

import { Card } from "@/components/ui/card";
import type {
  CoachingPerformanceZone,
  CoachingReportStatus,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import { cn } from "@/lib/utils";

type EmployeeCoachingListProps = {
  reports: CoachingReportSummaryRow[];
};

const zoneLabels: Record<CoachingPerformanceZone, string> = {
  critical_red: "Red Zone / Below Expectations",
  excellence_zone: "Excellence Zone / Exceeds Expectations",
  green_zone: "Green Zone / Meets Expectations",
  red_zone: "Red Zone / Below Expectations",
  yellow_zone: "Yellow Zone / Needs Improvement",
};

const zoneClassNames: Record<CoachingPerformanceZone, string> = {
  critical_red: "border-rose-200 bg-rose-50 text-rose-700",
  excellence_zone: "border-amber-200 bg-amber-50 text-amber-800",
  green_zone: "border-emerald-200 bg-emerald-50 text-emerald-700",
  red_zone: "border-rose-200 bg-rose-50 text-rose-700",
  yellow_zone: "border-orange-200 bg-orange-50 text-orange-700",
};

const statusLabels: Record<CoachingReportStatus, string> = {
  cancelled: "Cancelled",
  draft: "Draft",
  locked: "Locked",
  reviewed_by_employee: "Reviewed by Employee",
  submitted: "Submitted",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatPercent(value: number) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function ZoneBadge({ zone }: { zone: CoachingPerformanceZone | null }) {
  if (!zone) {
    return (
      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-black text-slate-600">
        Not scored
      </span>
    );
  }

  return (
    <span className={cn("rounded-full border px-3 py-1 text-xs font-black", zoneClassNames[zone])}>
      {zoneLabels[zone]}
    </span>
  );
}

export function EmployeeCoachingList({ reports }: EmployeeCoachingListProps) {
  if (reports.length === 0) {
    return (
      <Card className="rounded-[30px] border border-white/75 bg-white/95 p-8 text-center shadow-[0_24px_70px_rgba(15,23,42,0.10)] ring-1 ring-slate-900/5">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-500">
          <ClipboardCheck className="h-5 w-5" />
        </div>
        <p className="mt-4 text-lg font-semibold text-slate-900">No coaching reports are available yet.</p>
        <p className="mt-2 text-sm text-slate-600">
          Submitted field coaching reports will appear here once your coach publishes them.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {reports.map((report) => (
        <Card
          className="group overflow-hidden rounded-[30px] border border-white/75 bg-white/95 p-4 shadow-[0_24px_70px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5 transition hover:-translate-y-0.5 hover:shadow-[0_30px_80px_rgba(15,23,42,0.12)] sm:p-5"
          key={report.reportId}
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-black uppercase tracking-[0.14em] text-orange-700">
                  {report.reportNumber}
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-black text-slate-600">
                  {statusLabels[report.status] ?? report.status}
                </span>
                <span
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-black",
                    report.acknowledged
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-slate-50 text-slate-600",
                  )}
                >
                  {report.acknowledged ? "Acknowledged" : "Pending acknowledgment"}
                </span>
              </div>

              <div>
                <h2 className="text-xl font-black tracking-[-0.03em] text-slate-950">
                  Field coaching review
                </h2>
                <div className="mt-3 grid gap-3 text-sm text-slate-600 sm:grid-cols-2 xl:grid-cols-4">
                  <span className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2">
                    <CalendarDays className="h-4 w-4 text-orange-500" />
                    {formatDate(report.coachingDate)}
                  </span>
                  <span className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2">
                    <UserRound className="h-4 w-4 text-orange-500" />
                    {report.coachName || "Coach"}
                  </span>
                  <span className="rounded-2xl border border-slate-100 bg-slate-50/80 px-3 py-2 font-black text-slate-900">
                    {formatPercent(report.finalScorePercent)}
                  </span>
                  <span className="flex items-center">
                    <ZoneBadge zone={report.performanceZone} />
                  </span>
                </div>
              </div>
            </div>

            <Link
              className="inline-flex items-center justify-center gap-2 rounded-full bg-slate-950 px-4 py-2.5 text-sm font-black text-white shadow-[0_18px_40px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 hover:bg-orange-600"
              href={`/employee-portals/coaching/${report.reportId}`}
            >
              Review Report
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </div>
        </Card>
      ))}
    </div>
  );
}
