"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { CircleDashed } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const portalPanelClassName =
  "rounded border border-slate-200/90 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.07)]";

export const portalSubtlePanelClassName =
  "rounded border border-slate-200/80 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.05)]";

export const portalInputClassName =
  "h-10 w-full rounded border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-500/10";

export function PortalSection({
  actions,
  children,
  className,
  description,
  eyebrow,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  eyebrow?: string;
  title?: ReactNode;
}) {
  return (
    <Card className={cn(portalPanelClassName, "overflow-hidden p-0", className)}>
      {title || eyebrow || description || actions ? (
        <div className="flex flex-col gap-3 border-b border-slate-100 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
          <div className="min-w-0">
            {eyebrow ? (
              <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-600">
                {eyebrow}
              </p>
            ) : null}
            {title ? (
              <h2 className="mt-1 text-lg font-black tracking-tight text-slate-950 sm:text-xl">
                {title}
              </h2>
            ) : null}
            {description ? (
              <div className="mt-1 max-w-3xl text-sm font-medium leading-6 text-slate-500">
                {description}
              </div>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

export function PortalToolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded border border-slate-200 bg-white p-3 shadow-[0_8px_22px_rgba(15,23,42,0.05)] sm:flex-row sm:flex-wrap sm:items-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PortalFilterBar({
  children,
  countLabel,
  title = "Filters",
}: {
  children: ReactNode;
  countLabel?: ReactNode;
  title?: string;
}) {
  return (
    <PortalSection className="shadow-[0_10px_28px_rgba(15,23,42,0.05)]">
      <div className="p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded border border-orange-100 bg-orange-50 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-orange-700">
            {title}
          </span>
          {countLabel ? <span className="text-xs font-bold text-slate-500">{countLabel}</span> : null}
        </div>
        {children}
      </div>
    </PortalSection>
  );
}

export function PortalMetricCard({
  accent = "orange",
  icon: Icon,
  label,
  note,
  value,
}: {
  accent?: "orange" | "emerald" | "amber" | "rose" | "sky" | "slate";
  icon?: LucideIcon;
  label: ReactNode;
  note?: ReactNode;
  value: ReactNode;
}) {
  const accents = {
    amber: "border-l-amber-500 text-amber-600 bg-amber-50",
    emerald: "border-l-emerald-500 text-emerald-600 bg-emerald-50",
    orange: "border-l-orange-500 text-orange-600 bg-orange-50",
    rose: "border-l-rose-500 text-rose-600 bg-rose-50",
    sky: "border-l-sky-500 text-sky-600 bg-sky-50",
    slate: "border-l-slate-500 text-slate-600 bg-slate-50",
  }[accent];

  return (
    <div className={cn(portalSubtlePanelClassName, "border-l-[3px] px-3.5 py-3", accents.split(" ")[0])}>
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? (
          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded border border-current/10", accents)}>
            <Icon className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <p className="min-w-0 whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
          {label}
        </p>
      </div>
      <p className="mt-2 text-2xl font-black leading-none text-slate-950">{value}</p>
      {note ? <p className="mt-1 text-xs font-semibold text-slate-500">{note}</p> : null}
    </div>
  );
}

export function PortalSegmentedTabs({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full gap-1 overflow-x-auto rounded border border-slate-200 bg-slate-50 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PortalSkeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-slate-100", className)} />;
}

export function PortalEmptyState({
  action,
  message,
  title,
}: {
  action?: ReactNode;
  message: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center sm:px-6">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded border border-orange-100 bg-orange-50 text-orange-600">
        <CircleDashed className="h-5 w-5" />
      </div>
      <p className="mt-4 text-base font-black text-slate-950">{title}</p>
      <div className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-slate-500">
        {message}
      </div>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function PortalRecordCard({
  accent = "slate",
  actions,
  children,
  className,
  meta,
  status,
  title,
}: {
  accent?: "orange" | "emerald" | "amber" | "rose" | "sky" | "slate";
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  meta?: ReactNode;
  status?: ReactNode;
  title: ReactNode;
}) {
  const accentClass = {
    amber: "border-l-amber-500",
    emerald: "border-l-emerald-500",
    orange: "border-l-orange-500",
    rose: "border-l-rose-500",
    sky: "border-l-sky-500",
    slate: "border-l-slate-400",
  }[accent];

  return (
    <article className={cn("border-l-[3px] bg-white px-4 py-3.5", accentClass, className)}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Nowrap from `md` up, where a card sits in a wide grid and a name always fits. BELOW
              md it must wrap: measured on a 375px phone, the longest real rep name (52 chars,
              "Mohamed Mohamed ElMenshawy Abdelmatty Mohamed Ismail") needs 436px in a 267px slot,
              and with `whitespace-nowrap` and no clipping it pushed the PAGE's scroll width to
              455px — a sideways-scrolling phone page, which is the exact defect the card layout
              exists to remove. 37 of 108 CRM reps are over that length. Wrapping is the only
              option that keeps the whole name readable; the owner chose it over an ellipsis on
              2026-08-21, for mobile cards only. Desktop tables still never wrap. */}
          <h3 className="break-words text-sm font-black text-slate-950 md:whitespace-nowrap">{title}</h3>
          {meta ? <div className="mt-1 text-xs font-semibold text-slate-500">{meta}</div> : null}
        </div>
        {status ? <div className="shrink-0">{status}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </article>
  );
}

export function PortalRecordFields({
  fields,
}: {
  fields: Array<{ label: ReactNode; value: ReactNode }>;
}) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {fields.map((field, index) => (
        <div className="rounded border border-slate-100 bg-slate-50 px-2.5 py-2" key={index}>
          <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
            {field.label}
          </dt>
          <dd className="mt-0.5 min-w-0 break-words text-xs font-bold text-slate-800">
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function PortalDesktopTable({
  children,
  className,
  minWidth = "980px",
}: {
  children: ReactNode;
  className?: string;
  minWidth?: string;
}) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table
        className={cn("w-full border-collapse text-left text-sm", className)}
        data-portal-desktop-table
        style={{ minWidth }}
      >
        {children}
      </table>
    </div>
  );
}

export function PortalResponsiveDataList<T>({
  empty,
  getKey,
  items,
  renderCard,
  renderTable,
}: {
  empty: ReactNode;
  getKey: (item: T, index: number) => string;
  items: T[];
  renderCard: (item: T, index: number) => ReactNode;
  renderTable: () => ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;

  return (
    <>
      <div className="divide-y divide-slate-100 md:hidden">
        {items.map((item, index) => (
          <div key={getKey(item, index)}>{renderCard(item, index)}</div>
        ))}
      </div>
      {renderTable()}
    </>
  );
}

export function PortalPagination({
  children,
  label,
}: {
  children?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3 text-xs font-bold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
      <span>{label}</span>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
