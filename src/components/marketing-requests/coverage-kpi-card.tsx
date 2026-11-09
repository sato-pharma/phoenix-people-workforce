"use client";

import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Premium KPI card for the Marketing Coverage Report — the same gradient / soft
// shadow / icon-halo / hover-lift recipe as AdminStatCard
// (src/components/admin/admin-design-system.tsx), but SQUARE CORNERS throughout
// (including the decorative glow blob). This codebase's LOCKED admin-shell rule
// (app/globals.css) forces square corners inside `.admin-shell` via `!important`,
// but this card also renders in the employee-portal shell — so it must never emit
// a `rounded-*` class in the first place rather than rely on that override.
// `rounded-none` is passed explicitly (not just omitted) because the shared
// `Card` component's own base style already includes `rounded-xl`.

const TONE_CLASSES = {
  orange: {
    border: "hover:border-orange-300/80",
    bg: "bg-orange-200/15",
    icon: "from-orange-50 to-orange-100 text-orange-600 shadow-[0_8px_20px_rgba(249,115,22,0.15)] ring-orange-200",
  },
  blue: {
    border: "hover:border-blue-300/80",
    bg: "bg-blue-200/15",
    icon: "from-blue-50 to-blue-100 text-blue-600 shadow-[0_8px_20px_rgba(59,130,246,0.15)] ring-blue-200",
  },
  emerald: {
    border: "hover:border-emerald-300/80",
    bg: "bg-emerald-200/15",
    icon: "from-emerald-50 to-emerald-100 text-emerald-600 shadow-[0_8px_20px_rgba(16,185,129,0.15)] ring-emerald-200",
  },
  amber: {
    border: "hover:border-amber-300/80",
    bg: "bg-amber-200/15",
    icon: "from-amber-50 to-amber-100 text-amber-600 shadow-[0_8px_20px_rgba(217,119,6,0.15)] ring-amber-200",
  },
  violet: {
    border: "hover:border-violet-300/80",
    bg: "bg-violet-200/15",
    icon: "from-violet-50 to-violet-100 text-violet-600 shadow-[0_8px_20px_rgba(139,92,246,0.15)] ring-violet-200",
  },
  slate: {
    border: "hover:border-slate-300/80",
    bg: "bg-slate-200/15",
    icon: "from-slate-50 to-slate-100 text-slate-600 shadow-[0_8px_20px_rgba(15,23,42,0.15)] ring-slate-200",
  },
} as const;

export type CoverageKpiTone = keyof typeof TONE_CLASSES;

export function CoverageKpiCard({
  icon,
  label,
  value,
  description,
  tone = "orange",
  onClick,
  active = false,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  description?: string;
  tone?: CoverageKpiTone;
  /** When provided, the card becomes clickable (e.g. "Behind" toggles the roiStatus
   *  filter to that one value) — rendered with button semantics for keyboard/screen-reader
   *  access, since the shared Card component is a plain div. */
  onClick?: () => void;
  /** Visual "this KPI's filter is currently applied" state — a tone-matched ring. */
  active?: boolean;
}) {
  const toneClasses = TONE_CLASSES[tone];
  const interactive = Boolean(onClick);
  return (
    <Card
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      // Phones (below `sm`, 640px) sit two cards to a row, which leaves ~140px inside each: the
      // padding tightens, the icon steps aside and the figure drops one size so a seven-digit
      // amount still fits on its line. From `sm` up the card is exactly what it was.
      className={cn(
        "relative overflow-hidden rounded-none border border-slate-200/90 bg-white/95 p-3 shadow-[0_16px_40px_rgba(15,23,42,0.06)] transition-all duration-300 ease-out hover:-translate-y-1 hover:bg-white hover:shadow-[0_24px_52px_rgba(15,23,42,0.14)] hover:scale-[1.01] sm:p-5",
        toneClasses.border,
        interactive && "cursor-pointer",
        active && "ring-2 ring-offset-1",
        active && toneClasses.icon.match(/ring-\S+/)?.[0],
      )}
    >
      <div className={cn("pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-none blur-3xl", toneClasses.bg)} />
      <div className="relative flex items-start justify-between gap-2 sm:gap-4">
        <div className="min-w-0 space-y-1.5">
          {/* Wraps, never clips: "DISTINCT PHARMACIES" in tracked capitals is wider than a phone card. */}
          <p className="min-w-0 break-words text-phx-sm font-black uppercase tracking-[0.15em] text-slate-400">{label}</p>
          <div className="break-words text-xl font-black tracking-tight text-slate-900 sm:text-2xl">{value}</div>
          {description ? <p className="break-words text-xs font-semibold leading-5 text-slate-500">{description}</p> : null}
        </div>
        <div
          className={cn(
            "hidden h-11 w-11 shrink-0 items-center justify-center rounded-none bg-gradient-to-br p-2.5 ring-1 transition-transform duration-300 hover:scale-110 sm:flex",
            toneClasses.icon,
          )}
        >
          {icon}
        </div>
      </div>
    </Card>
  );
}
