import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, CircleDashed } from "lucide-react";
import { Card } from "@/components/ui/card";

type EmployeePortalPageShellProps = {
  badge?: string;
  children: ReactNode;
  description: string;
  title: string;
};

export function EmployeePortalPageShell({
  badge,
  children,
  description,
  title,
}: EmployeePortalPageShellProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-slate-50 via-blue-50 to-white">
      {/* Premium background elements */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -right-40 -top-40 h-96 w-96 rounded-full bg-orange-400/10 blur-3xl" />
        <div className="absolute -left-40 bottom-0 h-96 w-96 rounded-full bg-blue-400/8 blur-3xl" />
        <div className="absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-300/5 blur-2xl" />
      </div>

      <div className="relative space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        {/* Premium Header Section */}
        <section className="group relative overflow-hidden rounded-3xl border border-white/40 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8 text-white shadow-[0_20px_60px_rgba(15,23,42,0.20)] backdrop-blur-lg sm:px-8 sm:py-10 lg:px-10 lg:py-12">
          {/* Premium decorative elements */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-orange-500/15 blur-3xl transition-transform duration-700 group-hover:scale-110" />
            <div className="absolute -bottom-16 -left-16 h-56 w-56 rounded-full bg-blue-500/10 blur-2xl" />
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          </div>

          <div className="relative z-10">
            {/* Badge */}
            <div className="inline-flex">
              <p className="inline-flex items-center gap-2 rounded-full border border-orange-400/30 bg-gradient-to-r from-orange-500/10 to-orange-400/5 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-orange-200 backdrop-blur-sm">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-orange-400" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-400" />
                </span>
                {badge ?? "Employee Portal"}
              </p>
            </div>

            {/* Title and description */}
            <div className="mt-6">
              <h1 className="text-4xl font-black tracking-tight text-white sm:text-5xl lg:text-6xl">
                {title}
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">{description}</p>
            </div>

            {/* Accent line */}
            <div className="mt-6 flex gap-2">
              <div className="h-1 w-12 rounded-full bg-gradient-to-r from-orange-400 to-orange-300" />
              <div className="h-1 w-6 rounded-full bg-gradient-to-r from-orange-300 to-orange-200 opacity-50" />
            </div>
          </div>
        </section>

        {/* Content area with premium spacing */}
        <div className="space-y-6 lg:space-y-8">{children}</div>
      </div>
    </div>
  );
}

export function EmployeePortalActionBar({
  actions,
}: {
  actions: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/50 bg-gradient-to-r from-white/80 via-slate-50/80 to-white/80 p-4 shadow-[0_20px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl ring-1 ring-white/60 sm:p-5 lg:p-6">
      {/* Premium shine effect */}
      <div className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-r from-transparent via-white/20 to-transparent opacity-0 blur-xl" />

      <div className="relative flex flex-wrap items-center gap-3">
        {actions}
      </div>
    </div>
  );
}

export function EmployeePortalActionLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <Link
      className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full border border-orange-200/60 bg-gradient-to-br from-white to-orange-50/50 px-4 py-2 text-xs font-bold text-slate-700 shadow-[0_12px_30px_rgba(249,115,22,0.12)] transition duration-300 hover:border-orange-300/80 hover:from-orange-50 hover:to-orange-100/50 hover:shadow-[0_16px_40px_rgba(249,115,22,0.18)] active:scale-95"
      href={href}
    >
      <span className="relative z-10">{label}</span>
      <ArrowUpRight className="h-3.5 w-3.5 transition duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />

      {/* Premium shine overlay on hover */}
      <div className="pointer-events-none absolute inset-0 -left-full translate-x-0 bg-gradient-to-r from-transparent via-white/40 to-transparent transition-all duration-500 group-hover:translate-x-full" />
    </Link>
  );
}

export function EmployeePortalEmptyState({
  title,
  message,
  children,
}: {
  children?: ReactNode;
  message: string;
  title: string;
}) {
  return (
    <Card className="relative overflow-hidden rounded-3xl border border-white/40 bg-gradient-to-br from-white/80 via-slate-50/60 to-white/70 p-10 text-center shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur-xl ring-1 ring-white/50 sm:p-12 lg:p-16">
      {/* Subtle background elements */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-orange-200/10 blur-2xl" />
        <div className="absolute -left-20 bottom-0 h-40 w-40 rounded-full bg-blue-200/10 blur-2xl" />
      </div>

      <div className="relative z-10 space-y-4">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-gradient-to-br from-orange-100 to-orange-50 text-orange-600 shadow-[0_10px_30px_rgba(249,115,22,0.15)]">
          <CircleDashed className="h-8 w-8 animate-spin" />
        </div>

        <div>
          <p className="text-2xl font-bold text-slate-900">{title}</p>
          <p className="mt-3 text-base text-slate-600 leading-relaxed">{message}</p>
        </div>

        {children ? <div className="mt-6 flex justify-center">{children}</div> : null}
      </div>
    </Card>
  );
}

