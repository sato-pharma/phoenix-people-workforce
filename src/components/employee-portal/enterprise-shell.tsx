import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, CircleDashed } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type EmployeePortalPageShellProps = {
  badge?: string;
  children: ReactNode;
  description: string;
  descriptionClassName?: string;
  title: string;
};

export function EmployeePortalPageShell({
  badge,
  children,
  description,
  descriptionClassName,
  title,
}: EmployeePortalPageShellProps) {
  return (
    <div className="mx-auto w-full space-y-5">
      <section
        className="relative box-border w-full overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-[0_24px_60px_rgba(15,23,42,0.09)] ring-1 ring-slate-200/70"
        style={{ boxSizing: "border-box" }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(135deg,#ffffff_0%,#ffffff_44%,#f8fafc_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.03)_1px,transparent_1px)] bg-[size:36px_36px] opacity-70 [mask-image:linear-gradient(120deg,rgba(0,0,0,0.95),transparent_72%)]" />
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
        <div className="relative box-border grid w-full min-w-0 gap-5 p-5 sm:p-6 lg:grid-cols-12 lg:p-8">
          <div className="min-w-0 lg:col-span-12">
            <p className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-orange-700 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500 shadow-[0_0_0_4px_rgba(249,115,22,0.15)]" />
              {badge ?? "Employee Portal"}
            </p>
            <h1 className="mt-5 max-w-4xl text-[30px] font-semibold leading-[1.04] tracking-normal text-slate-950 sm:text-[38px] lg:text-[46px]">
              {title}
            </h1>
            <p
              className={cn(
                "mt-3.5 max-w-2xl text-[15px] font-medium leading-7 text-slate-600 lg:text-base",
                descriptionClassName,
              )}
            >
              {description}
            </p>
          </div>
        </div>
      </section>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

export function EmployeePortalActionBar({
  actions,
}: {
  actions: ReactNode;
}) {
  return (
    <div className="mb-4 flex max-w-full flex-col items-stretch gap-2 overflow-hidden rounded-[20px] border border-white/80 bg-white/90 px-3 py-2.5 shadow-[0_14px_34px_rgba(15,23,42,0.06)] ring-1 ring-slate-200/70 backdrop-blur sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      {actions}
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
      className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-700 shadow-[0_8px_20px_rgba(15,23,42,0.05)] transition hover:-translate-y-px hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
      href={href}
    >
      <span className="min-w-0 truncate">{label}</span>
      <ArrowUpRight className="h-3.5 w-3.5" />
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
    <Card className="rounded-[26px] border border-slate-200 bg-white p-8 text-center shadow-[0_18px_46px_rgba(15,23,42,0.07)]">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-lg font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}
