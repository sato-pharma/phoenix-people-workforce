import Link from "next/link";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { cn } from "@/lib/utils";

/**
 * THE LANDING KIT — the one set of parts every role's portal landing is built from.
 *
 * WHY IT EXISTS (owner, 2026-11-20): after the night-navy top bar ("A: night navy"), he asked for
 * the overview landing to be redesigned from scratch and polished end to end — "EVERY SINGLE
 * COMPONENT TO BE PREMIUM POLISHED". The Medical Rep's landing was rebuilt first. The District,
 * Regional and National Sales Managers, the Marketing Manager, the Product Managers and every other
 * role land on command centres made of SectionHead bars, keycards and leaderboards, each drawn its
 * own way. This file is the language they now share, so one landing cannot drift from the next.
 *
 * ## The language, in five rules
 *
 * 1. **Two inks and one accent.** Night navy `#08111f` for titles and figures, slate for labels,
 *    and the house orange `#F05A1A` ONLY as the short tick before a title and the 2px line on top of
 *    a navy board. Orange is never a fill behind words.
 * 2. **White panels, one navy board.** A panel is a white sheet with a hairline and the platform's
 *    soft depth token. Navy is kept for the one board on a page that holds that page's headline
 *    figures, so it stays an event rather than wallpaper.
 * 3. **Flat colour only.** No gradient, no glow, no grid texture, no drop-shadowed card on a card,
 *    no badge on a badge. Depth comes from `admin-design-tokens.ts` and nowhere else
 *    (`tests/employee-portal-premium-depth.test.ts`).
 * 4. **Square, and nothing is cut.** No round corner (the square-edge golden rule), no ellipsis, no
 *    sideways scroll: a long name wraps inside its own row. No type under 11px (`text-phx-xs`).
 * 5. **A header is a title.** No sentence under any header (owner, 2026-11-20: "DELETE ANY TEXT
 *    UNDER ANY HEADER"). What a panel needs to say goes in its rows.
 *
 * Every part is a plain server-compatible component (no hooks), so a client component can render
 * it as well.
 */

/** The night-navy ink every title and headline figure on a landing is set in. */
export const LANDING_INK = "text-[#08111f]";
/** The night-navy ground of a landing's one headline board — the top bar's own colour. */
export const LANDING_NAVY = "bg-[#08111f]";
/** One step lighter than the board: the ground its tiles stand on. */
export const LANDING_NAVY_TILE = "bg-[#0d1828]";
/**
 * The keyboard ring every landing link and button wears: a 2px orange outline outside the element,
 * shown only for keyboard focus (never on a tap), so it is the one place orange frames anything.
 */
export const LANDING_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F05A1A]";
/** The hover wash of a whole-row link, and its keyboard ring. */
export const LANDING_ROW_LINK = `transition-colors motion-reduce:transition-none hover:bg-slate-50 ${LANDING_FOCUS}`;

/** The short orange tick before every panel title — the tick of the rep's honour-strip footer. */
export function LandingTick({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("h-0.5 w-3 shrink-0 bg-[#F05A1A]", className)} />;
}

/** A panel title: the tick, then the words in navy capitals. Wraps, never clips. */
export function LandingTitle({ children, as: Tag = "h2" }: { children: React.ReactNode; as?: "h2" | "h3" }) {
  return (
    <Tag className="flex min-w-0 items-center gap-2 break-words text-phx-xs font-black uppercase tracking-[0.12em] text-[#08111f]">
      <LandingTick />
      <span className="min-w-0">{children}</span>
    </Tag>
  );
}

/**
 * The white panel every landing card sits in: a hairline frame, the soft depth token, and a header
 * that is the title alone (with an optional right-hand slot for a month or a count). The header
 * WRAPS, so a long title beside its chips drops the chips to a second line on a 280px phone rather
 * than squeezing either.
 */
export function LandingPanel({
  title,
  right,
  children,
  className,
  bodyClassName,
  id,
}: {
  title: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Padding for the body, when the body is not rows that carry their own. */
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section className={cn(`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`, className)} id={id}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <LandingTitle>{title}</LandingTitle>
        {/* slate-500 here is what SectionMeta, which takes its colour from its header, reads in. */}
        {right ? <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 text-slate-500">{right}</div> : null}
      </header>
      {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
    </section>
  );
}

/**
 * The headline board: night navy, one flat orange line on top. Holds a page's headline figures —
 * a manager's team keycards, the rep's month tiles. One per landing.
 */
export function LandingNavyBoard({
  label,
  right,
  children,
  className,
}: {
  /** Read by screen readers and shown as the board's own small header. */
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={label} className={cn(`min-w-0 border border-[#08111f] ${LANDING_NAVY} ${adminSoftDepthClassName}`, className)}>
      <div aria-hidden="true" className="h-0.5 w-full bg-[#F05A1A]" />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-1 pt-2.5">
        <h2 className="min-w-0 break-words text-phx-sm font-bold uppercase tracking-[0.12em] text-white/70">{label}</h2>
        {right ? <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{right}</div> : null}
      </div>
      <div className="p-2">{children}</div>
    </section>
  );
}

/** The small capitals that name a window or a count in a header's right slot: "JUL 2026 · 12 REPS". */
export function LandingMeta({ items, onNavy = false }: { items: readonly (string | null | undefined)[]; onNavy?: boolean }) {
  const shown = items.filter((item): item is string => Boolean(item && item.trim()));
  if (shown.length === 0) return null;
  return (
    <span
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.08em]",
        onNavy ? "text-white/45" : "text-slate-500",
      )}
    >
      {shown.map((item, index) => (
        <span className="flex items-center gap-2" key={`${item}-${index}`}>
          {index > 0 ? (
            <span aria-hidden="true" className={onNavy ? "text-white/25" : "text-slate-300"}>
              ·
            </span>
          ) : null}
          {item}
        </span>
      ))}
    </span>
  );
}

/**
 * One fact per row: the label on the left, the value on the right. A long label wraps inside its own
 * row, and the value keeps at most 60% so neither can push the other off the screen.
 */
export function LandingRow({
  label,
  value,
  tone,
  sub,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  /** A text colour for the value — the tone scale's 700s on white. Navy when absent. */
  tone?: string;
  /** One quiet line under the label, when the row needs it. */
  sub?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-slate-200 px-3 py-2.5 last:border-b-0 sm:px-4">
      <div className="min-w-0">
        <p className="break-words text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-500">{label}</p>
        {sub ? <p className="mt-0.5 break-words text-phx-xs text-slate-400">{sub}</p> : null}
      </div>
      <p className={cn("max-w-[60%] break-words text-right text-phx-md font-bold tabular-nums", tone ?? LANDING_INK)}>{value}</p>
    </div>
  );
}

/** A headline figure: big, tight, tabular. `onNavy` sets it white for the board. */
export function LandingFigure({
  children,
  unit,
  onNavy = false,
  size = "lg",
  tone,
}: {
  children: React.ReactNode;
  unit?: React.ReactNode;
  onNavy?: boolean;
  size?: "md" | "lg";
  tone?: string;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-1">
      <span
        className={cn(
          "break-words font-bold tracking-[-0.02em] tabular-nums",
          // The leading goes AFTER the size: tailwind-merge drops a leading-* that comes before a
          // font-size class, which left every headline figure at the body's line height.
          size === "lg" ? "text-[28px] leading-none" : "text-[22px] leading-none",
          tone ?? (onNavy ? "text-white" : LANDING_INK),
        )}
      >
        {children}
      </span>
      {unit ? <span className={cn("text-phx-sm font-bold", onNavy ? "text-white/45" : "text-slate-400")}>{unit}</span> : null}
    </span>
  );
}

/** The tone scale on white and on navy. One scale everywhere, so a red here means what it means elsewhere. */
export function landingTone(pct: number): { fill: string; text: string; onNavyText: string; onNavyFill: string } {
  if (pct >= 100) return { fill: "bg-emerald-500", text: "text-emerald-700", onNavyText: "text-emerald-300", onNavyFill: "bg-emerald-400" };
  if (pct >= 90) return { fill: "bg-amber-400", text: "text-amber-700", onNavyText: "text-amber-300", onNavyFill: "bg-amber-400" };
  if (pct >= 70) return { fill: "bg-orange-500", text: "text-orange-700", onNavyText: "text-orange-300", onNavyFill: "bg-orange-500" };
  return { fill: "bg-rose-500", text: "text-rose-700", onNavyText: "text-rose-300", onNavyFill: "bg-rose-400" };
}

/**
 * A 4px attainment bar with the 100% mark drawn at its end, so a bar reads against target. The fill
 * is clamped to the track; the figure beside it says how far past 100% it went.
 */
export function LandingBar({ pct, fill, onNavy = false }: { pct: number; fill?: string; onNavy?: boolean }) {
  const width = Math.max(0, Math.min(100, pct));
  return (
    <div className={cn("relative h-1 w-full", onNavy ? "bg-white/10" : "bg-slate-100")}>
      <div className={cn("h-full", fill ?? (onNavy ? landingTone(pct).onNavyFill : landingTone(pct).fill))} style={{ width: `${width}%` }} />
      <div aria-hidden="true" className={cn("absolute -bottom-1 -top-1 right-0 w-px", onNavy ? "bg-white/70" : "bg-[#08111f]/60")} />
    </div>
  );
}

/**
 * The kit's one action shape, for a `<button>` as much as a link: navy outline or navy solid, square,
 * 40px tall on a phone and 32px from `sm`, the orange focus outline, still under reduced motion.
 * LandingCta wears it; a client card's buttons call it, so no card keeps its own copy.
 */
export function landingActionClassName(variant: "outline" | "solid" = "outline", className?: string): string {
  return cn(
    "inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 border px-3 text-center text-phx-xs font-bold uppercase tracking-[0.08em] transition disabled:opacity-60 motion-reduce:transition-none sm:min-h-8",
    LANDING_FOCUS,
    variant === "solid"
      ? "border-[#08111f] bg-[#08111f] text-white hover:border-[#13233a] hover:bg-[#13233a]"
      : "border-[#08111f] text-[#08111f] hover:bg-[#08111f] hover:text-white",
    className,
  );
}

/**
 * The one button shape on a landing. `outline` is a navy frame that fills navy on hover; `solid` is
 * the filled navy for the single primary action of a card. 40px tall on a phone, where it is the
 * thing a thumb has to hit.
 */
export function LandingCta({
  href,
  children,
  variant = "outline",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "outline" | "solid";
  className?: string;
}) {
  return (
    <Link
      className={landingActionClassName(variant, className)}
      href={href}
    >
      {children}
    </Link>
  );
}

/**
 * One line inside a panel that states a condition — all clear, could not be read, nobody yet — with
 * its tone on a 4px rail at the left instead of a tinted box. The words stay slate and wrap.
 */
export function LandingRailLine({ rail, children }: { rail: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 px-3 py-3.5 sm:px-4">
      <span aria-hidden="true" className={cn("w-1 shrink-0 self-stretch", rail)} />
      <p className="min-w-0 break-words text-phx-sm leading-snug text-slate-600">{children}</p>
    </div>
  );
}

/** What a panel says when it has nothing to show: one calm line, never an empty square. */
export function LandingEmpty({ children, onNavy = false }: { children: React.ReactNode; onNavy?: boolean }) {
  return (
    <p className={cn("break-words px-3 py-4 text-phx-sm leading-snug sm:px-4", onNavy ? "text-white/45" : "text-slate-500")}>{children}</p>
  );
}

/** The loading shape of a panel: its real header, two shimmer rows where the body will be. */
export function LandingPanelLoading({ title }: { title: React.ReactNode }) {
  return (
    <LandingPanel title={title}>
      <div aria-busy="true" className="space-y-2 px-3 py-3 sm:px-4">
        <span className="sr-only">Loading</span>
        <div aria-hidden="true" className="employee-portal-skeleton h-4 w-3/4" />
        <div aria-hidden="true" className="employee-portal-skeleton h-4 w-1/2" />
      </div>
    </LandingPanel>
  );
}

/**
 * A navy board while its figures stream: the board's real header, and two dim shimmer bars where
 * the tiles will be, so the board does not jump from a white loader to navy when it lands.
 */
export function LandingNavyBoardLoading({ label }: { label: string }) {
  return (
    <LandingNavyBoard label={label}>
      <div aria-busy="true" className="space-y-3 px-1 py-2">
        <span className="sr-only">Loading</span>
        <div aria-hidden="true" className="employee-portal-skeleton h-[28px] w-24 opacity-20" />
        <div aria-hidden="true" className="employee-portal-skeleton h-1 w-full opacity-20" />
      </div>
    </LandingNavyBoard>
  );
}
