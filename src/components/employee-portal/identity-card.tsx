"use client";

import {
  BriefcaseBusiness,
  CalendarDays,
  MapPin,
  ShieldCheck,
  Users,
} from "lucide-react";

import { formatDateOnly } from "@/lib/date-only";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";

function prettyDate(value: string | null) {
  return formatDateOnly(value, "en-GB", { day: "2-digit", month: "short", year: "numeric" }, "Not available");
}

function asStatus(value: string): "success" | "warning" | "danger" | "neutral" {
  const normalized = value.toLowerCase();
  if (normalized.includes("active") || normalized.includes("approved") || normalized.includes("locked")) {
    return "success";
  }
  if (normalized.includes("pending") || normalized.includes("review")) return "warning";
  if (normalized.includes("rejected") || normalized.includes("terminated")) return "danger";
  return "neutral";
}

export function IdentityCard({ data }: { data: EmployeePortalShellData }) {
  const employee = data.employee;
  const hiredLabel = prettyDate(data.hrContract.hireDate);
  const statusVariant = asStatus(employee.status);

  const statusPillClass =
    statusVariant === "success"
      ? "border-emerald-200/50 bg-emerald-50/50 text-emerald-600 shadow-sm"
      : statusVariant === "warning"
        ? "border-amber-200/50 bg-amber-50/50 text-amber-700 shadow-sm"
        : statusVariant === "danger"
          ? "border-rose-200/50 bg-rose-50/50 text-rose-700 shadow-sm"
          : "border-slate-200/50 bg-slate-50/50 text-slate-600 shadow-sm";

  const statusDotClass =
    statusVariant === "success"
      ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.1)]"
      : statusVariant === "warning"
        ? "bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.1)]"
        : statusVariant === "danger"
          ? "bg-rose-500 shadow-[0_0_0_4px_rgba(244,63,94,0.1)]"
          : "bg-slate-500 shadow-[0_0_0_4px_rgba(100,116,139,0.1)]";

  const initials = employee.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  return (
    <div className="relative overflow-hidden rounded-[30px] border border-white/80 bg-[linear-gradient(135deg,#ffffff_0%,#ffffff_48%,#f8fafc_100%)] px-5 py-5 shadow-[0_18px_48px_rgba(15,23,42,0.08)] ring-1 ring-slate-200/70 lg:px-10 lg:py-8">
      <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.025)_1px,transparent_1px)] bg-[size:34px_34px] opacity-70 [mask-image:linear-gradient(110deg,rgba(0,0,0,0.85),transparent_76%)]" />

      <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center">
        <div className="group relative flex h-[90px] w-[90px] shrink-0 items-center justify-center rounded-full border border-orange-100 bg-gradient-to-tr from-orange-50/80 to-white p-1.5 shadow-[0_14px_34px_rgba(249,115,22,0.12)] lg:h-[124px] lg:w-[124px]">
          <div className="flex h-full w-full items-center justify-center rounded-full bg-white shadow-inner">
            <div className="flex h-full w-full items-center justify-center rounded-full bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
              <span className="text-[28px] font-black tracking-tight lg:text-[40px]">{initials || "EM"}</span>
            </div>
          </div>
          <div className="absolute bottom-1 right-1 h-4 w-4 rounded-full border-4 border-white bg-emerald-500 shadow-sm lg:h-6 lg:w-6" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="text-[24px] font-black leading-tight tracking-tight text-slate-950 lg:text-[32px]">
              {employee.fullName}
            </h1>
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider lg:px-4 lg:text-[13px] ${statusPillClass}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full lg:h-2 lg:w-2 ${statusDotClass} ${statusVariant === "success" ? "animate-pulse" : ""}`} />
              {employee.status}
            </span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-2 text-slate-400">
            <p className="text-[14px] font-semibold tracking-tight lg:text-[16px]">{employee.roleLabel}</p>
            <span className="h-1 w-1 rounded-full bg-slate-200" />
            <p className="text-[13px] font-medium tabular-nums lg:text-[14px]">HR ID: {employee.hrId}</p>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:mt-6">
            <div className="flex items-center gap-2.5 group/item">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-orange-500 shadow-sm ring-1 ring-slate-200 transition-colors group-hover/item:bg-orange-50">
                <BriefcaseBusiness className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Business Line</p>
                <p className="truncate text-sm font-bold text-slate-700">{employee.line ?? "Unassigned"}</p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 group/item">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-orange-500 shadow-sm ring-1 ring-slate-200 transition-colors group-hover/item:bg-orange-50">
                <MapPin className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Territory</p>
                <p className="truncate text-sm font-bold text-slate-700">{employee.territory ?? "Unassigned"}</p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 group/item">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-orange-500 shadow-sm ring-1 ring-slate-200 transition-colors group-hover/item:bg-orange-50">
                <Users className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Direct Manager</p>
                <p className="truncate text-sm font-bold text-slate-700">{employee.manager ?? "Unassigned"}</p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-5">
            <div className="flex items-center gap-2 text-slate-500">
              <CalendarDays className="h-4 w-4 text-slate-300" />
              <span className="text-[13px] font-medium">Hired <span className="font-bold text-slate-900">{hiredLabel}</span></span>
            </div>
            <div className="hidden h-4 w-px bg-slate-200 sm:block" />
            <div className="flex items-center gap-2 text-slate-500">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span className="text-[13px] font-medium">Verified Profile</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
