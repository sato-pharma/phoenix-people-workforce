/**
 * The Talent Acquisition overview's own frame — one panel, one caption rule, one notice, one empty
 * state — so every block on her page is cut from the same cloth.
 *
 * WHY A FRAME AT ALL (owner, 2026-10-16: "now this view is awful", then "do a fucken wide big
 * hilarious full end to end sweep from scratch premium polish to her overview"). What he called
 * awful was not any one card: it was two card families, two gaps and three header styles on one
 * screen. So every surface below the identity strip takes its frame from here, and a new panel is a
 * new child of `TaPanel`, never a fourth look.
 *
 * THE VOCABULARY IS THE PLATFORM'S, NOT A ONE-OFF. Depth is `adminPanelDepthClassName` (his
 * 2026-09-08 premium rule: real depth, sharp corners), the accent edge fades the way the page-header
 * rail does, and the captions are the micro-caps every HR landing page already uses. The Phoenix
 * tones are below (`TA_TONE`); amber still means "waiting" and rose "a problem" on every figure.
 *
 * SQUARE EDGES, NO ELLIPSIS, NO SIDEWAYS SCROLL. Nothing here sets a radius; a long name WRAPS
 * (`break-words`), never cuts; nothing sets a minimum width.
 */

import { ArrowUpRight, TriangleAlert, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { adminChipDepthClassName, adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";

/** The micro-caps every label on the page wears. One string, so no label drifts a pixel. */
export const TA_CAPS_CLASS = "text-[10px] font-black uppercase tracking-[0.16em]";

/**
 * A row in a Today panel that opens its record. One string for the three panels' rows, so hover and
 * KEYBOARD focus are the same everywhere: the warm tint alone is ~1.05:1 against white, which is no
 * focus indicator at all, so the ring is what a keyboard user sees.
 */
export const TA_ROW_LINK_CLASS =
  "group/row relative flex gap-3 px-4 py-3 transition-colors hover:bg-orange-50/40 focus-visible:bg-orange-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500";

/** A small count or state chip. Tone is meaning, never decoration. */
export function TaChip({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "amber" | "emerald" | "orange" | "rose" | "slate";
}) {
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    orange: "border-orange-200 bg-orange-50 text-orange-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    slate: "border-slate-200 bg-white text-slate-600",
  }[tone];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] tabular-nums ${toneClass} ${adminChipDepthClassName}`}
    >
      {children}
    </span>
  );
}

/**
 * THE PAGE'S TONES ARE PHOENIX'S, AND ONLY PHOENIX'S (owner, 2026-10-16). He asked for colour and
 * artistic touches ("her page is so pale and poor"), was shown a four-hue version — Sato blue,
 * violet, emerald — and turned it down the same evening: "too much like this, stick to phx
 * identity". So the colour on this page is the platform's own: near-black deepening into ember for
 * the one dark band, Phoenix orange for every edge, medallion, marker and watermark, and warm washes
 * of the same orange on white. Never a second hue for decoration. Amber, rose and emerald appear only
 * on FIGURES, where they are meanings set by the builder (waiting, a problem, good) — never themes.
 * Class strings are literals, because Tailwind cannot see a class built at runtime.
 */
export const TA_TONE = {
  diamond: "bg-orange-500",
  edge: "bg-[linear-gradient(90deg,#F97316_0%,#FB923C_38%,rgba(251,146,60,0.12)_100%)]",
  headerWash: "bg-[linear-gradient(135deg,#FFF7EF_0%,#FFFFFF_60%)]",
  label: "text-slate-900",
  mark: "text-orange-700",
  medallion: "border-orange-200 bg-[linear-gradient(135deg,#FFF7ED_0%,#FFEDD5_100%)] text-orange-600",
  rule: "bg-[linear-gradient(90deg,rgba(249,115,22,0.6)_0%,rgba(251,146,60,0.35)_14%,rgba(148,163,184,0.3)_45%,rgba(148,163,184,0)_100%)]",
} as const;

/**
 * The caption over a run of cards: an accent diamond, a label, an optional line saying what the run
 * answers, and a fading accent-to-slate rule under both. On the dark scoreboard it is drawn light.
 */
export function TaCaption({
  caption,
  dark = false,
  label,
}: {
  caption?: string;
  dark?: boolean;
  label: string;
}) {
  const tone = TA_TONE;
  return (
    <div className="mb-2 min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rotate-45 ${tone.diamond}`} />
        <span className={`${TA_CAPS_CLASS} ${dark ? "text-white" : tone.label}`}>{label}</span>
        {caption ? (
          <span className={`break-words text-[10px] font-semibold ${dark ? "text-slate-300" : "text-slate-500"}`}>
            {caption}
          </span>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        className={`mt-1.5 h-px w-full ${dark ? "bg-[linear-gradient(90deg,rgba(251,146,60,0.75)_0%,rgba(251,146,60,0.3)_18%,rgba(255,255,255,0.12)_50%,rgba(255,255,255,0)_100%)]" : tone.rule}`}
      />
    </div>
  );
}

/**
 * One panel: a white card with real depth, a thin orange edge on top, a header row, and a body.
 *
 * The header carries the title, an optional count chip, an optional quiet subtitle and, at the
 * right, the ONE link that opens the page where the work is done. The whole panel is not a link —
 * its rows are, and a link inside a link is invalid HTML.
 */
export function TaPanel({
  children,
  className = "",
  count,
  countTone = "orange",
  footer,
  href,
  hrefLabel,
  icon: Icon,
  id,
  subtitle,
  title,
}: {
  children: ReactNode;
  className?: string;
  count?: number | null;
  countTone?: "amber" | "emerald" | "orange" | "rose" | "slate";
  footer?: ReactNode;
  href?: string;
  hrefLabel?: string;
  icon: LucideIcon;
  id: string;
  subtitle?: string;
  title: string;
}) {
  const tone = TA_TONE;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={`@container relative flex min-w-0 flex-col overflow-hidden border border-slate-200/90 bg-white ${adminPanelDepthClassName} ${className}`}
      id={id}
    >
      <span aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] ${tone.edge}`} />
      {/* The header: the icon, the title with its count, the quiet subtitle UNDER the title, and the
          one link at the right. The subtitle has its own line so the link never wraps onto one of
          its own — at 1009px it did, and a header two rows tall for one link is clutter. The
          large faint icon in its corner is the panel's watermark: texture, never content. */}
      <header
        className={`relative flex items-start gap-2.5 overflow-hidden border-b border-slate-200/70 px-4 pb-3 pt-4 ${tone.headerWash}`}
      >
        <Icon
          aria-hidden="true"
          className={`pointer-events-none absolute -bottom-4 right-24 h-16 w-16 opacity-[0.07] ${tone.mark}`}
          strokeWidth={1.25}
        />
        <span
          className={`relative flex h-8 w-8 shrink-0 items-center justify-center border shadow-[0_4px_12px_rgba(15,23,42,0.08)] ${tone.medallion}`}
        >
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        <div className="relative min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className={`${TA_CAPS_CLASS} text-slate-950`} id={`${id}-title`}>
              {title}
            </h2>
            {/* A count of zero is not drawn: the empty state below already says "none", and a "0"
                chip beside it is the same answer twice. */}
            {typeof count === "number" && count > 0 ? (
              <TaChip tone={countTone}>{count.toLocaleString("en-US")}</TaChip>
            ) : null}
          </div>
          {subtitle ? (
            <p className="mt-1 break-words text-[10px] font-bold uppercase tracking-[0.1em] text-slate-500">
              {subtitle}
            </p>
          ) : null}
        </div>
        {/* On a phone-narrow panel the words step aside and the arrow stands in a bordered square,
            so the TITLE keeps its line; the words stay the link's accessible name either way. */}
        {href && hrefLabel ? (
          <Link
            aria-label={hrefLabel}
            className="relative mt-0.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap border border-orange-200 bg-orange-50/60 p-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-orange-700 transition-colors hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 @min-[420px]:border-transparent @min-[420px]:bg-transparent @min-[420px]:px-1.5 @min-[420px]:py-1 @min-[420px]:hover:border-orange-200 @min-[420px]:hover:bg-orange-50"
            href={href}
          >
            <span aria-hidden="true" className="hidden @min-[420px]:inline">
              {hrefLabel}
            </span>
            <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
          </Link>
        ) : null}
      </header>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      {footer ? (
        <footer className="border-t border-slate-200/70 bg-[#FBFAF8] px-4 py-2.5 text-[10px] font-semibold leading-relaxed text-slate-500">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

/**
 * A read that failed, SAID — inside the panel that needed it. Never an empty list: "nothing today"
 * drawn over a failed read is the one wrong answer a landing page can give.
 */
export function TaCouldNotLoad({ what }: { what: string }) {
  return (
    <div className="m-4 flex items-start gap-2.5 border border-amber-200 bg-amber-50 px-3.5 py-3">
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <p className="text-[11px] font-semibold leading-relaxed text-amber-900">
        {what} could not be read just now. Nothing below is guessed; it will fill in on the next refresh.
      </p>
    </div>
  );
}

/**
 * A genuinely empty answer: the panel stands, says so in one calm line, and points somewhere useful.
 * It is centred in whatever height the row gives it, so a short panel beside a long one reads as
 * "nothing here" rather than as a blank area ("i donot want this blanque area empty like this").
 *
 * IN A WIDE PANEL IT LIES DOWN. A panel spanning two columns (the CVs panel at mid widths) would
 * otherwise draw the same tall stack across the whole row — a wide white block with one sentence in
 * it, which is the "too much empty space" he ticked on 2026-10-16. From 560px of panel the icon, the
 * words and the link stand in one row instead.
 */
export function TaEmpty({
  action,
  icon: Icon,
  line,
  title,
}: {
  action?: ReactNode;
  icon: LucideIcon;
  line: string;
  title: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-7 text-center @min-[560px]:flex-row @min-[560px]:justify-start @min-[560px]:gap-4 @min-[560px]:px-5 @min-[560px]:py-5 @min-[560px]:text-left">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-slate-200 bg-[linear-gradient(180deg,#FFFFFF_0%,#F7F9FC_100%)] text-slate-400">
        <Icon aria-hidden="true" className="h-4 w-4" />
      </span>
      <div className="min-w-0 @min-[560px]:flex-1">
        <p className="text-[13px] font-bold text-slate-800">{title}</p>
        <p className="mx-auto mt-1 max-w-xs break-words text-[11px] font-semibold leading-relaxed text-slate-500 @min-[560px]:mx-0 @min-[560px]:max-w-none">
          {line}
        </p>
      </div>
      {action ? <div className="mt-1 shrink-0 @min-[560px]:mt-0">{action}</div> : null}
    </div>
  );
}

/** The quiet "open the page" link an empty state offers. */
export function TaQuietLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <Link
      className="inline-flex items-center gap-1 border border-orange-200 bg-orange-50 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.12em] text-orange-700 transition-colors hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
      href={href}
    >
      {children}
      <ArrowUpRight aria-hidden="true" className="h-3 w-3" />
    </Link>
  );
}
