"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { adminChipDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LandingTick } from "@/components/employee-portal/landing-kit";

/**
 * THE PORTAL'S PAGE PARTS, on the landing kit's language (owner, 2026-11-20: every portal page
 * redesigned and polished, "EVERY SINGLE COMPONENT"). Forty-seven portal pages are built from these,
 * so they carry the kit's five rules to every page at once: navy ink and slate labels, the orange
 * tick as the only orange, white sheets on a hairline with the platform's soft depth, square, nothing
 * cut, and no sentence under a header. The exports, props and behaviour are unchanged; only the
 * look moved. `landing-kit.tsx` explains each rule.
 */

/** A page-level white sheet: the hairline and the platform's soft depth. */
export const portalPanelClassName = `border border-slate-200 bg-white ${adminSoftDepthClassName}`;

/** A tile that stands inside a page or a panel: the same sheet with a contact shadow only. */
export const portalSubtlePanelClassName = `border border-slate-200 bg-white ${adminChipDepthClassName}`;

export const portalInputClassName  = phxFieldClassName;

/** The night navy every title and figure is set in — the landing kit's ink. */
const PORTAL_INK = "text-[#08111f]";

/** The small slate capitals every label wears. */
const PORTAL_LABEL = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/**
 * One accent scale for rails, shared by the metric tile and the record card. Orange is the house
 * accent, but on a rail beside a figure it reads as an alarm, so "orange" draws the navy rail.
 */
const PORTAL_RAIL = {
  amber: "bg-amber-400",
  emerald: "bg-emerald-500",
  orange: "bg-[#08111f]",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  slate: "bg-slate-300",
} as const;

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
  // The header is the landing panel's: the tick and the title in navy capitals, the eyebrow (when a
  // page names the area above the title) in slate capitals over it, and the actions on the right.
  // It WRAPS, so a long title drops its actions to a second line on a 280px phone.
  const heading = title ?? eyebrow;
  return (
    <section className={cn(`min-w-0 overflow-hidden ${portalPanelClassName}`, className)}>
      {title || eyebrow || description || actions ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-3 py-2.5 sm:px-4">
          <div className="min-w-0 flex-1">
            {title && eyebrow ? <p className={cn("mb-1 break-words", PORTAL_LABEL)}>{eyebrow}</p> : null}
            {heading ? (
              <h2 className={cn("flex min-w-0 items-center gap-2 break-words text-phx-sm font-black uppercase tracking-[0.1em]", PORTAL_INK)}>
                <LandingTick />
                <span className="min-w-0">{heading}</span>
              </h2>
            ) : null}
            {description ? (
              <div className="phx-header-note mt-1 max-w-3xl text-sm font-medium leading-6 text-slate-500">
                {description}
              </div>
            ) : null}
          </div>
          {/* No `shrink-0`: it pins the box at its full content width, which makes the inner
              flex-wrap inert and lets a row of actions push past a narrow card. */}
          {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
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
        `flex min-w-0 flex-col gap-3 border border-slate-200 bg-white p-3 ${adminSoftDepthClassName} sm:flex-row sm:flex-wrap sm:items-end sm:px-4`,
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
  // A white sheet whose header is the tick and "FILTERS" in slate capitals — a label, not a page
  // heading, so it stays out of the document outline — with the count on the right.
  return (
    <section className={cn("min-w-0", portalPanelClassName)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2 sm:px-4">
        <p className={cn("flex min-w-0 items-center gap-2 break-words", PORTAL_LABEL)}>
          <LandingTick />
          <span className="min-w-0">{title}</span>
        </p>
        {countLabel ? (
          <span className="ml-auto min-w-0 break-words text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-slate-500">
            {countLabel}
          </span>
        ) : null}
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </section>
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
  // A white tile: a 4px rail in the accent down the left, the label in slate capitals with its icon
  // drawn in a quiet stroke beside it (never a tinted square), and the figure in navy.
  return (
    <div className={cn("flex min-w-0 overflow-hidden", portalSubtlePanelClassName)}>
      <span aria-hidden="true" className={cn("w-1 shrink-0", PORTAL_RAIL[accent])} />
      <div className="min-w-0 flex-1 px-3 py-3">
        <div className="flex min-w-0 items-start gap-1.5">
          {Icon ? <Icon aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" /> : null}
          {/* Wraps, never clips (fits-the-screen rule): two cards to a 375px row leave a label
              about 110px, and "SHORT / ABSENT" in tracked capitals needs more than that. */}
          <p className={cn("min-w-0 break-words leading-tight", PORTAL_LABEL)}>{label}</p>
        </div>
        <p className={cn("mt-2 break-words text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums", PORTAL_INK)}>{value}</p>
        {note ? <p className="mt-1.5 break-words text-phx-sm font-medium leading-snug text-slate-500">{note}</p> : null}
      </div>
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
        `flex w-full min-w-0 flex-wrap gap-1 border border-slate-200 bg-slate-50 p-1 ${adminChipDepthClassName}`,
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
  // One calm statement on a slate rail, read left to right like every other line on the page —
  // never a tinted icon square floating in the middle of an empty box.
  return (
    <div className="px-3 py-5 sm:px-4">
      <div className="flex min-w-0 gap-3">
        <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-slate-300" />
        <div className="min-w-0">
          <p className={cn("break-words text-sm font-bold", PORTAL_INK)}>{title}</p>
          <div className="mt-1 max-w-xl break-words text-phx-sm leading-snug text-slate-500">{message}</div>
          {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
        </div>
      </div>
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
    amber: "border-l-amber-400",
    emerald: "border-l-emerald-500",
    orange: "border-l-[#08111f]",
    rose: "border-l-rose-500",
    sky: "border-l-sky-500",
    slate: "border-l-slate-300",
  }[accent];

  return (
    <article className={cn("min-w-0 border-l-4 bg-white px-3 py-3 sm:px-4", accentClass, className)}>
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
          <h3 className="break-words text-sm font-bold text-[#08111f] md:whitespace-nowrap">{title}</h3>
          {meta ? <div className="mt-1 break-words text-phx-sm font-medium text-slate-500">{meta}</div> : null}
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
  // A hairline grid of facts — two to a row, the label in slate capitals over the value in navy —
  // instead of a stack of grey boxes.
  return (
    <dl className="grid min-w-0 grid-cols-2 border-l border-t border-slate-200">
      {fields.map((field, index) => (
        <div className="min-w-0 border-b border-r border-slate-200 px-2.5 py-2" key={index}>
          <dt className={cn("break-words", PORTAL_LABEL)}>{field.label}</dt>
          <dd className={cn("mt-0.5 min-w-0 break-words text-phx-sm font-bold tabular-nums", PORTAL_INK)}>
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
        className={cn("w-full table-fixed border-collapse text-left text-sm tabular-nums text-[#08111f]", className)}
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
      <span className={cn("mb-0.5 block md:hidden", PORTAL_LABEL)}>
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
      <div className={cn("divide-y divide-slate-200", cardHideClassName)}>
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
    <div className="flex flex-col gap-2 border-t border-slate-200 px-3 py-2.5 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <span className="min-w-0 break-words">{label}</span>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}
