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
        className="relative box-border w-full overflow-hidden rounded-lg border border-slate-950 bg-[linear-gradient(135deg,#070707_0%,#111827_52%,#2C1605_100%)] shadow-[0_22px_70px_rgba(15,23,42,0.32)]"
        style={{ boxSizing: "border-box" }}
      >
        <div className="absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.18)_1px,transparent_1px)] [background-size:44px_44px]" />
        <div className="absolute -right-16 -top-24 h-64 w-64 rounded-full bg-orange-500/20 blur-3xl" />
        <div className="absolute -bottom-28 left-8 h-56 w-56 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="relative box-border grid w-full min-w-0 gap-5 p-5 sm:p-6 lg:grid-cols-12 lg:p-8">
          <div className="min-w-0 lg:col-span-12">
            <p className="inline-flex items-center gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 px-3.5 py-1.5 text-[10px] font-black uppercase tracking-[0.22em] text-orange-100">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-300" />
              {badge ?? "Employee Portal"}
            </p>
            <h1 className="mt-5 max-w-4xl text-[30px] font-black leading-[1.02] tracking-[-0.04em] text-white sm:text-[40px] lg:text-[48px]">
              {title}
            </h1>
            <p
              className={cn(
                "mt-3 max-w-2xl text-[15px] leading-[1.78] text-slate-300 lg:text-[15.5px]",
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
      className="inline-flex min-w-0 items-center justify-center gap-1.5 rounded-full border border-slate-200/80 bg-white px-4 py-1.5 text-[11px] font-bold tracking-wide text-slate-600 shadow-[0_4px_12px_rgba(15,23,42,0.06)] transition duration-200 hover:-translate-y-px hover:border-orange-300/80 hover:bg-gradient-to-r hover:from-orange-50 hover:to-amber-50/60 hover:text-orange-700 hover:shadow-[0_8px_20px_rgba(249,115,22,0.12)]"
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
  supportReference,
}: {
  children?: ReactNode;
  message: string;
  supportReference?: string | null;
  title: string;
}) {
  return (
    <Card className="rounded-[26px] border border-slate-200 bg-white p-8 text-center shadow-[0_18px_46px_rgba(15,23,42,0.07)]">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-600 ring-1 ring-orange-100">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-lg font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      {supportReference ? (
        <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
          Reference: {supportReference}
        </p>
      ) : null}
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}
