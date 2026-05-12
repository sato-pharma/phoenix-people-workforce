import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight, CircleDashed, Database, LockKeyhole, ShieldCheck } from "lucide-react";
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
    <div className="mx-auto w-full space-y-4">
      <section
        className="relative box-border w-full overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_20px_50px_rgba(15,23,42,0.08)]"
        style={{ boxSizing: "border-box" }}
      >
        <div className="absolute inset-0 bg-gradient-to-br from-white via-white to-slate-50/50" />
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600" />
        <div className="relative box-border grid w-full min-w-0 gap-5 p-5 sm:p-6 lg:grid-cols-12 lg:p-8">
          <div className="min-w-0 lg:col-span-8 xl:col-span-9">
            <p className="inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50/80 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-orange-700 shadow-sm">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500 shadow-[0_0_0_4px_rgba(249,115,22,0.15)]" />
              {badge ?? "Employee Portal"}
            </p>
            <h1 className="mt-5 max-w-4xl text-3xl font-black leading-[1.02] tracking-tight text-slate-950 sm:text-4xl lg:text-5xl">
              {title}
            </h1>
            <p className="mt-4 max-w-2xl text-base font-medium leading-7 text-slate-600">{description}</p>
          </div>
          <div className="min-w-0 rounded-[20px] border border-slate-200 bg-white/60 p-5 shadow-sm backdrop-blur-sm lg:col-span-4 xl:col-span-3">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500">Operational Status</p>
                <p className="mt-1.5 text-lg font-black tracking-tight text-slate-950">Live data</p>
              </div>
              <div className="relative mt-1 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-500 shadow-[0_0_0_5px_rgba(16,185,129,0.15)]" />
              </div>
            </div>
            <div className="space-y-2.5">
              {[
                { icon: Database, label: "Metrics synced", tone: "text-emerald-600", bg: "bg-emerald-50/80 border-emerald-100" },
                { icon: ShieldCheck, label: "Audit healthy", tone: "text-sky-600", bg: "bg-sky-50/80 border-sky-100" },
                { icon: LockKeyhole, label: "Access protected", tone: "text-violet-600", bg: "bg-violet-50/80 border-violet-100" },
              ].map((item) => (
                <div
                  className={`flex min-w-0 items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-[11px] font-bold uppercase tracking-wider text-slate-700 shadow-sm transition-all hover:scale-[1.02] ${item.bg}`}
                  key={item.label}
                >
                  <span className="min-w-0 truncate">{item.label}</span>
                  <item.icon className={`h-3.5 w-3.5 ${item.tone}`} />
                </div>
              ))}
            </div>
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
    <div className="mb-4 flex max-w-full flex-col items-stretch gap-2 overflow-hidden rounded-[18px] border border-slate-200/90 bg-white px-3 py-2.5 shadow-[0_12px_30px_rgba(15,23,42,0.055)] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
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

