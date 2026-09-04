"use client";

import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The shared visual language of the TARGET modules.
//
// Two surfaces measure sales against target — `VsTargetDashboard` (Sales vs Target) and
// `TargetsWorkspace` (Targets) — and each of them renders in BOTH shells: the admin shell
// at /sales/vs-target and /sales/targets, the employee portal at /employee-portals/
// sales-vs-target and /employee-portals/targets. Four screens, one subject.
//
// Until 2026-09-04 the primitives below were private to vs-target-dashboard.tsx and the
// Targets workspace had no visual encoding at all: its region and DM rollups were a list of
// bare percentages in a `max-h-40` scroll box, and its achievement column was a coloured
// number. The same figure was therefore drawn two entirely different ways depending on
// which of the two screens you happened to open, and the owner's standing rule is to match
// the design identity of the sibling pages in a module rather than invent a one-off look.
//
// So they live here, and both modules import them. A ring drawn on Sales vs Target and a
// ring drawn on Targets are now the same ring, by construction rather than by discipline —
// `tests/target-visuals-shared.test.ts` fails if either module re-declares its own copy.
//
// The rules encoded here that are NOT free to change:
//   • A null achievement is NEUTRAL, never red. An area with no target loaded has not
//     underperformed — it has not been measured. Red would accuse it of a miss it was
//     never set up to make.
//   • A null percentage prints "—", never "0%". The difference is the entire point.
//   • The ARC is capped at 100% while the printed number is not. An over-achiever cannot
//     wrap the circle back to nothing, and the truthful figure still reads beneath it.
// ─────────────────────────────────────────────────────────────────────────────

/** Sales. The Phoenix orange that carries "actual" everywhere in the sales module. */
export const ACTUAL_COLOR = "#F97316";
/** Target. The sky blue that carries the line/threshold in the same charts. */
export const TARGET_COLOR = "#38BDF8";

// ── Formatting ───────────────────────────────────────────────────────────────

/** Abbreviated money, for a cell that has to share its row with several others. */
export function formatEgp(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}EGP ${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}EGP ${(abs / 1_000).toFixed(1)}K`;
  return `${sign}EGP ${Math.round(abs).toLocaleString("en-US")}`;
}

/** Money in full, for a headline or a column that owns its width. */
export function formatEgpFull(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

export function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** A null percentage is "—", never "0%". The difference is the whole point. */
export function formatPct(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function formatSignedPct(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

export function formatPeriod(period: string | null): string {
  if (!period) return "—";
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

/** Null (no target) is NEUTRAL, never red — an untargeted area has not underperformed. */
export function achievementTone(value: number | null): string {
  if (value == null) return "text-slate-400";
  if (value >= 1) return "text-emerald-600";
  if (value >= 0.8) return "text-amber-600";
  if (value >= 0.5) return "text-orange-600";
  return "text-red-600";
}

export function achievementHex(value: number | null): string {
  if (value == null) return "#94A3B8";
  if (value >= 1) return "#10B981";
  if (value >= 0.8) return "#F59E0B";
  if (value >= 0.5) return "#F97316";
  return "#EF4444";
}

export function growthTone(value: number | null): string {
  if (value == null) return "text-slate-400";
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-red-600";
  return "text-slate-500";
}

// ── Primitives ───────────────────────────────────────────────────────────────

export function GrowthPill({ value, dark = false }: { value: number | null; dark?: boolean }) {
  const Icon = value == null ? Minus : value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  const tone = dark
    ? value == null
      ? "text-slate-400"
      : value > 0
        ? "text-emerald-400"
        : value < 0
          ? "text-red-400"
          : "text-slate-400"
    : growthTone(value);
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-bold", tone)}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {formatSignedPct(value)}
    </span>
  );
}

/**
 * The achievement ring.
 *
 * Drawn by hand rather than with a chart library: it must render identically at four sizes,
 * animate nothing, and never leave an empty frame when the value is null — which is exactly
 * where the first build's recharts panels failed.
 */
export function AchievementRing({
  value,
  size = 132,
  stroke = 11,
  label,
  dark = false,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  dark?: boolean;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Cap the ARC at 100% so an over-achiever cannot wrap the circle, while the printed
  // number below stays uncapped and truthful.
  const fraction = value == null ? 0 : Math.max(0, Math.min(1, value));
  const color = achievementHex(value);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={dark ? "rgba(148,163,184,0.22)" : "#E2E8F0"}
          strokeWidth={stroke}
        />
        {value != null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={`${circumference * fraction} ${circumference}`}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn("whitespace-nowrap font-black tabular-nums", dark ? "" : achievementTone(value))}
          style={{ fontSize: size / 4.6, color: dark ? color : undefined }}
        >
          {formatPct(value)}
        </span>
        {label ? (
          <span
            className={cn(
              "mt-0.5 whitespace-nowrap font-bold uppercase tracking-[0.14em]",
              dark ? "text-slate-400" : "text-muted-foreground",
            )}
            style={{ fontSize: Math.max(8, size / 15) }}
          >
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Horizontal proportion bar used in the ranked lists and product mix. */
export function ProportionBar({ fraction, color }: { fraction: number; color: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden bg-slate-200" aria-hidden>
      <span
        className="block h-full"
        style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, backgroundColor: color }}
      />
    </span>
  );
}

/** A bar and its number, for the achievement column of a table. */
export function AchievementCell({ value }: { value: number | null }) {
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <span className="h-1.5 w-20 shrink-0 overflow-hidden bg-slate-200" aria-hidden>
        <span
          className="block h-full"
          style={{
            width: `${(value == null ? 0 : Math.max(0, Math.min(1, value))) * 100}%`,
            backgroundColor: achievementHex(value),
          }}
        />
      </span>
      <span className={cn("w-16 text-right font-black tabular-nums", achievementTone(value))}>{formatPct(value)}</span>
    </div>
  );
}

/**
 * A stacked meter — the number over a full-width bar.
 *
 * `AchievementCell` above is the right shape for a WIDE achievement column: its bar is a fixed
 * 5rem and its number a fixed 4rem, which keeps a long ranked table's numbers on one optical
 * line. In a narrow column that fixed 9rem is a floor the cell cannot go below, and content
 * that overflows a `table-fixed` cell is exactly what puts a page into horizontal scroll. This
 * variant has no floor: the bar takes whatever width the column gives it.
 */
export function AchievementMeter({ value, align = "right" }: { value: number | null; align?: "left" | "right" }) {
  return (
    <div className="w-full">
      <p className={cn("whitespace-nowrap font-black tabular-nums", achievementTone(value), align === "right" ? "text-right" : "text-left")}>
        {formatPct(value)}
      </p>
      <span className="mt-1 block h-1.5 w-full overflow-hidden bg-slate-200" aria-hidden>
        <span
          className="block h-full"
          style={{
            width: `${(value == null ? 0 : Math.max(0, Math.min(1, value))) * 100}%`,
            backgroundColor: achievementHex(value),
          }}
        />
      </span>
    </div>
  );
}

export function SectionCard({
  title,
  subtitle,
  icon: Icon,
  children,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col border border-border bg-card shadow-sm", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-orange-500" />
          <div className="min-w-0">
            <h2 className="whitespace-nowrap text-phx-md font-black tracking-tight text-foreground">{title}</h2>
            {subtitle ? <p className="whitespace-nowrap text-phx-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/**
 * The dark command band both target modules open with.
 *
 * The headline lives INSIDE the hero rather than in a row of separate flat tiles below it,
 * so the page starts with the answer instead of with chrome. `stats` are the big numbers,
 * `ring` is the achievement dial on the right, and `footer` is the period/line selector
 * strip that sits on the band's bottom edge.
 */
export function CommandBand({
  kicker,
  title,
  subtitle,
  stats,
  ring,
  aside,
  footer,
}: {
  kicker: string;
  title: string;
  subtitle: string;
  stats?: React.ReactNode;
  ring?: React.ReactNode;
  aside?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border border-slate-800 bg-slate-900">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/90 to-orange-500/0"
      />
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-orange-500/10 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-sky-500/10 blur-3xl" />

      <div className="relative flex flex-col gap-6 px-5 py-6 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.28em] text-orange-400">{kicker}</p>
          <h1 className="mt-1 text-3xl font-black leading-none tracking-tight text-white sm:text-[2.3rem]">{title}</h1>
          <p className="mt-2 text-sm text-slate-400">{subtitle}</p>
          {stats ? <div className="mt-5 flex flex-wrap items-end gap-x-9 gap-y-4">{stats}</div> : null}
        </div>
        {ring || aside ? (
          <div className="flex shrink-0 items-center gap-6">
            {ring}
            {aside ? <div className="hidden sm:block">{aside}</div> : null}
          </div>
        ) : null}
      </div>
      {footer ? (
        <div className="relative flex flex-wrap items-center gap-1.5 border-t border-slate-800 px-5 py-2.5 sm:px-8">{footer}</div>
      ) : null}
    </section>
  );
}

/** One big number in the command band. */
export function BandStat({
  label,
  value,
  note,
  tone = "white",
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: "white" | "sky" | "amber";
}) {
  return (
    <div>
      <p className="text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">{label}</p>
      <p
        className={cn(
          "mt-0.5 whitespace-nowrap text-3xl font-black tabular-nums",
          tone === "sky" ? "text-sky-300" : tone === "amber" ? "text-amber-300" : "text-white",
        )}
      >
        {value}
      </p>
      {note ? <p className="mt-1 text-phx-xs text-slate-400">{note}</p> : null}
    </div>
  );
}

/** The selector chips that sit on the command band's bottom rail. */
export function BandChoice({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: string;
  onSelect: (value: string) => void;
}) {
  return (
    <>
      <span className="mr-1 whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-500">
        {label}
      </span>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(option.value)}
          className={cn(
            "whitespace-nowrap border px-3 py-1 text-xs font-bold transition-colors",
            option.value === selected
              ? "border-orange-500 bg-orange-500 text-white"
              : "border-slate-700 bg-slate-800/60 text-slate-300 hover:border-orange-400 hover:text-white",
          )}
        >
          {option.label}
        </button>
      ))}
    </>
  );
}
