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
    <div className="relative overflow-hidden rounded-[34px] border border-orange-100/80 bg-[radial-gradient(circle_at_12%_0%,rgba(249,115,22,0.13),transparent_34%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_42%,#FFFFFF_100%)] p-4 shadow-[0_30px_100px_rgba(15,23,42,0.10)] sm:p-5">
      <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-orange-400/50 to-transparent" />
      <div className="relative space-y-5">
        <section className="relative overflow-hidden rounded-[30px] border border-white/75 bg-[linear-gradient(135deg,#0B0B0B_0%,#111827_58%,#3B2413_100%)] px-5 py-6 text-white shadow-[0_24px_70px_rgba(15,23,42,0.24)] sm:px-7 sm:py-7">
          <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-orange-500/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 left-20 h-44 w-44 rounded-full bg-amber-300/10 blur-2xl" />
          <div className="relative">
            <p className="inline-flex rounded-full border border-orange-400/40 bg-orange-500/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-orange-200">
              {badge ?? "Employee Portal"}
            </p>
            <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] text-white sm:text-4xl">{title}</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">{description}</p>
          </div>
        </section>
        <div className="space-y-6">{children}</div>
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
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-3xl border border-white/75 bg-white/90 p-3 shadow-[0_18px_50px_rgba(15,23,42,0.08)] ring-1 ring-slate-900/5">
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
      className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-white px-3.5 py-1.5 text-xs font-black text-slate-700 shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition hover:-translate-y-0.5 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
      href={href}
    >
      {label}
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
    <Card className="rounded-[30px] border border-white/75 bg-white/95 p-8 text-center shadow-[0_24px_70px_rgba(15,23,42,0.10)] ring-1 ring-slate-900/5">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-orange-500">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-lg font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}

