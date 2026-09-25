"use client";

import { useId } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The shared visual language of the SALES PERFORMANCE modules.
//
// Sales vs Target, Targets, Make It Happen and Source of Sales each render in BOTH shells
// (admin and employee portal). The primitives below are the one place their look is decided,
// so the four screens read as one product — `tests/target-visuals-shared.test.ts` fails if a
// target module re-declares its own copy.
//
// THE LOOK (owner, 2026-09-14): the "sales" (admin-shell) surface is light, clean Phoenix orange.
// White surfaces, thin slate borders, orange for accents and the selected state, calm dark numbers.
// No dark bands, no glows, no gradients — and, the square-edge golden rule, no rounded corners
// anywhere. That rule governs the DEFAULT `surface="sales"` band and every admin render, which stay
// byte-identical.
//
// THE PORTAL PREMIUM (owner, 2026-09-21 — "full big premium polish"): the `surface="portal"` render
// is the one owner-approved exception. Grounded in the same Phoenix tokens, it earns depth from
// LAYERED SHADOWS, a SUBTLE white→slate card gradient, a gradient orange accent rail and a GLOWING
// achievement ring (AchievementRing `premium`). The square-edge golden rule still holds — no rounded
// corners, no horizontal scroll. Do NOT bring this surface "into line" with the 2026-09-14 rule: it
// was shown to the owner and approved.
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

// ── Surface tokens — use these instead of re-inventing a card ────────────────

/** A white card: thin border, a soft two-layer shadow, square edges. */
export const SURFACE_CLASS =
  "border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_rgba(15,23,42,0.05)]";
/** Table header row. */
export const TABLE_HEAD_CLASS =
  "border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";
/** Table body row. */
export const TABLE_ROW_CLASS = "border-b border-slate-100 transition-colors last:border-0 hover:bg-orange-50/40";
/** Chart tooltip box. */
export const CHART_TOOLTIP_CLASS =
  "border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-[0_8px_24px_rgba(15,23,42,0.10)]";
/** Small uppercase label above a figure. */
export const LABEL_CLASS = "text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500";

/**
 * A selectable chip or tab: solid orange when selected, quiet white otherwise.
 *
 * `surface="portal"` makes it a 40px tap target below lg — at `py-1` the chip is about 26px, under a
 * phone's tap floor — and lets it drop back to its own height from lg. The default ("sales") returns
 * exactly the class string it always has, so every admin-shell chip is unchanged.
 */
export function chipClass(selected: boolean, surface: "sales" | "portal" = "sales"): string {
  return cn(
    "border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500",
    surface === "portal" && "min-h-10 lg:min-h-0",
    selected
      ? "border-orange-500 bg-orange-500 text-white shadow-[0_2px_8px_rgba(249,115,22,0.25)]"
      : "border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700",
  );
}

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

export function GrowthPill({ value }: { value: number | null }) {
  const Icon = value == null ? Minus : value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  const surface =
    value == null || value === 0
      ? "bg-slate-50 ring-slate-200"
      : value > 0
        ? "bg-emerald-50 ring-emerald-100"
        : "bg-red-50 ring-red-100";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs font-bold ring-1 ring-inset",
        surface,
        growthTone(value),
      )}
    >
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
  premium = false,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  /**
   * The employee-portal premium ring: a same-hue gradient stroke, a round cap and a soft glow in
   * the ring's OWN achievement colour (owner-approved 2026-09-21). `false` is the flat admin ring,
   * unchanged. Both keep the null-is-neutral and arc-capped-at-100% rules identically.
   */
  premium?: boolean;
}) {
  // Unique per instance — a page draws several rings and must not share one gradient/filter id.
  // useId returns colon-bearing ids; strip them so the SVG url(#…) reference is always valid.
  const uid = useId().replace(/:/g, "");
  const gradientId = `ring-grad-${uid}`;
  const glowId = `ring-glow-${uid}`;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Cap the ARC at 100% so an over-achiever cannot wrap the circle, while the printed
  // number below stays uncapped and truthful.
  const fraction = value == null ? 0 : Math.max(0, Math.min(1, value));
  const color = achievementHex(value);
  const arcPremium = premium && value != null;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        {arcPremium ? (
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.7" />
              <stop offset="1" stopColor={color} />
            </linearGradient>
            <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation={Math.max(1.6, stroke / 5)} result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
        ) : null}
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={premium ? "#EEF2F7" : "#F1F5F9"} strokeWidth={stroke} />
        {value != null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={arcPremium ? `url(#${gradientId})` : color}
            strokeWidth={stroke}
            strokeLinecap={arcPremium ? "round" : "butt"}
            strokeDasharray={`${circumference * fraction} ${circumference}`}
            filter={arcPremium ? `url(#${glowId})` : undefined}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("whitespace-nowrap font-black tabular-nums", achievementTone(value))} style={{ fontSize: size / 4.6 }}>
          {formatPct(value)}
        </span>
        {label ? (
          <span
            className="mt-0.5 whitespace-nowrap font-bold uppercase tracking-[0.14em] text-slate-500"
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
    <span className="block h-1.5 w-full overflow-hidden bg-slate-100" aria-hidden>
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
      <span className="h-1.5 w-20 shrink-0 overflow-hidden bg-slate-100" aria-hidden>
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
      <span className="mt-1 block h-1.5 w-full overflow-hidden bg-slate-100" aria-hidden>
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

type SectionCardProps = {
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
};

export function SectionCard({
  title,
  subtitle,
  icon: Icon,
  children,
  actions,
  className,
  surface = "sales",
}: SectionCardProps & {
  /**
   * "sales" (default) is the module's compact card header — the admin-shell look, unchanged.
   * "portal" gives the header the employee-portal section scale (PortalSection's 18–20px title and
   * 14px description) so the sales pages read as one portal identity, the way CommandBand's
   * `surface="portal"` already does for the page header. Same wrapping rules, same square edges.
   */
  surface?: "sales" | "portal";
}) {
  if (surface === "portal") {
    return (
      <PortalSectionCard title={title} subtitle={subtitle} icon={Icon} actions={actions} className={className}>
        {children}
      </PortalSectionCard>
    );
  }
  return (
    <section className={cn("flex flex-col", SURFACE_CLASS, className)}>
      {/*
        The header WRAPS, and the actions block is not `shrink-0`. Both halves of that are
        load-bearing at 375px. `shrink-0` guarantees the actions keep their max-content width,
        so a `flex-wrap` row inside them is never handed a narrow box and can never wrap — on
        /sales/vs-target that pushed the "District Managers" and "Products" tabs 78px and 151px
        past the shell's clip edge, where the page does NOT scroll (main read 526/375 while the
        document read 375/375), so the two tabs were unreachable on a phone rather than merely
        cut. Wrapping is the permitted answer under the fits-the-screen golden rule; nothing
        here shrinks type. Measured 2026-09-05.
      */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-100 bg-white px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-orange-50 text-orange-600 ring-1 ring-inset ring-orange-100">
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            {/* No `whitespace-nowrap`: this sits in a `min-w-0` box, so nowrap could only ever
                clip a long title instead of wrapping it. */}
            <h2 className="text-phx-md font-black tracking-tight text-slate-900">{title}</h2>
            {subtitle ? <p className="text-phx-xs text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="max-w-full">{actions}</div> : null}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/**
 * SectionCard's employee-portal header. Declared AFTER SectionCard on purpose: the pinning tests
 * read the first card header in this file, and that stays the measured admin one. This header keeps
 * every rule those tests hold — it wraps, its actions are never `shrink-0`, its title never nowraps.
 */
function PortalSectionCard({ title, subtitle, icon: Icon, children, actions, className }: SectionCardProps) {
  return (
    <section className={cn("flex flex-col", SURFACE_CLASS, className)}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-slate-100 bg-white px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-orange-50 text-orange-600 ring-1 ring-inset ring-orange-100">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="break-words text-lg font-black leading-tight tracking-tight text-slate-950 sm:text-xl">{title}</h2>
            {subtitle ? <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="max-w-full">{actions}</div> : null}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/**
 * The page header every sales performance module opens with.
 *
 * Light: a white surface with an orange top rule. The headline lives INSIDE the header rather
 * than in a row of separate flat tiles below it, so the page starts with the answer instead of
 * with chrome. `stats` are the big numbers, `ring` is the achievement dial on the right, and
 * `footer` is the period/line selector strip on the header's bottom edge.
 */
export function CommandBand({
  kicker,
  title,
  subtitle,
  stats,
  ring,
  aside,
  footer,
  besideFrom = "lg",
  surface = "sales",
}: {
  kicker: string;
  title: string;
  subtitle: React.ReactNode;
  stats?: React.ReactNode;
  ring?: React.ReactNode;
  aside?: React.ReactNode;
  footer?: React.ReactNode;
  /**
   * The width from which the ring and aside sit BESIDE the headline rather than below it. In the
   * employee portal a 1024px screen leaves the page 621px next to the sidebar, and a ring plus an
   * aside there squeezed the headline column to 100px (measured 2026-09-16) — a portal page that
   * carries both passes "xl".
   */
  besideFrom?: "lg" | "xl";
  /**
   * "sales" (default) is the module's own light command band — the admin-shell look, unchanged.
   * "portal" drops that band entirely: the employee-portal page renders the standard navy shell
   * hero above (its `kicker`/`title` live there), and this lays the SAME stat, ring and selector
   * nodes out as portal-native white cards and a panel below it, so the four sales pages read as
   * one employee-portal identity. Owner decision 2026-09-21. The `kicker` and `title` are ignored
   * here on purpose — the shell hero already carries them.
   */
  surface?: "sales" | "portal";
}) {
  if (surface === "portal") {
    return (
      <div className="space-y-4">
        {subtitle ? <p className="text-sm font-medium leading-6 text-slate-500">{subtitle}</p> : null}
        {stats ? (
          // Flex-wrap, never a fixed grid, and crucially NO `min-w-0`: a headline money value carries
          // `whitespace-nowrap`, so its own min-content is the card's floor — the card can never be
          // squeezed narrower than the number, which would clip it. `flex-1 basis-[13rem]` lets each
          // card grow to fill the row and share width evenly, and when the numbers no longer fit side
          // by side the cards wrap to the next line instead of overflowing the page (the fits-the-
          // screen golden rule). This mirrors the light band's own content-sized `flex flex-wrap`.
          //
          // Premium (owner, 2026-09-21): each card earns depth from a subtle white→slate gradient, a
          // gradient orange accent rail on its left edge, a two-layer shadow and a small hover lift.
          // Square edges throughout — the fit logic above is untouched.
          //
          // And NO `overflow-hidden` on the cards: it makes each card a scroll container, whose
          // minimum flex width drops to 0, so the nowrap figure stopped setting the floor and the
          // cards packed at their 13rem basis and CUT the money — "EGP 1,234,567" on a 768px tablet,
          // "EGP 486,000" on Make It Happen at 1280px. Nothing inside a card needs clipping.
          <div className="flex flex-wrap gap-3.5 [&>div]:relative [&>div]:flex-1 [&>div]:basis-[13rem] [&>div]:border [&>div]:border-slate-200/80 [&>div]:border-l-[3px] [&>div]:border-l-orange-500 [&>div]:bg-gradient-to-b [&>div]:from-white [&>div]:to-slate-50/70 [&>div]:px-4 [&>div]:py-3.5 [&>div]:shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_28px_rgba(15,23,42,0.06)] [&>div]:transition-transform [&>div]:duration-200 hover:[&>div]:-translate-y-0.5">
            {stats}
          </div>
        ) : null}
        {ring || aside || footer ? (
          <section className="relative overflow-hidden border border-slate-200/90 bg-gradient-to-b from-white to-slate-50/40 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_20px_48px_rgba(15,23,42,0.08)]">
            {/* Premium orange accent rail — echoes the navy hero's orange top rule. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-orange-500 via-orange-400 to-transparent"
            />
            {footer ? (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-white/60 px-4 py-3">{footer}</div>
            ) : null}
            {ring || aside ? (
              <div className="flex flex-wrap items-center gap-6 px-5 py-5">
                {ring}
                {aside ? <div className="min-w-0 flex-1">{aside}</div> : null}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    );
  }

  return (
    // SURFACE_CLASS first: tailwind-merge lets the LATER class win, so the orange top rule must
    // come after the surface's all-sides `border border-slate-200` or it is silently dropped.
    <section className={cn(SURFACE_CLASS, "relative border-t-[3px] border-t-orange-500")}>
      <div
        className={cn(
          "flex flex-col gap-6 px-5 py-5 sm:px-7 sm:py-6",
          besideFrom === "xl"
            ? "xl:flex-row xl:items-center xl:justify-between"
            : "lg:flex-row lg:items-center lg:justify-between",
        )}
      >
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.24em] text-orange-600">{kicker}</p>
          <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight text-slate-900 sm:text-[2.2rem]">{title}</h1>
          <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>
          {stats ? <div className="mt-5 flex flex-wrap items-end gap-x-10 gap-y-4">{stats}</div> : null}
        </div>
        {ring || aside ? (
          <div className="flex shrink-0 items-center gap-6">
            {ring}
            {aside ? <div className="hidden sm:block">{aside}</div> : null}
          </div>
        ) : null}
      </div>
      {footer ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50/70 px-5 py-2.5 sm:px-7">{footer}</div>
      ) : null}
    </section>
  );
}

/** One big number in the page header. */
export function BandStat({
  label,
  value,
  note,
  tone = "white",
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  /** "white" is the default ink (kept as the name so existing callers need no change). */
  tone?: "white" | "sky" | "amber";
}) {
  return (
    <div>
      <p className={LABEL_CLASS}>{label}</p>
      <p
        className={cn(
          "mt-0.5 whitespace-nowrap text-3xl font-black tabular-nums",
          tone === "sky" ? "text-sky-600" : tone === "amber" ? "text-amber-600" : "text-slate-900",
        )}
      >
        {value}
      </p>
      {note ? <p className="mt-1 text-phx-xs text-slate-500">{note}</p> : null}
    </div>
  );
}

/** The selector chips that sit on the header's bottom rail. */
export function BandChoice({
  label,
  options,
  selected,
  onSelect,
  surface = "sales",
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: string;
  onSelect: (value: string) => void;
  /** "portal" gives the chips their phone tap height; see chipClass. The default is the admin chip. */
  surface?: "sales" | "portal";
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
          aria-pressed={option.value === selected}
          onClick={() => onSelect(option.value)}
          className={cn("whitespace-nowrap", chipClass(option.value === selected, surface))}
        >
          {option.label}
        </button>
      ))}
    </>
  );
}
