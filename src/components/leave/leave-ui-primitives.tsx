"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { LeaveDurationUnit, LeaveRequest, PublicHoliday } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

export const fieldClassName =
  "h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-500/10";

export const textAreaClassName =
  "min-h-24 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-500/10";

export const buttonClassName =
  "inline-flex h-10 items-center justify-center gap-2 rounded-xl px-4 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-55";

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-[18px] border border-slate-200 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.06)]", className)}>
      {children}
    </section>
  );
}

export function PanelHeader({
  action,
  description,
  icon,
  title,
}: {
  action?: ReactNode;
  description: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div className="flex min-w-0 gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-black tracking-tight text-slate-950">{title}</h2>
          <p className="mt-1 text-sm leading-5 text-slate-500">{description}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SyncedTableContainer({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const [contentWidth, setContentWidth] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const topScroll = topScrollRef.current;
    if (!container || !topScroll) return;

    const syncTop = () => {
      if (topScroll.scrollLeft !== container.scrollLeft) {
        topScroll.scrollLeft = container.scrollLeft;
      }
    };
    const syncBottom = () => {
      if (container.scrollLeft !== topScroll.scrollLeft) {
        container.scrollLeft = topScroll.scrollLeft;
      }
    };

    container.addEventListener("scroll", syncTop);
    topScroll.addEventListener("scroll", syncBottom);

    const updateWidth = () => {
      if (container.firstChild instanceof HTMLElement) {
        setContentWidth(container.firstChild.scrollWidth);
      }
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (container.firstChild instanceof HTMLElement) {
      observer.observe(container.firstChild);
    }

    return () => {
      container.removeEventListener("scroll", syncTop);
      topScroll.removeEventListener("scroll", syncBottom);
      observer.disconnect();
    };
  }, []);

  return (
    <div className="flex flex-col">
      <div
        className="overflow-x-auto overflow-y-hidden border-b border-slate-100 bg-slate-50/50"
        ref={topScrollRef}
        style={{ height: "12px" }}
      >
        <div style={{ height: "1px", width: `${contentWidth}px` }} />
      </div>
      <div className="overflow-x-auto" ref={containerRef}>
        {children}
      </div>
    </div>
  );
}

export function MetricCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-[16px] border border-slate-200 bg-white px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
          <div className="mt-2 text-2xl font-black tracking-tight text-slate-950">{value}</div>
        </div>
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
          {icon}
        </span>
      </div>
    </div>
  );
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-800 shadow-[0_18px_48px_rgba(15,23,42,0.20)]">
      {message}
    </div>
  );
}

export function statusVariant(status: string): "danger" | "neutral" | "success" | "warning" {
  if (status.includes("approved")) return "success";
  if (status.includes("rejected") || status === "cancelled" || status === "blocked") return "danger";
  if (status.includes("pending")) return "warning";
  return "neutral";
}

export function prettyStatus(status: string) {
  return status.replace(/_/g, " ");
}

export function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value.slice(0, 10)}T00:00:00.000Z`));
}

export function holidayDates(holidays?: PublicHoliday[]) {
  const dates: string[] = [];
  for (const holiday of holidays ?? []) {
    const start = new Date(`${holiday.date}T00:00:00.000Z`);
    const end = new Date(`${holiday.endDate ?? holiday.date}T00:00:00.000Z`);
    for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
  }
  return new Set(dates);
}

export function isRenderableLeaveAttachmentReference(reference: string | null | undefined) {
  return Boolean(reference?.startsWith("/uploads/leave/"));
}

export function calculateWorkingDaysPreview(startDate: string, endDate: string, holidays?: PublicHoliday[], weekendDays = [5, 6], durationUnit: LeaveDurationUnit = "full_day") {
  if (!startDate || !endDate || endDate < startDate) return 0;
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (durationUnit !== "full_day" && startDate !== endDate) return 0;
  const weekends = new Set(weekendDays);
  const holidaySet = holidayDates(holidays);
  let total = 0;

  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86400000)) {
    const dateKey = cursor.toISOString().slice(0, 10);
    if (weekends.has(cursor.getUTCDay()) || holidaySet.has(dateKey)) continue;
    total += 1;
  }
  return durationUnit === "full_day" ? total : total > 0 ? 0.5 : 0;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(date: string, days: number) {
  const source = new Date(`${date}T00:00:00.000Z`);
  source.setUTCDate(source.getUTCDate() + days);
  return source.toISOString().slice(0, 10);
}

export function monthName(month: number, year: number) {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);
}

export function uniqueValues(requests: LeaveRequest[], selector: (request: LeaveRequest) => string | null | undefined) {
  return Array.from(new Set(requests.map(selector).filter(Boolean) as string[])).sort();
}

export function MiniBars({
  emptyLabel = "No data available.",
  rows,
}: {
  emptyLabel?: string;
  rows: Array<{ label: string; value: number }>;
}) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  if (!rows.length) {
    return <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm font-semibold text-slate-500">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs font-black">
            <span className="truncate text-slate-700">{row.label}</span>
            <span className="text-slate-950">{compactNumber(row.value)}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-orange-500" style={{ width: `${Math.max(8, (row.value / max) * 100)}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
