"use client";

// Recruitment / ATS — the screening workstation's LOOK, in one file.
//
// WHY A FILE FOR THIS. The owner's words on 2026-09-12, about the screen he screens on: it "looks
// crowded and noisy". It was not one component's fault. Nine files drew this page, every one of them
// wrote its own controls inline, and the same class string —
//
//   "inline-flex items-center gap-1 border border-phx-line bg-white px-2 py-1 text-[12px] font-bold"
//
// — had been retyped more than twenty times. Twenty copies of a button is not twenty buttons: it is
// one button that nobody can change, and it is why every bar on the page shouted at exactly the same
// volume. Bold 12px on white behind a hairline, from the "Back to the pool" link to the bulk
// verdict, so nothing on screen could be more important than anything else.
//
// SO THE VOICE LIVES HERE AND THE PAGES BORROW IT. Four things: a header, a band, a button and a
// medallion. Change the button once and every bar on the screening page changes with it.
//
// WHAT "PREMIUM" MEANS IN THIS REPOSITORY, because the word has been read wrong here before and it
// cost a golden rule: it is NOT rounding, and it is NOT a floating card. Corners are square
// everywhere (AGENTS.md §4 — and the note pinned beside that rule says restoring polish from
// history re-rounds them, so take the DEPTH only). Structure comes from hairlines, not from boxes;
// the shadow ladder appears once, on the one surface that genuinely floats. What is left to work
// with is the part that was missing: HIERARCHY. Three volumes, not one —
//
//   · the page says its name once, in real display type;
//   · a band that is telling the reader something speaks at 12-13px, in its own tone;
//   · everything else is 11px, quiet, and gets out of the way.
//
// AND THE SIZES STAY ARBITRARY — text-[13px], not text-phx-md. `cn()` runs tailwind-merge, which
// STRIPS custom named font sizes, so a text-phx-* class inside a cn() call silently renders at the
// inherited size. That is a live trap in this repository, not a theory.

import type React from "react";

import { cn } from "@/lib/utils";

/* ══ THE BUTTON ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * Three volumes, and a band may only spend the loudest one once.
 *
 * `primary` is filled orange and means "this is the action". `quiet` is the ordinary hairline
 * control. `ghost` carries no border at all until the pointer is on it — which is what most of the
 * old inline buttons should always have been: a "Clear" beside a count is not a thing to be
 * announced, it is a thing to be findable.
 */
export type ActionTone = "primary" | "quiet" | "ghost";

const actionToneClass: Record<ActionTone, string> = {
  ghost:
    "border border-transparent text-phx-ink-soft hover:border-phx-line hover:bg-white hover:text-phx-ink-2",
  primary:
    "border border-phx-accent-press bg-phx-accent text-phx-accent-ink shadow-[0_1px_2px_rgba(13,16,21,0.10)] hover:bg-phx-accent-hover",
  quiet:
    "border border-phx-line bg-white text-phx-ink-2 hover:border-phx-line-strong hover:bg-phx-paper",
};

/**
 * Every control on this page, at one of three volumes.
 *
 * `leading-none` with symmetrical padding rather than a fixed height: these sit in wrapping rows
 * beside text, and a fixed height is what makes a wrapped row look broken on a phone.
 */
export function Action({
  children,
  className,
  disabled,
  onClick,
  size = "sm",
  title,
  tone = "quiet",
  type = "button",
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: () => void;
  /** `sm` is a bar control; `md` is a decision. Nothing on this page needs a third. */
  size?: "sm" | "md";
  title?: string;
  tone?: ActionTone;
  type?: "button" | "submit";
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "onClick" | "type" | "title">) {
  return (
    <button
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-bold leading-none transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "px-2 py-1.5 text-[12px]" : "px-3 py-2 text-[13px]",
        actionToneClass[tone],
        className,
      )}
      disabled={disabled}
      onClick={onClick}
      title={title}
      type={type}
      {...rest}
    >
      {children}
    </button>
  );
}

/** The same vocabulary for something that navigates. An anchor, because it is a real link. */
export function ActionLink({
  children,
  className,
  href,
  rel,
  target,
  title,
  tone = "quiet",
}: {
  children: React.ReactNode;
  className?: string;
  href: string;
  /** Pass `noreferrer` with any `target` — a new tab inherits the opener otherwise. */
  rel?: string;
  target?: string;
  title?: string;
  tone?: ActionTone;
}) {
  return (
    <a
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 px-2 py-1.5 text-[12px] font-bold leading-none transition-colors",
        actionToneClass[tone],
        className,
      )}
      href={href}
      rel={rel}
      target={target}
      title={title}
    >
      {children}
    </a>
  );
}

/* ══ THE BAND ═════════════════════════════════════════════════════════════════════════════════ */

/**
 * One shape for every full-width thing this page says to the reader.
 *
 * There were five of these above the panes — the undo offer, the CV-content search, the vacant-seat
 * line, the bulk verdict and the small-screen pane switcher — and each had grown its own border, its
 * own ground and its own idea of padding. Stacked, they read as a wall of controls with no order to
 * them, which is most of what "noisy" meant.
 *
 * They are all the same object: a sentence, some actions, and sometimes a second line explaining
 * what will happen. The TONE is the only thing that varies, and it varies for one reason — whether
 * the band is telling the reader something (`quiet`), offering them back something they just did
 * (`accent`), or warning them (`warn`).
 *
 * THE LEFT MARK IS THE HIERARCHY. A 3px rule down the leading edge in the band's own colour reads at
 * a glance as "the page is talking", without a heavier border around the whole width — and with two
 * or three stacked it is the one thing that tells them apart from six feet away.
 */
export type BandTone = "accent" | "quiet" | "warn";

const bandToneClass: Record<BandTone, string> = {
  accent: "border-l-phx-accent bg-phx-accent-soft",
  quiet: "border-l-phx-line-strong bg-phx-surface-2",
  warn: "border-l-phx-warn bg-phx-warn-bg",
};

export function Band({
  children,
  footnote,
  tone = "quiet",
}: {
  children: React.ReactNode;
  /**
   * The consequence, in a full sentence, on its own line.
   *
   * Always BELOW and never a tooltip: "it either moves all of them or none" is the thing a recruiter
   * needs before pressing a bulk verdict, and a hover is not a place to put that.
   */
  footnote?: React.ReactNode;
  tone?: BandTone;
}) {
  return (
    <div
      className={cn(
        // WRAPS, never scrolls — the fits-the-screen golden rule. `gap-y` is what keeps a folded row
        // legible rather than stacked against itself.
        "shrink-0 border-b border-l-[3px] border-b-phx-line px-3 py-2 sm:px-4",
        bandToneClass[tone],
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">{children}</div>
      {footnote ? <p className="mt-1 text-[11px] leading-snug text-phx-ink-soft">{footnote}</p> : null}
    </div>
  );
}

/** The sentence a band leads with. One weight louder than everything beside it, and no more. */
export function BandSays({ children }: { children: React.ReactNode }) {
  return (
    <span className="min-w-0 break-words text-[13px] font-bold leading-snug text-phx-ink">{children}</span>
  );
}

/* ══ THE HEADER ═══════════════════════════════════════════════════════════════════════════════ */

/**
 * The page says its name ONCE, at the top, in display type.
 *
 * It never did. The screening route opened on a bordered band of six throughput figures, then a row
 * of five identical bordered buttons, then eight filter dropdowns — 276px of the page's own chrome,
 * 30% of the owner's 910px window, above the first candidate's name — and nowhere in all of it did
 * the page say what it was or which pile was open. The name of the pile lived inside the list pane's
 * own heading, two panes to the right of where the eye starts.
 *
 * So: the name in display type, what is in the pile under it in plain words, and the figures as a
 * quiet series on the right where a figure belongs. The controls sit in their own row underneath, so
 * the name is never in a queue behind a button.
 */
export function WorkHeader({
  controls,
  figures,
  subtitle,
  title,
}: {
  /** The bar controls, in their own row under the name. */
  controls?: React.ReactNode;
  /** Quiet numbers, pushed to the end of the name's row from `sm` up. */
  figures?: React.ReactNode;
  subtitle?: React.ReactNode;
  title: string;
}) {
  return (
    <header className="border-b border-phx-line bg-white px-3 pb-2 pt-3 sm:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h1 className="break-words text-[20px] font-black leading-[1.15] tracking-[-0.015em] text-phx-ink">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 break-words text-[12px] leading-snug text-phx-ink-soft">{subtitle}</p>
          ) : null}
        </div>
        {figures ? (
          /*
           * NO `shrink-0` HERE, EVER — it is what made this header scroll sideways on a phone.
           *
           * `flex-wrap` on this strip cannot wrap what is never made narrow enough to need wrapping.
           * `shrink-0` pins the strip at its own content width, so at 375px the three figures stayed
           * on one 464px line and pushed `main` to a 480px scrollWidth inside a 375px viewport —
           * measured on production 2026-09-18, and the exact failure the fits-the-screen rule names:
           * `shrink-0` makes an inner `flex-wrap` inert.
           *
           * Dropping it costs nothing above the fold: with room to spare, `flex-shrink` never
           * engages, so the strip keeps its natural width on one line at the end of the name's row
           * (measured identical at 1440px — 371px wide, 13px tall, same left edge, with and
           * without). It only does something when there is no room, which is the whole point.
           *
           * `min-w-0` stays and is load-bearing: without it the strip cannot be sized below the
           * min-content width of its own flex line, and the overflow comes straight back.
           */
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">{figures}</div>
        ) : null}
      </div>
      {controls ? <div className="mt-2 flex flex-wrap items-center gap-1.5">{controls}</div> : null}
    </header>
  );
}

/**
 * One figure and its words.
 *
 * The number first and large, the words after it and small — a recruiter reads the figure and only
 * reads the label if the figure surprised them. Tabular so a row of these does not jitter as the
 * counts change underneath it.
 */
export function Figure({ label, value }: { label: string; value: number | string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[15px] font-black leading-none tabular-nums text-phx-ink">{value}</span>
      <span className="text-[11px] font-semibold leading-none text-phx-ink-soft">{label}</span>
    </span>
  );
}

/* ══ THE MEDALLION ════════════════════════════════════════════════════════════════════════════ */

export type MedallionTone = "ok" | "warn" | "neutral" | "none";

const medallionToneClass: Record<MedallionTone, string> = {
  neutral: "border-phx-line bg-phx-surface-2 text-phx-ink-2",
  none: "border-dashed border-phx-line bg-transparent text-phx-ink-faint",
  ok: "border-phx-ok-line bg-phx-ok-bg text-phx-ok",
  warn: "border-phx-warn-line bg-phx-warn-bg text-phx-warn",
};

/**
 * The fit read, as one square block on the trailing edge of a card.
 *
 * A SCORE THAT COULD NOT BE COMPUTED PRINTS AS A DASH, never as a zero, and wears a dashed border so
 * the difference is visible before the number is even read: "nothing on file to read a fit from" and
 * "poor fit" are opposite findings, and a 0 in a coloured box says the second when the truth is the
 * first.
 */
export function Medallion({
  caption,
  title,
  tone,
  value,
}: {
  caption: string;
  title?: string;
  tone: MedallionTone;
  value: number | null;
}) {
  return (
    <span
      className={cn(
        "flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 border py-1",
        medallionToneClass[tone],
      )}
      title={title}
    >
      <span className="text-[15px] font-black leading-none tabular-nums">{value === null ? "—" : value}</span>
      <span className="text-[9px] font-bold uppercase leading-none tracking-[0.06em]">{caption}</span>
    </span>
  );
}

/* ══ THE TALLY ════════════════════════════════════════════════════════════════════════════════ */

/**
 * How many are in this pile — the small square figure on the trailing edge of a rail row.
 *
 * The same eleven-class string was typed twice in the queue rail, once for a work queue and once for
 * a vacancy, and they had already drifted apart by a padding step. It is one object: a number, in a
 * box, that has to stay readable when the row it sits on is the selected one — which is why the
 * active form goes to WHITE ground inside the row's orange tint rather than getting louder. Two
 * oranges on one row is the thing that made the rail read as an alert instead of a selection.
 *
 * `min-w-6` so 4 and 118 leave the column the same width, `tabular-nums` so it does not jitter as
 * the counts change underneath it.
 */
export function Tally({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "min-w-6 shrink-0 border px-1 py-0.5 text-center text-[12px] font-bold leading-none tabular-nums",
        active
          ? "border-phx-accent-line bg-white text-phx-accent-press"
          : "border-phx-line bg-phx-paper text-phx-ink-2",
      )}
    >
      {children}
    </span>
  );
}

/* ══ THE LABEL ════════════════════════════════════════════════════════════════════════════════ */

/**
 * The small uppercase label above a group. Wide tracking, faint ink, and never bold enough to
 * compete with what it labels — a heading that outshouts its own content is the failure mode this
 * page already had, four panes over.
 */
export function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn("text-[10px] font-bold uppercase leading-none tracking-[0.12em] text-phx-ink-faint", className)}
    >
      {children}
    </span>
  );
}
