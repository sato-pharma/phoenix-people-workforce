// Recruitment — the module's one premium look, shared by every screen.
//
// The owner, 2026-10-19: "do a full big sweep end to end ... the module needs premium polish from all
// design and identity and style aspects, god mode, every single component", choosing all of
// Recruitment, the screening workstation included, and a full redesign. Before it, fifteen of the
// module's screens opened on a bare grey `<h1>`, three different pill palettes were in use, and every
// screen drew its own panel header, empty state and filter tray. This file is the one spelling of each.
//
// 2026-11-20 — THE KIT NOW SPEAKS THE PORTAL LANDING'S LANGUAGE (owner: "EVERY SINGLE COMPONENT TO BE
// PREMIUM POLISHED"; `src/components/employee-portal/landing-kit.tsx`). Every screen still builds from
// THIS file, so the move happened here once rather than on forty screens:
//   • a panel is the landing's white sheet — the orange tick and a navy small-capital title, the count
//     a plain navy figure beside it, the actions in the header's right slot — never a dark band;
//   • the KPI strip is the page's ONE night-navy board of headline figures;
//   • a status is coloured small capitals behind a thin rail, never a filled tinted pill;
//   • the tab bar is the landing's underline tab and WRAPS rather than scrolls;
//   • nothing sits under a header (owner, 2026-11-20: "DELETE ANY TEXT UNDER ANY HEADER") — the
//     `description` props stay in the types so no caller breaks, and are no longer drawn;
//   • the header is still `AdminPageHero` — the slim title with the accent rail, NEVER the thick dark
//     banner the owner had stripped from every page on 2026-09-03, never a bare `<h1>`;
//   • corners are square everywhere (the square-edge golden rule), so nothing here names a radius;
//   • text wraps, never truncates, and no grid here can push the page sideways.

import type { ReactNode } from "react";
import { UserRoundSearch } from "lucide-react";

import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";
import { AdminPageHero } from "@/components/admin/admin-design-system";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingFigure,
  LandingNavyBoard,
  LandingPanel,
} from "@/components/employee-portal/landing-kit";
import { cn } from "@/lib/utils";

/** The module's eyebrow, so every screen announces which product it belongs to in the same words. */
export const RECRUITMENT_EYEBROW = "Recruitment";

/**
 * The page header every recruitment screen opens with. `AdminPageHero` underneath, so it is the slim
 * house header with the accent rail — the module's identity is the eyebrow and the icon, never a banner.
 * The sentence it used to print under the title is gone (owner, 2026-11-20): the prop stays so no page
 * breaks, the hero is handed an empty note, and its note line is hidden.
 */
export function RecruitmentPageHeader({
  actions,
  badges,
  description: _description,
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
      className="[&_.phx-header-note]:hidden"
      description=""
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

/** The swatch beside a tile's label: the tone's meaning on navy. Orange is the default and means nothing. */
const KPI_SWATCH: Record<NonNullable<RecruitmentKpi["tone"]>, string> = {
  blue: "bg-sky-400",
  emerald: "bg-emerald-400",
  orange: "bg-white/40",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
};

/**
 * The page's headline figures, on the landing's ONE night-navy board. Two across on a phone, three on
 * a tablet, up to six on a wide screen; the tiles are cut by a 1px seam and the grid never forces a
 * width, so it cannot scroll sideways. `label` names the board for a screen reader and in its header.
 */
export function RecruitmentKpiStrip({
  className,
  items,
  label = "Key figures",
}: {
  className?: string;
  items: readonly RecruitmentKpi[];
  label?: string;
}) {
  if (items.length === 0) return null;
  const wide = items.length >= 6 ? "xl:grid-cols-6" : items.length === 5 ? "xl:grid-cols-5" : "xl:grid-cols-4";
  return (
    <LandingNavyBoard className={className} label={label}>
      <div className={cn("grid grid-cols-2 gap-px md:grid-cols-3", wide)}>
        {items.map((item) => (
          <div className={cn("min-w-0 px-3 py-2.5", LANDING_NAVY_TILE)} key={item.label}>
            <p className="flex min-w-0 items-center gap-1.5">
              <span aria-hidden="true" className={cn("h-2.5 w-2.5 shrink-0", KPI_SWATCH[item.tone ?? "orange"])} />
              <span className="min-w-0 break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-white/60">
                {item.label}
              </span>
            </p>
            <div className="mt-1.5">
              <LandingFigure onNavy size="md">
                {item.value}
              </LandingFigure>
            </div>
            {item.description ? (
              <p className="mt-1 break-words text-phx-xs font-semibold leading-snug text-white/45">{item.description}</p>
            ) : null}
          </div>
        ))}
      </div>
    </LandingNavyBoard>
  );
}

/**
 * A page-level panel: the landing's white sheet. Its header is the orange tick and the title in navy
 * small capitals, `count` a plain navy figure beside it ("24"), and `actions` in the header's right
 * slot, dropping under the title on a narrow screen rather than squeezing it. `icon` and
 * `description` are kept in the props so no caller breaks; neither is drawn — no tinted icon, and no
 * sentence under a header (owner, 2026-11-20).
 */
export function RecruitmentPanel({
  actions,
  bodyClassName,
  children,
  className,
  count,
  description: _description,
  icon: _icon,
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
    <LandingPanel
      bodyClassName={cn("min-w-0", bodyClassName)}
      className={className}
      right={actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : undefined}
      title={
        <>
          {title}
          {count !== undefined && count !== null ? (
            <span className="ml-2 tabular-nums text-slate-500">{count}</span>
          ) : null}
        </>
      }
    >
      {children}
    </LandingPanel>
  );
}

/**
 * The tray filters and toolbars sit in: recessed, because it sits below the page rather than on it,
 * with its controls wrapping onto as many lines as they need. Flat slate, a hairline, an inner shadow
 * — never a drop shadow, which would float it off the panel it is cut into.
 */
export const recruitmentToolbarClassName = `flex flex-wrap items-end gap-3 border border-slate-200 bg-slate-50 px-3 py-3 sm:px-4 ${adminRecessedDepthClassName}`;

/** The same tray, stacked: lines of controls one under another (the workspace's filter bar). */
export const recruitmentStackedToolbarClassName = `space-y-3 border border-slate-200 bg-slate-50 px-3 py-3 sm:px-4 ${adminRecessedDepthClassName}`;

/**
 * Nothing to show — one calm statement on a slate rail, read left to right like every other line on
 * the page; never a blank box, a bare "0", or a tinted icon square floating in the middle. `icon` is
 * kept in the props so no caller breaks.
 */
export function RecruitmentEmptyState({
  action,
  icon: _icon,
  message,
  title,
}: {
  action?: ReactNode;
  icon?: ReactNode;
  message: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className="px-3 py-5 sm:px-4">
      <div className="flex min-w-0 gap-3">
        <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-slate-300" />
        <div className="min-w-0">
          <p className={cn("break-words text-sm font-bold", LANDING_INK)}>{title}</p>
          <div className="mt-1 max-w-xl break-words text-phx-sm leading-snug text-slate-500">{message}</div>
          {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** One tab in a `RecruitmentTabBar`. `count` prints as a figure after the label; `null` prints nothing. */
export type RecruitmentTab<K extends string> = {
  count?: number | null;
  icon?: ReactNode;
  key: K;
  label: string;
};

/**
 * The module's tab bar — the landing's tab: small navy capitals on a 2px navy underline when chosen,
 * the count a plain figure beside the words, never a filled chip. The tabs WRAP onto a second row on a
 * phone rather than scroll sideways (the fits-the-screen rule).
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
    <div aria-label={label} className="flex min-w-0 flex-wrap gap-x-1 border-b border-slate-200" role="tablist">
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "-mb-px inline-flex min-h-10 items-center gap-2 border-b-2 px-3 pb-2 pt-1 text-phx-xs font-bold uppercase tracking-[0.1em] transition-colors motion-reduce:transition-none sm:px-4",
              LANDING_FOCUS,
              selected ? cn("border-[#08111f]", LANDING_INK) : "border-transparent text-slate-500 hover:text-[#08111f]",
            )}
            key={tab.key}
            onClick={() => onChange(tab.key)}
            role="tab"
            type="button"
          >
            {tab.icon ? (
              <span aria-hidden="true" className={selected ? LANDING_INK : "text-slate-400"}>
                {tab.icon}
              </span>
            ) : null}
            <span className="break-words">{tab.label}</span>
            {tab.count !== undefined && tab.count !== null ? (
              <span className={cn("tabular-nums", selected ? LANDING_INK : "text-slate-400")}>{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The six status colours every recruitment screen uses, one spelling — a stage, a status, a channel. */
export type RecruitmentPillTone = "orange" | "emerald" | "amber" | "rose" | "sky" | "slate";

/** The tone's ink: the 700s on white, so a coloured word still clears contrast at 11px. */
export const recruitmentPillToneClassName: Record<RecruitmentPillTone, string> = {
  amber: "text-amber-700",
  emerald: "text-emerald-700",
  orange: "text-orange-700",
  rose: "text-rose-700",
  sky: "text-sky-700",
  slate: "text-slate-600",
};

/** The tone's rail: the thin bar before the word that carries the colour where a fill used to. */
export const recruitmentPillRailClassName: Record<RecruitmentPillTone, string> = {
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  slate: "bg-slate-400",
};

/** A status or stage: coloured small capitals behind a 2px rail — never a filled pill, never a badge on a badge. */
export function RecruitmentPill({ children, tone }: { children: ReactNode; tone: RecruitmentPillTone }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 break-words text-phx-xs font-bold uppercase tracking-[0.08em]",
        recruitmentPillToneClassName[tone],
      )}
    >
      <span aria-hidden="true" className={cn("h-3 w-0.5 shrink-0", recruitmentPillRailClassName[tone])} />
      {children}
    </span>
  );
}
