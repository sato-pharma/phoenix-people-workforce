"use client";

import {
  BriefcaseBusiness,
  CalendarDays,
  IdCard,
  MapPin,
  ShieldCheck,
} from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";

export type PhoenixIdentityCardEmployee = {
  department: string;
  employeeId: string;
  fullName: string;
  hrId?: string;
  joinDate: string;
  location: string;
  photoUrl?: string | null;
  signatureName?: string;
  title: string;
  verified?: boolean;
};

type PhoenixIdentityCardProps = {
  employee: PhoenixIdentityCardEmployee;
  unoptimizedPhoto?: boolean;
};

export function PhoenixIdentityCard({ employee, unoptimizedPhoto = false }: PhoenixIdentityCardProps) {
  const initials = employee.fullName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  return (
    <section className="relative overflow-hidden rounded-[28px] border border-slate-200 bg-white px-5 pb-20 pt-5 text-slate-950 shadow-[0_24px_70px_rgba(15,23,42,0.22)] sm:px-8 sm:pb-24 sm:pt-7 lg:min-h-[390px] lg:px-10 lg:pb-24 lg:pt-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_72%_30%,rgba(15,23,42,0.06),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.98),rgba(248,250,252,0.98)_62%,rgba(255,255,255,0.92))]" />
      <Image
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute right-4 top-24 hidden h-64 w-64 object-contain opacity-[0.045] grayscale lg:block xl:right-10"
        height={320}
        src="/brand/phoenix-main-logo.png"
        width={320}
      />

      <div className="absolute bottom-0 left-0 right-0 h-16 bg-[#111827] sm:h-20 lg:h-[72px]" />
      <div className="absolute bottom-[50px] left-[-5%] h-9 w-[115%] -rotate-2 rounded-[50%] bg-orange-500 sm:bottom-[62px] lg:bottom-[56px]" />
      <div className="absolute bottom-[42px] left-[-4%] h-6 w-[112%] -rotate-1 rounded-[50%] bg-[#111827] sm:bottom-[52px] lg:bottom-[46px]" />
      <div className="absolute bottom-[66px] left-[-8%] h-px w-[118%] -rotate-2 bg-orange-500/70 sm:bottom-[80px] lg:bottom-[72px]" />

      <div className="relative z-10 flex flex-col gap-7 lg:gap-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-4">
            <Image
              alt="Phoenix Workforce"
              className="h-16 w-16 shrink-0 object-contain sm:h-20 sm:w-20"
              height={96}
              priority
              src="/brand/phoenix-main-logo.png"
              width={96}
            />
            <div>
              <p className="text-[22px] font-black uppercase leading-none tracking-[0.28em] text-slate-950 sm:text-[27px]">
                Phoenix
              </p>
              <p className="mt-2 text-[15px] font-black uppercase leading-none tracking-[0.30em] text-orange-600 sm:text-[18px]">
                Workforce
              </p>
            </div>
          </div>
          {employee.verified ? (
            <div className="inline-flex w-fit items-center gap-3 rounded-full bg-[#111827] px-5 py-3 text-[12px] font-black uppercase tracking-[0.18em] text-white shadow-[0_14px_28px_rgba(15,23,42,0.22)] sm:self-start sm:px-6 sm:text-[13px]">
              <ShieldCheck className="h-5 w-5" />
              Phoenix Verified
            </div>
          ) : null}
        </div>

        <div className="relative grid gap-7 lg:grid-cols-[286px_minmax(0,1fr)] lg:items-start xl:grid-cols-[300px_minmax(0,1fr)]">
          <div className="relative mx-auto flex h-[285px] w-full max-w-[260px] items-center justify-center overflow-hidden rounded-[22px] border-[3px] border-orange-500 bg-white shadow-[0_18px_32px_rgba(15,23,42,0.10)] sm:h-[330px] sm:max-w-[300px] lg:mx-0 lg:h-[286px] lg:max-w-[248px] xl:h-[304px] xl:max-w-[264px]">
            {employee.photoUrl ? (
              <Image
                alt={`${employee.fullName} profile photo`}
                className="h-full w-full object-cover object-[center_18%]"
                height={360}
                priority
                src={employee.photoUrl}
                unoptimized={unoptimizedPhoto}
                width={320}
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-orange-50 text-orange-600">
                <span className="text-[52px] font-black tracking-normal">{initials || "EM"}</span>
              </div>
            )}
          </div>

          <div className="min-w-0 lg:pt-4">
            <div className="max-w-[620px]">
              <h1 className="text-[32px] font-black leading-[1.02] tracking-[-0.04em] text-[#111827] sm:text-[40px] lg:text-[38px] xl:text-[42px]">
                {employee.fullName}
              </h1>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <p className="text-[14px] font-black uppercase tracking-[0.24em] text-orange-600 sm:text-[17px]">
                  {employee.title}
                </p>
                <span className="hidden h-px flex-1 bg-gradient-to-r from-orange-500/70 via-slate-300/70 to-transparent sm:block" />
              </div>
            </div>

            <dl className="mt-5 max-w-[560px] overflow-hidden rounded-[18px] border border-slate-200/90 bg-white/80 shadow-[0_18px_36px_rgba(15,23,42,0.08)] ring-1 ring-white/80 backdrop-blur">
              <IdentityLine className="border-b border-slate-200/80" icon={<IdCard className="h-[18px] w-[18px]" />} label="Employee ID" value={employee.employeeId} />
              <IdentityLine className="border-b border-slate-200/80" icon={<CalendarDays className="h-[18px] w-[18px]" />} label="Join Date" value={employee.joinDate} />
              <IdentityLine className="border-b border-slate-200/80" icon={<BriefcaseBusiness className="h-[18px] w-[18px]" />} label="Department" value={employee.department} />
              <IdentityLine icon={<MapPin className="h-[18px] w-[18px]" />} label="Location" value={employee.location} />
            </dl>
          </div>
        </div>
      </div>
    </section>
  );
}

function IdentityLine({
  className = "",
  icon,
  label,
  value,
}: {
  className?: string;
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className={`grid min-w-0 grid-cols-[38px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-3.5 py-3 sm:grid-cols-[40px_148px_minmax(120px,1fr)] sm:px-4 sm:py-3.5 ${className}`}>
      <dt className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-slate-200 bg-slate-50 text-slate-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
        {icon}
      </dt>
      <dt className="min-w-0 text-[11px] font-black uppercase tracking-[0.20em] text-slate-500 sm:text-[12px]">
        {label}
      </dt>
      <dd className="col-start-2 min-w-0 break-words text-[17px] font-black leading-tight text-[#111827] sm:col-start-auto sm:text-[18px]">{value}</dd>
    </div>
  );
}
