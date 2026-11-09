"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { CircleDashed } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

export const portalPanelClassName =
  "rounded border border-slate-200/90 bg-white shadow-[0_16px_40px_rgba(15,23,42,0.07)]";

export const portalSubtlePanelClassName =
  "rounded border border-slate-200/80 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.05)]";

export const portalInputClassName  = phxFieldClassName;

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
              <p className="text-phx-sm font-black uppercase tracking-[0.18em] text-orange-600">
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
          {/* No `shrink-0`: it pins the box at its full content width, which makes the inner
              flex-wrap inert and lets a row of actions push past a narrow card. */}
          {actions ? <div className="flex flex-wrap gap-2 sm:justify-end">{actions}</div> : null}
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
          <span className="inline-flex items-center rounded border border-orange-100 bg-orange-50 px-2 py-1 text-phx-sm font-black uppercase tracking-[0.14em] text-orange-700">
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
        {/* Wraps, never clips (fits-the-screen rule): two cards to a 375px row leave a label
            about 110px, and "SHORT / ABSENT" in tracked capitals needs more than that. */}
        <p className="min-w-0 break-words text-phx-sm font-black uppercase leading-tight tracking-[0.14em] text-slate-500">
          {label}
        </p>
      </div>
      <p className="mt-2 break-words text-2xl font-black leading-none tabular-nums text-slate-950">{value}</p>
      {note ? <p className="mt-1 break-words text-xs font-semibold text-slate-500">{note}</p> : null}
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
  // Wraps onto a second row rather than scrolling sideways behind a hidden scrollbar — a tab
  // the rep cannot see is a tab he does not know exists (fits-the-screen rule).
  return (
    <div
      className={cn(
        `flex w-full flex-wrap gap-1 rounded border border-slate-200 bg-slate-50 p-1 ${adminSoftDepthClassName}`,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PortalSkeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-none bg-slate-100", className)} />;
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
          <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">
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

/** Where the desktop table starts showing; below it the paired mobile card list carries the data. */
export type PortalTableBreakpoint = "md" | "lg" | "xl";

/** The desktop table shows from `breakpoint`; the mobile card list is hidden from the same width. */
export const portalTableShowClassName: Record<PortalTableBreakpoint, string> = {
  lg: "hidden lg:block",
  md: "hidden md:block",
  xl: "hidden xl:block",
};
export const portalTableCardHideClassName: Record<PortalTableBreakpoint, string> = {
  lg: "lg:hidden",
  md: "md:hidden",
  xl: "xl:hidden",
};

export function PortalDesktopTable({
  breakpoint = "md",
  children,
  className,
  cols,
  maxHeight,
}: {
  /**
   * Where the desktop table appears. Default `md`. Raise to `lg`/`xl` only for a table with so
   * many columns it would be unreadably dense at a narrower `main`; the paired mobile card list
   * (pass the same breakpoint to `PortalResponsiveDataList`) then covers everything below it.
   */
  breakpoint?: PortalTableBreakpoint;
  children: ReactNode;
  className?: string;
  /**
   * A `<colgroup>` sizing the columns as percentages, e.g.
   * `<colgroup><col className="w-[40%]" /><col className="w-[20%]" />…</colgroup>`. The table is
   * `table-fixed`, so these proportions — not the content — decide the widths, and long cells
   * wrap instead of forcing the table wider than `main`. Omit only for a table whose columns are
   * happy equal-width.
   */
  cols?: ReactNode;
  /**
   * Caps the wrapper and makes it scroll VERTICALLY, which is what a `sticky top-0` header cell
   * needs in order to have anything to stick against: sticky resolves against the nearest
   * scrollport, and an uncapped wrapper is exactly as tall as its content, so the PAGE does the
   * scrolling and the header sails away with it. Passing this does not freeze a header on its own
   * — the `<th>`s still have to say `sticky top-0` themselves. It never scrolls horizontally: the
   * `table-fixed` layout already keeps the table inside `main`.
   */
  maxHeight?: string;
  /**
   * @deprecated No longer used. The table used to carry a `min-width` floor inside an
   * `overflow-x-auto` wrapper, which scrolled sideways at tablet and laptop widths — the exact
   * thing the fits-the-screen golden rule forbids. It is now `table-fixed w-full`, so it fits
   * `main` by wrapping. Size the columns with `cols` instead. Accepted only so existing callers
   * keep compiling; passing it does nothing.
   */
  minWidth?: string;
}) {
  return (
    <div
      className={
        maxHeight
          ? `${portalTableShowClassName[breakpoint]} overflow-y-auto`
          : portalTableShowClassName[breakpoint]
      }
      style={maxHeight ? { maxHeight } : undefined}
    >
      <table
        className={cn("w-full table-fixed border-collapse text-left text-sm", className)}
        data-portal-desktop-table
      >
        {cols}
        {children}
      </table>
    </div>
  );
}

/**
 * The stacking-table pattern: ONE table that becomes a labelled stack on a phone.
 *
 * `PortalResponsiveDataList` below is the usual answer, and the better one for a read-only report.
 * But it renders every row TWICE — a card instance and a table instance — so a row's `useState` is
 * held in two independent copies. Harmless for a report; NOT harmless for a row carrying an
 * unsaved edit, because a phone rotated to landscape is wider than the `md` breakpoint, so
 * crossing it mid-edit swaps in the other instance and the pending change is gone with no warning.
 *
 * Use these when a row holds draft state, and `PortalResponsiveDataList` otherwise. Apply the four
 * class constants to the table, thead, tbody and each tr, and render every cell as a
 * `PortalStackingCell` so it carries its own label once the column headers are hidden.
 */
export const portalStackingTableClassName = "block min-w-0 text-left md:table md:min-w-full";
export const portalStackingHeadClassName = "hidden md:table-header-group";
export const portalStackingBodyClassName = "block md:table-row-group";
export const portalStackingRowClassName = "block md:table-row";

export function PortalStackingCell({
  children,
  className,
  colSpan,
  label,
}: {
  children: ReactNode;
  className?: string;
  colSpan?: number;
  label: string;
}) {
  return (
    <td className={cn("block px-4 py-1.5 md:table-cell md:py-3", className)} colSpan={colSpan}>
      <span className="mb-0.5 block text-phx-sm font-black uppercase tracking-[0.16em] text-slate-400 md:hidden">
        {label}
      </span>
      {children}
    </td>
  );
}

export function PortalResponsiveDataList<T>({
  breakpoint = "md",
  empty,
  getKey,
  items,
  renderCard,
  renderTable,
}: {
  /**
   * Where the desktop table takes over from the cards. Must match the `breakpoint` passed to the
   * `PortalDesktopTable` that `renderTable` returns, or a band of widths would show neither.
   */
  breakpoint?: PortalTableBreakpoint;
  empty: ReactNode;
  getKey: (item: T, index: number) => string;
  items: T[];
  renderCard: (item: T, index: number) => ReactNode;
  renderTable: () => ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;

  // The `?? "md:hidden"` is a real fallback, not dead code: other tests trust this component's
  // NAME alone as proof a table has a mobile card path (see hr-shell-mobile-tables.test.ts), so
  // if `portalTableCardHideClassName` were ever edited to drop a key, the card list must still
  // default to gating at `md` rather than rendering un-hidden at every width.
  const cardHideClassName = portalTableCardHideClassName[breakpoint] ?? "md:hidden";

  return (
    <>
      <div className={cn("divide-y divide-slate-100", cardHideClassName)}>
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
