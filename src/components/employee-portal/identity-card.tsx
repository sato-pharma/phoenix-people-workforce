"use client";

import {
  BriefcaseBusiness,
  CalendarDays,
  MapPin,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import Image from "next/image";

import { formatDateOnly } from "@/lib/date-only";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { formatHrIdForDisplay } from "@/lib/hr-id";

const profileImagesByHrId: Record<string, string> = {
  "A-16": "/images/hr/youmna-kotb.jpg",
  A16: "/images/hr/youmna-kotb.jpg",
  "B-52": "/images/hr/fiby-wagdy-luka.jpg",
};

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

function profileImageForHrId(hrId: string) {
  const normalized = hrId.trim().toUpperCase();
  const compact = normalized.replace(/[^A-Z0-9]/g, "");
  return profileImagesByHrId[normalized] ?? profileImagesByHrId[compact] ?? null;
}

export function IdentityCard({ data }: { data: EmployeePortalShellData }) {
  const employee = data.employee;
  const hiredLabel = prettyDate(data.hrContract.hireDate);
  const statusVariant = asStatus(employee.status);
  const profileImage = profileImageForHrId(employee.hrId);
  const firstName = employee.fullName.split(/\s+/).find(Boolean) ?? "there";
  const displayHrId = formatHrIdForDisplay(employee.hrId) ?? employee.hrId;

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
    <div className="relative overflow-hidden rounded-[30px] border border-white/80 bg-[linear-gradient(135deg,#ffffff_0%,#fff7ed_48%,#eef7fb_100%)] px-5 py-5 shadow-[0_24px_64px_rgba(15,23,42,0.12)] ring-1 ring-slate-200/70 lg:px-8 lg:py-7">
      <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
      <div className="absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.025)_1px,transparent_1px)] bg-[size:34px_34px] opacity-80 [mask-image:linear-gradient(110deg,rgba(0,0,0,0.86),transparent_78%)]" />
      <div className="absolute inset-x-0 bottom-0 h-20 bg-[linear-gradient(0deg,rgba(255,247,237,0.72),rgba(255,247,237,0))]" />

      <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_250px] lg:items-center xl:grid-cols-[minmax(0,1fr)_292px]">
        <div className="min-w-0">
          <div className="mb-4 inline-flex w-fit items-center gap-2 rounded-full border border-orange-200 bg-white/85 px-3 py-1.5 text-[10px] font-black uppercase tracking-normal text-orange-600 shadow-[0_8px_20px_rgba(249,115,22,0.08)]">
            <Sparkles className="h-3.5 w-3.5" />
            Your Phoenix day starts here
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="text-[30px] font-black leading-[1.05] tracking-normal text-slate-950 sm:text-[38px] lg:text-[46px]">
              Hello, {firstName} <span aria-hidden="true">👋🏻</span>
            </h1>
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-normal lg:px-4 lg:text-[13px] ${statusPillClass}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full lg:h-2 lg:w-2 ${statusDotClass} ${statusVariant === "success" ? "animate-pulse" : ""}`} />
              {employee.status}
            </span>
          </div>

          <p className="mt-3 max-w-3xl text-[16px] font-semibold leading-7 text-slate-700 lg:text-[18px]">
            Your Phoenix workspace is ready for a focused, confident day. Keep your priorities clear, follow up with energy, and turn today's work into visible progress.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2 text-slate-500">
            <span className="rounded-full border border-white/80 bg-white/75 px-3 py-1.5 text-sm font-bold shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
              {employee.fullName}
            </span>
            <span className="rounded-full border border-white/80 bg-white/75 px-3 py-1.5 text-sm font-semibold shadow-[0_8px_20px_rgba(15,23,42,0.05)]">
              {employee.roleLabel}
            </span>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="group/item flex items-center gap-2.5 rounded-2xl border border-white/80 bg-white/80 px-3 py-3 shadow-[0_12px_28px_rgba(15,23,42,0.06)]">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-50 text-orange-500 shadow-sm ring-1 ring-orange-100 transition-colors group-hover/item:bg-orange-100">
                <ShieldCheck className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-normal text-slate-400">HR ID</p>
                <p className="truncate text-sm font-black text-slate-800">{displayHrId}</p>
              </div>
            </div>

            <div className="group/item flex items-center gap-2.5 rounded-2xl border border-white/80 bg-white/80 px-3 py-3 shadow-[0_12px_28px_rgba(15,23,42,0.06)]">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600 shadow-sm ring-1 ring-sky-100 transition-colors group-hover/item:bg-sky-100">
                <Users className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-normal text-slate-400">Manager</p>
                <p className="truncate text-sm font-black text-slate-800">{employee.manager ?? "Unassigned"}</p>
              </div>
            </div>

            <div className="group/item flex items-center gap-2.5 rounded-2xl border border-white/80 bg-white/80 px-3 py-3 shadow-[0_12px_28px_rgba(15,23,42,0.06)] sm:col-span-2 lg:col-span-1">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 shadow-sm ring-1 ring-emerald-100 transition-colors group-hover/item:bg-emerald-100">
                <BriefcaseBusiness className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-normal text-slate-400">Mission</p>
                <p className="truncate text-sm font-black text-slate-800">{employee.line ?? "Phoenix"} focus</p>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-white/80 pt-5">
            <div className="flex items-center gap-2 text-slate-500">
              <CalendarDays className="h-4 w-4 text-slate-300" />
              <span className="text-[13px] font-medium">Hired <span className="font-bold text-slate-900">{hiredLabel}</span></span>
            </div>
            <div className="hidden h-4 w-px bg-slate-200 sm:block" />
            <div className="flex items-center gap-2 text-slate-500">
              <MapPin className="h-4 w-4 text-sky-400" />
              <span className="text-[13px] font-medium">{employee.territory ?? "Unassigned Territory"}</span>
            </div>
          </div>
        </div>

        <div className="group relative mx-auto flex h-[236px] w-full max-w-[250px] shrink-0 items-center justify-center rounded-[30px] border border-orange-100 bg-gradient-to-tr from-orange-100/80 via-white to-sky-50 p-2 shadow-[0_24px_54px_rgba(249,115,22,0.20)] sm:h-[286px] sm:max-w-[292px] lg:mx-0 lg:h-[316px]">
          <div className="absolute -inset-1 rounded-[32px] bg-gradient-to-br from-orange-300/45 via-white/0 to-sky-300/35 opacity-80 blur-sm transition-opacity duration-300 group-hover:opacity-100" />
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[24px] bg-white shadow-inner">
            {profileImage ? (
              <Image
                alt={`${employee.fullName} profile photo`}
                className="h-full w-full object-cover object-[center_18%] transition-transform duration-500 group-hover:scale-105"
                height={316}
                priority
                src={profileImage}
                width={292}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
                <span className="text-[44px] font-black tracking-normal lg:text-[56px]">{initials || "EM"}</span>
              </div>
            )}
          </div>
          <div className="absolute -bottom-3 left-4 right-4 flex items-center justify-center gap-2 rounded-2xl border border-white/80 bg-white/95 px-3 py-2 text-[11px] font-black uppercase tracking-normal text-emerald-600 shadow-[0_16px_34px_rgba(15,23,42,0.14)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Phoenix Verified
          </div>
        </div>
      </div>
    </div>
  );
}
