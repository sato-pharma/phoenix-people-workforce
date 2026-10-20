// Recruitment — the module's one premium look, shared by every screen.
//
// The owner, 2026-10-19: "do a full big sweep end to end ... the module needs premium polish from all
// design and identity and style aspects, god mode, every single component", choosing all of
// Recruitment, the screening workstation included, and a full redesign. Before it, fifteen of the
// module's screens opened on a bare grey `<h1>`, three different pill palettes were in use, and every
// screen drew its own panel header, empty state and filter tray. This file is the one spelling of each.
//
// EVERYTHING HERE IS BUILT FROM THE HOUSE TOKENS, never a new look of its own:
//   • the header is `AdminPageHero` — the slim title with the accent rail, NEVER the thick dark banner
//     the owner had stripped from every page on 2026-09-03;
//   • the KPI tiles are `AdminStatCard` in its compact size;
//   • a panel's dark header band is `adminPanelHeaderClassName`, its lift `adminPanelDepthClassName`;
//   • corners are square everywhere (the square-edge golden rule), so nothing here names a radius;
//   • text wraps, never truncates, and no grid here can push the page sideways.

import type { ReactNode } from "react";
import { CircleDashed, UserRoundSearch } from "lucide-react";

import {
  adminChipDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
  adminRecessedDepthClassName,
} from "@/components/admin/admin-design-tokens";
import { AdminPageHero, AdminStatCard } from "@/components/admin/admin-design-system";
import { cn } from "@/lib/utils";

/** The module's eyebrow, so every screen announces which product it belongs to in the same words. */
export const RECRUITMENT_EYEBROW = "Recruitment";

/**
 * The page header every recruitment screen opens with. `AdminPageHero` underneath, so it is the slim
 * house header with the accent rail — the module's identity is the eyebrow and the icon, never a banner.
 */
export function RecruitmentPageHeader({
  actions,
  badges,
  description,
  eyebrow = RECRUITMENT_EYEBROW,
  icon,
  title,
}: {
  actions?: ReactNode;
  badges?: ReactNode;
  description: string;
  eyebrow?: string;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <AdminPageHero
      actions={actions}
      badges={badges}
      description={description}
      eyebrow={eyebrow}
      icon={icon ?? <UserRoundSearch aria-hidden="true" className="h-3.5 w-3.5" />}
      title={title}
    />
  );
}

/** One figure in a KPI strip. `value` is a node so a page can print "—" for a read that failed. */
export type RecruitmentKpi = {
  description: string;
  icon: ReactNode;
  label: string;
  tone?: "orange" | "blue" | "emerald" | "violet" | "rose";
  value: ReactNode;
};

/**
 * A row of KPI tiles. Two across on a phone, three on a tablet, up to six on a wide screen; the grid
 * never forces a width, so it cannot scroll sideways.
 */
export function RecruitmentKpiStrip({ className, items }: { className?: string; items: readonly RecruitmentKpi[] }) {
  if (items.length === 0) return null;
  const wide = items.length >= 6 ? "xl:grid-cols-6" : items.length === 5 ? "xl:grid-cols-5" : "xl:grid-cols-4";
  return (
    <div className={cn("grid grid-cols-2 gap-3 md:grid-cols-3", wide, className)}>
      {items.map((item) => (
        <AdminStatCard
          description={item.description}
          icon={item.icon}
          key={item.label}
          label={item.label}
          size="compact"
          tone={item.tone ?? "orange"}
          value={item.value}
        />
      ))}
    </div>
  );
}

/**
 * A page-level panel: a dark header band naming what it holds, then its body on white, lifted off the
 * page by the house panel shadow. `count` prints beside the title as a chip ("24"), `actions` sit on
 * the band's right and wrap under the title on a narrow screen.
 */
export function RecruitmentPanel({
  actions,
  bodyClassName,
  children,
  className,
  count,
  description,
  icon,
  title,
}: {
  actions?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
  className?: string;
  count?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}) {
  return (
    <section className={cn(`min-w-0 border border-slate-200 bg-white ${adminPanelDepthClassName}`, className)}>
      <header
        className={cn(
          "flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 text-white sm:px-5",
          adminPanelHeaderClassName,
        )}
      >
        <div className="min-w-0 grow basis-64">
          <div className="flex flex-wrap items-center gap-2">
            {icon ? <span className="text-orange-300">{icon}</span> : null}
            <h2 className="break-words text-sm font-black uppercase tracking-[0.12em] text-white">{title}</h2>
            {count !== undefined && count !== null ? (
              <span className="border border-orange-400/40 bg-orange-500/15 px-1.5 py-0.5 text-phx-xs font-black tabular-nums text-orange-100">
                {count}
              </span>
            ) : null}
          </div>
          {description ? <p className="mt-1 break-words text-xs leading-5 text-slate-300">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn("min-w-0", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * The tray filters and toolbars sit in: recessed, because it sits below the page rather than on it,
 * with its controls wrapping onto as many lines as they need.
 */
export const recruitmentToolbarClassName = `flex flex-wrap items-end gap-3 border border-slate-200 bg-slate-50/80 px-3 py-3 sm:px-4 ${adminRecessedDepthClassName}`;

/** Nothing to show — said in words, with the module's own mark, never a blank box or a bare "0". */
export function RecruitmentEmptyState({
  action,
  icon,
  message,
  title,
}: {
  action?: ReactNode;
  icon?: ReactNode;
  message: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center sm:px-6">
      <div
        className={cn(
          "mx-auto flex h-12 w-12 items-center justify-center border border-orange-200 bg-gradient-to-b from-orange-50 to-white text-orange-600",
          adminChipDepthClassName,
        )}
      >
        {icon ?? <CircleDashed aria-hidden="true" className="h-5 w-5" />}
      </div>
      <p className="mt-4 text-base font-black tracking-tight text-slate-950">{title}</p>
      <div className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-slate-500">{message}</div>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** One tab in a `RecruitmentTabBar`. `count` prints as a chip after the label; `null` prints nothing. */
export type RecruitmentTab<K extends string> = {
  count?: number | null;
  icon?: ReactNode;
  key: K;
  label: string;
};

/**
 * The module's tab bar: one recessed tray of square segments, the chosen one lifted onto white with an
 * orange underline. The segments wrap onto a second line on a phone rather than scroll sideways.
 */
export function RecruitmentTabBar<K extends string>({
  label,
  onChange,
  tabs,
  value,
}: {
  label: string;
  onChange: (key: K) => void;
  tabs: readonly RecruitmentTab<K>[];
  value: K;
}) {
  return (
    <div
      aria-label={label}
      className={cn("flex flex-wrap gap-1 border border-slate-200 bg-slate-100/80 p-1", adminRecessedDepthClassName)}
      role="tablist"
    >
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "relative inline-flex min-h-9 grow items-center justify-center gap-2 px-3 py-1.5 text-sm font-bold transition-colors sm:grow-0 sm:px-4",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1",
              selected
                ? cn("bg-white text-slate-950", adminChipDepthClassName)
                : "text-slate-600 hover:bg-white/70 hover:text-slate-900",
            )}
            key={tab.key}
            onClick={() => onChange(tab.key)}
            role="tab"
            type="button"
          >
            {tab.icon ? (
              <span aria-hidden="true" className={selected ? "text-orange-600" : "text-slate-400"}>
                {tab.icon}
              </span>
            ) : null}
            <span>{tab.label}</span>
            {tab.count !== undefined && tab.count !== null ? (
              <span
                className={cn(
                  "border px-1.5 text-phx-xs font-black tabular-nums",
                  selected ? "border-orange-200 bg-orange-50 text-orange-700" : "border-slate-200 bg-white/80 text-slate-500",
                )}
              >
                {tab.count}
              </span>
            ) : null}
            {selected ? <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 bg-orange-500" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** The six pill colours every recruitment screen uses, one spelling — a stage, a status, a channel. */
export type RecruitmentPillTone = "orange" | "emerald" | "amber" | "rose" | "sky" | "slate";

export const recruitmentPillToneClassName: Record<RecruitmentPillTone, string> = {
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
  orange: "border-orange-200 bg-orange-50 text-orange-800",
  rose: "border-rose-200 bg-rose-50 text-rose-800",
  sky: "border-sky-200 bg-sky-50 text-sky-800",
  slate: "border-slate-200 bg-slate-50 text-slate-700",
};

/** A status or stage pill: hairline, tinted ground, small capitals, a contact shadow so it reads as a chip. */
export function RecruitmentPill({ children, tone }: { children: ReactNode; tone: RecruitmentPillTone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 border px-1.5 py-0.5 text-phx-xs font-bold uppercase tracking-[0.06em]",
        recruitmentPillToneClassName[tone],
        adminChipDepthClassName,
      )}
    >
      {children}
    </span>
  );
}
