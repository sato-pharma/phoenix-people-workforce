"use client";

import {
  BriefcaseBusiness,
  CalendarDays,
  Flame,
  MapPin,
  ShieldCheck,
  Users,
} from "lucide-react";
import Image from "next/image";

import { formatDateOnly } from "@/lib/date-only";
import type { EmployeePortalShellData } from "@/lib/employee-portal/service";
import { employeeProfileImageForHrId } from "@/lib/employees/profile-images";
import { formatHrIdForDisplay } from "@/lib/hr-id";

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
  // An uploaded photo (served via the same-origin route) wins over the bundled static photo.
  const uploadedPhoto = employee.photoUrl ?? null;
  const staticPhoto = employeeProfileImageForHrId(employee.hrId);
  const profileImage = uploadedPhoto ?? staticPhoto;
  const usesUploadedPhoto = Boolean(uploadedPhoto && profileImage === uploadedPhoto);
  const firstName = employee.fullName.split(/\s+/).find(Boolean) ?? "there";
  const displayHrId = formatHrIdForDisplay(employee.hrId) ?? employee.hrId;

  const statusPillClass =
    statusVariant === "success"
      ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100 shadow-sm"
      : statusVariant === "warning"
        ? "border-amber-300/25 bg-amber-400/10 text-amber-100 shadow-sm"
        : statusVariant === "danger"
          ? "border-rose-300/25 bg-rose-400/10 text-rose-100 shadow-sm"
          : "border-white/15 bg-white/10 text-slate-100 shadow-sm";

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
    <div className="relative overflow-hidden rounded border border-slate-950 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] px-5 py-5 shadow-[0_22px_70px_rgba(15,23,42,0.32)] lg:px-8 lg:py-7">
      <div className="absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.18)_1px,transparent_1px)] [background-size:44px_44px]" />
      <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-orange-500/20 blur-3xl" />
      <div className="absolute -bottom-28 left-8 h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />

      <div className="relative grid gap-6 md:grid-cols-[minmax(0,1fr)_230px] md:items-center lg:grid-cols-[minmax(0,1fr)_250px] xl:grid-cols-[minmax(0,1fr)_292px]">
        <div className="min-w-0">
          <div className="mb-4 inline-flex w-fit items-center gap-2 rounded border border-orange-400/25 bg-orange-500/10 px-3.5 py-1.5 text-[10px] font-black uppercase tracking-[0.20em] text-orange-100">
            <Flame className="h-3 w-3" />
            Your Phoenix day starts here
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="break-words text-[30px] font-black leading-[1.05] tracking-[-0.04em] text-white sm:text-[38px] lg:text-[44px]">
              Hello, {firstName} <span aria-hidden="true">👋🏻</span>
            </h1>
            <span className={`inline-flex items-center gap-2 break-words rounded-none border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] lg:px-4 lg:text-[13px] ${statusPillClass}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full lg:h-2 lg:w-2 ${statusDotClass} ${statusVariant === "success" ? "animate-pulse" : ""}`} />
              {employee.status}
            </span>
          </div>

          <p className="mt-3 max-w-3xl text-[15px] leading-[1.80] text-slate-300 lg:text-[15.5px]">
            Your Phoenix workspace is ready for a focused, confident day. Keep your priorities clear, follow up with energy, and turn today&apos;s work into visible progress.
          </p>

          <div className="mt-5 grid w-full max-w-3xl grid-cols-1 gap-2 text-slate-300 sm:grid-cols-2 lg:grid-cols-4">
            <span className="flex min-h-9 w-full min-w-0 items-center border border-white/10 bg-white/10 px-3.5 py-2 text-[12px] font-bold leading-snug text-white shadow-sm backdrop-blur lg:text-[13px]">
              <span className="min-w-0 break-words">{employee.fullName}</span>
            </span>
            <span className="flex min-h-9 w-full min-w-0 items-center border border-white/10 bg-white/10 px-3.5 py-2 text-[12px] font-medium leading-snug text-slate-200 shadow-sm backdrop-blur lg:text-[13px]">
              <span className="min-w-0 break-words">{employee.roleLabel}</span>
            </span>
            <span className="flex min-h-9 w-full min-w-0 items-center gap-2 border border-white/10 bg-white/10 px-3.5 py-2 text-[12px] font-medium leading-snug text-slate-200 shadow-sm backdrop-blur lg:text-[13px]">
              <CalendarDays className="h-3.5 w-3.5 shrink-0 text-orange-200" />
              <span className="min-w-0 break-words">Hired {hiredLabel}</span>
            </span>
            <span className="flex min-h-9 w-full min-w-0 items-center gap-2 border border-orange-300/25 bg-orange-500/10 px-3.5 py-2 text-[12px] font-medium leading-snug text-orange-100 shadow-sm backdrop-blur lg:text-[13px]">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-orange-200" />
              <span className="min-w-0 break-words">HR ID {displayHrId}</span>
            </span>
          </div>

          <div className="mt-2 grid w-full max-w-3xl grid-cols-1 gap-2 text-slate-300 sm:grid-cols-3">
            <span className="flex min-h-9 w-full min-w-0 items-center gap-2 border border-white/10 bg-white/10 px-3.5 py-2 text-[12px] font-medium leading-snug text-slate-200 shadow-sm backdrop-blur lg:text-[13px]">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-orange-200" />
              <span className="min-w-0 break-words">{employee.area ?? "Unassigned"}</span>
            </span>
            <span className="flex min-h-9 w-full min-w-0 items-center gap-2 border border-white/10 bg-white/10 px-3.5 py-2 text-[12px] font-medium leading-snug text-slate-200 shadow-sm backdrop-blur lg:text-[13px]">
              <Users className="h-3.5 w-3.5 shrink-0 text-sky-200" />
              <span className="min-w-0 break-words">{employee.manager ?? "Unassigned"}</span>
            </span>
            <span className="flex min-h-9 w-full min-w-0 items-center gap-2 border border-white/10 bg-white/10 px-3.5 py-2 text-[12px] font-medium leading-snug text-slate-200 shadow-sm backdrop-blur lg:text-[13px]">
              <BriefcaseBusiness className="h-3.5 w-3.5 shrink-0 text-emerald-200" />
              <span className="min-w-0 break-words">{employee.line ?? "Phoenix"}</span>
            </span>
          </div>

        </div>

        <div className="group relative mx-auto flex h-[220px] w-full max-w-[230px] shrink-0 items-center justify-center rounded border border-orange-300/25 bg-gradient-to-tr from-orange-500/20 via-white/10 to-sky-500/20 p-2 shadow-[0_24px_54px_rgba(0,0,0,0.24)] sm:h-[260px] sm:max-w-[260px] md:mx-0 md:h-[268px] md:max-w-[230px] lg:h-[316px] lg:max-w-[250px] xl:max-w-[292px]">
          <div className="absolute -inset-1 rounded bg-gradient-to-br from-orange-300/35 via-white/0 to-sky-300/30 opacity-80 blur-sm transition-opacity duration-300 group-hover:opacity-100" />
          <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded bg-white/95 shadow-inner">
            {profileImage ? (
              <Image
                alt={`${employee.fullName} profile photo`}
                className="h-full w-full object-cover object-[center_18%] transition-transform duration-500 group-hover:scale-105"
                height={316}
                priority
                src={profileImage}
                unoptimized={usesUploadedPhoto}
                width={292}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-orange-500/10 text-orange-500 transition-transform duration-500 group-hover:scale-105">
                <span className="text-[44px] font-black tracking-normal lg:text-[56px]">{initials || "EM"}</span>
              </div>
            )}
          </div>
          <div className="absolute -bottom-3 left-4 right-4 flex items-center justify-center gap-2 rounded border border-white/70 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.14em] text-emerald-700 shadow-[0_16px_34px_rgba(15,23,42,0.18)]">
            <ShieldCheck className="h-3.5 w-3.5" />
            Phoenix Verified
          </div>
        </div>
      </div>
    </div>
  );
}
