"use client";

import { createContext, useContext } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingNavyBoard,
  LandingTick,
} from "@/components/employee-portal/landing-kit";
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
// THE PORTAL RENDER (owner, 2026-11-20 — "EVERY SINGLE COMPONENT TO BE PREMIUM POLISHED"): the
// `surface="portal"` render is built from the portal's landing kit (`landing-kit.tsx`). The page's
// headline figures stand on ONE night-navy board, every other card is a white sheet on a hairline
// with the platform's soft depth token and the orange tick before its title, chosen chips are navy,
// and the achievement ring is flat. It replaced the 2026-09-21 gradient cards, orange rails and
// glowing ring: the kit is flat colour only. Square edges and no horizontal scroll, as ever.
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

/** A white card: the hairline and the platform's soft depth token, square edges. */
export const SURFACE_CLASS = `border border-slate-200 bg-white ${adminSoftDepthClassName}`;
/**
 * Table header row: white small capitals over a hairline. The type size and tracking are the ones the
 * column widths in tests/sales-target-tables-fit-the-screen.test.ts were measured with.
 */
export const TABLE_HEAD_CLASS =
  "border-b border-slate-200 bg-white text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";
/** Table body row: a hairline under it and a quiet slate wash on hover. */
export const TABLE_ROW_CLASS =
  "border-b border-slate-200 transition-colors last:border-0 hover:bg-slate-50 motion-reduce:transition-none";
/** Chart tooltip box. */
export const CHART_TOOLTIP_CLASS = `border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 ${adminSoftDepthClassName}`;
/** Small uppercase label above a figure. */
export const LABEL_CLASS = "text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500";

/**
 * A selectable chip or tab.
 *
 * `surface="portal"` is the landing kit's chip: solid night navy when chosen, a white chip on a
 * hairline otherwise that takes a navy frame on hover, the kit's orange keyboard outline, and a 40px
 * tap target below lg — at `py-1` the chip is about 26px, under a phone's tap floor — dropping back to
 * its own height from lg. The default ("sales") returns exactly the class string it always has, so
 * every admin-shell chip is unchanged.
 */
export function chipClass(selected: boolean, surface: "sales" | "portal" = "sales"): string {
  if (surface === "portal") {
    return cn(
      "min-h-10 border px-3 py-1 text-xs font-bold transition-colors motion-reduce:transition-none lg:min-h-0",
      LANDING_FOCUS,
      selected
        ? "border-[#08111f] bg-[#08111f] text-white"
        : "border-slate-200 bg-white text-slate-600 hover:border-[#08111f] hover:text-[#08111f]",
    );
  }
  return cn(
    "border px-3 py-1 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500",
    selected
      ? "border-orange-500 bg-orange-500 text-white shadow-[0_2px_8px_rgba(249,115,22,0.25)]"
      : "border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700",
  );
}

/**
 * Where a band's figures are standing: on white, or on the portal's one night-navy board. The portal
 * CommandBand sets "navy" around its `stats`, so a BandStat or GrowthPill handed in by any page
 * re-inks itself for the board without the page knowing.
 */
const BandGround = createContext<"light" | "navy">("light");

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

/** The same growth scale on the navy board, where the 600s read too dark. */
function growthToneOnNavy(value: number | null): string {
  if (value == null || value === 0) return "text-white/55";
  return value > 0 ? "text-emerald-300" : "text-rose-300";
}

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * The growth figure: its arrow and its signed percentage in the growth colour — coloured words, never
 * a filled pill. The box keeps the padding its width was measured with
 * (tests/sales-target-tables-fit-the-screen.test.ts).
 */
export function GrowthPill({ value }: { value: number | null }) {
  const ground = useContext(BandGround);
  const Icon = value == null ? Minus : value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5 text-xs font-bold tabular-nums",
        ground === "navy" ? growthToneOnNavy(value) : growthTone(value),
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
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
   * The employee-portal ring. It used to carry a gradient stroke, a round cap and a glow (2026-09-21);
   * the landing kit is flat colour only (owner, 2026-11-20), so the portal ring is the flat ring on
   * the kit's hairline track. Both keep the null-is-neutral and arc-capped-at-100% rules identically.
   */
  premium?: boolean;
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
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={premium ? "#E2E8F0" : "#F1F5F9"} strokeWidth={stroke} />
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
        <span className={cn("whitespace-nowrap font-black tabular-nums", achievementTone(value))} style={{ fontSize: size / 4.6 }}>
          {formatPct(value)}
        </span>
        {label ? (
          <span
            className="mt-0.5 whitespace-nowrap font-bold uppercase tracking-[0.1em] text-slate-500"
            // 11px is the type floor; "ACHIEVEMENT" at 11px is ~92px inside a 132px ring's 106px hole.
            style={{ fontSize: Math.max(11, size / 15) }}
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
            {subtitle ? <p className="phx-header-note text-phx-xs text-slate-500">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="max-w-full">{actions}</div> : null}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/**
 * SectionCard's employee-portal header — the landing kit's panel head: the orange tick and the title
 * in navy small capitals, the actions on the right, no icon square. Declared AFTER SectionCard on
 * purpose: the pinning tests read the first card header in this file, and that stays the measured
 * admin one. This header keeps every rule those tests hold — it wraps, its actions are never
 * `shrink-0`, its title never nowraps. The subtitle keeps its `phx-header-note` marker, which the
 * portal shell hides (owner, 2026-11-20: no sentence under any header).
 */
function PortalSectionCard({ title, subtitle, children, actions, className }: SectionCardProps) {
  return (
    <section className={cn("flex min-w-0 flex-col", SURFACE_CLASS, className)}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-3 py-2.5 sm:px-4">
        <div className="min-w-0">
          <h2 className={cn("flex min-w-0 items-center gap-2 break-words text-phx-xs font-black uppercase tracking-[0.12em]", LANDING_INK)}>
            <LandingTick />
            <span className="min-w-0">{title}</span>
          </h2>
          {subtitle ? <p className="phx-header-note mt-1 break-words text-sm font-medium leading-6 text-slate-500">{subtitle}</p> : null}
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
      <div className="space-y-3">
        {subtitle ? <p className="phx-header-note text-sm font-medium leading-6 text-slate-500">{subtitle}</p> : null}
        {stats ? (
          // The page's ONE night-navy board, holding its headline figures (the landing kit's rule).
          // Each BandStat inside reads the "navy" ground and draws itself as a board tile.
          //
          // Flex-wrap, never a fixed grid, and crucially NO `min-w-0` on the tiles: a headline money
          // value carries `whitespace-nowrap`, so its own min-content is the tile's floor — the tile
          // can never be squeezed narrower than the number, which would clip it. `flex-1
          // basis-[13rem]` (on BandStat's tile) lets each tile grow to fill the row and share width
          // evenly, and when the numbers no longer fit side by side the tiles wrap to the next line
          // instead of overflowing the page (the fits-the-screen golden rule). And NO
          // `overflow-hidden`: it makes each tile a scroll container whose minimum flex width drops
          // to 0, which CUT the money ("EGP 1,234,567" on a 768px tablet, "EGP 486,000" on Make It
          // Happen at 1280px).
          <BandGround.Provider value="navy">
            <LandingNavyBoard label={title}>
              <div className="flex flex-wrap gap-2">{stats}</div>
            </LandingNavyBoard>
          </BandGround.Provider>
        ) : null}
        {ring || aside || footer ? (
          <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
            {footer ? (
              <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 px-3 py-2.5 sm:px-4">{footer}</div>
            ) : null}
            {ring || aside ? (
              <div className="flex flex-wrap items-center gap-6 px-4 py-4 sm:px-5">
                {ring}
                {/* `basis-[8rem]` and NO `min-w-0`: the aside's nowrap figure is its own floor, so when
                    ring + aside no longer fit side by side the aside WRAPS under the ring. With
                    `min-w-0` it was squeezed instead, and "100.0%" was cut at the panel edge on a
                    small Android phone on Large text (~280px CSS wide). */}
                {aside ? <div className="flex-1 basis-[8rem]">{aside}</div> : null}
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
          <p className="phx-header-note mt-1.5 text-sm text-slate-500">{subtitle}</p>
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
  const ground = useContext(BandGround);
  if (ground === "navy") {
    // A tile on the portal's navy board: the label in dim white capitals, the figure white (sky and
    // amber in their light shades), its tone on a 2px rail down the tile's left edge.
    return (
      <div className={cn("relative flex-1 basis-[13rem] border border-white/[0.08] py-3 pl-3.5 pr-3", LANDING_NAVY_TILE)}>
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-0 left-0 w-0.5", tone === "sky" ? "bg-sky-400" : tone === "amber" ? "bg-amber-400" : "bg-white/30")}
        />
        <p className="text-phx-xs font-bold uppercase tracking-[0.08em] text-white/65">{label}</p>
        <p
          className={cn(
            "mt-1.5 whitespace-nowrap text-[26px] font-bold leading-none tracking-[-0.02em] tabular-nums",
            tone === "sky" ? "text-sky-300" : tone === "amber" ? "text-amber-300" : "text-white",
          )}
        >
          {value}
        </p>
        {note ? <p className="mt-1.5 break-words text-phx-xs font-medium leading-snug text-white/55">{note}</p> : null}
      </div>
    );
  }
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
      <span className="mr-1 whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
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
