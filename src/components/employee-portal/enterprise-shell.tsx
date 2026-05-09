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
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/80 bg-white px-5 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)] sm:px-6 sm:py-5">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-500">
          {badge ?? "Employee Portal"}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">{description}</p>
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
  return <div className="mb-4 flex flex-wrap items-center gap-2">{actions}</div>;
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
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 px-3.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600"
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
    <Card className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-50 text-slate-500">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-lg font-semibold text-slate-900">{title}</p>
      <p className="mt-2 text-sm text-slate-600">{message}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </Card>
  );
}

