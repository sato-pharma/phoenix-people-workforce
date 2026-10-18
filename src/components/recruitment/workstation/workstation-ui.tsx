"use client";

// Recruitment / ATS — the small shared parts of the screening workstation.
//
// ── WHY THERE ARE NO ROUNDED CORNERS IN THIS FOLDER ─────────────────────────────────────────────
//
// The owner asked for it in plain words, twice, when he specified this rebuild: "DO NOT use rounded
// corners. Phoenix should remain sharp, structured, corporate, and enterprise-grade." That is a
// deliberate departure from `--phx-radius`, which the token file sets to 4px and whose own comment
// argues 0 is "too severe for dense HR tables". Both positions are on the record; his instruction
// is the one that governs this surface, and the rest of the module is untouched.
//
// Structure here started out as LINES only, never radius or shadow. That held until 2026-10-19, when
// the owner chose "Full polish there too" for this cockpit in the full-module premium sweep (see the
// header of workstation-look.tsx). So the radius rule stands — square, always — and the shadow is
// back, from the shared house tokens only: each pane's head is the house's dark panel band, each pane
// is a card with the soft depth, a pill is a chip, a meter is a recessed well. Everything else is
// still the Phoenix palette: `--phx-line` hairlines, the four-step ink ramp, orange for the one
// thing that is active, and the recruitment kit's six pill tones for status.
//
// ── THE TYPE SCALE, AND WHY IT IS WRITTEN THE WAY IT IS ────────────────────────────────────────
//
// FONT SIZES ARE WRITTEN AS `text-[12px]`, NEVER `text-phx-sm`. `cn()` runs tailwind-merge, which
// silently DROPS a custom named font size — the class compiles, ships, and does nothing, and only
// `getComputedStyle` in a real browser can see it. The literal bracket form was always safe.
//
// EVERY SIZE HERE IS A STEP OF THE PHOENIX LADDER, spelled as its pixel value: 9, 10, 11, 12, 13,
// 14, 15 and 20 are `--phx-fs-3xs` through `--phx-fs-xl` in `src/styles/tokens.css`. Nothing is
// off-ladder, so this folder reads at the product's own sizes even though it cannot name them.
//
// AND THE BODY SIZE IS 12px BECAUSE THAT IS WHAT THE PAGE AROUND IT READS AT. The filter bar
// directly above this workstation — same screen, a few pixels higher — uses Tailwind's `text-xs`,
// which is 12px, as does the rest of the recruitment module. The first draft of this folder was
// built a step smaller and the mismatch was visible: a 10/11px tool under a 12px bar it shares a
// page with. The ladder never changed; the STEP it starts on is what was corrected.
//
// ── BUT A LABEL IS NOT BODY, AND THAT IS THE 2026-09-12 CORRECTION ──────────────────────────────
//
// The rule above was applied to everything, including the parts nobody reads. A pane's own name, a
// section heading, the word "Location" beside a location: these are glanced at once to place what is
// next to them, and set at body size in bold uppercase they compete with the thing they label.
// Four pane heads, a dozen section bars and thirty key-value labels all shouting at 12px bold is
// most of what the owner meant by "crowded and noisy" — there was no quiet level on the page at all.
//
// So there are now THREE VOICES here, and each has exactly one job:
//
//   · 13-14px   what is being read — a name, a value, a sentence the page is saying.
//   · 12px      body and controls — the size the page around this one reads at, unchanged.
//   · 10-11px   labels and meta — uppercase, wide tracking (0.12em), faint ink, never competing.
//
// Wide tracking is what buys back the legibility the smaller step costs; that is what tracking is
// for, and it is why the label voice is not simply "the same thing, smaller".

import { useCallback, useState } from "react";
import { ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

import {
  adminChipDepthClassName,
  adminPanelHeaderClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
import {
  RecruitmentEmptyState,
  recruitmentPillToneClassName,
} from "@/components/recruitment/recruitment-premium";
import { cn } from "@/lib/utils";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

/**
 * The head of a pane — a name on the left, a count or a qualifier on the right.
 *
 * One bar, repeated across all four panes, because the workstation's whole claim is that a
 * recruiter can stop navigating: four panes that each announce themselves differently is four
 * things to re-learn every time the eye moves.
 *
 * SINCE 2026-10-19 IT IS THE HOUSE'S DARK PANEL BAND (`adminPanelHeaderClassName`) — the same band
 * every `RecruitmentPanel` on the rest of the module opens with, so a pane here reads as the same
 * object as a panel there. The count sits on it as the kit's orange chip. Still slim: one line, 36px.
 */
export function PaneHead({
  children,
  collapseTo,
  foldLabel,
  onCollapse,
  right,
  title,
}: {
  children?: React.ReactNode;
  /** Which way the pane folds — decides the arrow, so it always points at where the pane goes. */
  collapseTo?: "left" | "right";
  /**
   * What to call the pane in the fold control, when the visible heading is not its name.
   *
   * The candidate list's heading is the QUEUE it is showing — "New CVs", "Shortlisted", "Overdue
   * with managers" — so the fold control built from it read "Fold the new cvs pane away" while the
   * spine that brings it back said "Candidates". One pane, two names, and the lower-cased one reads
   * like a typo. This is the pane's own name, and it must match its `PaneSpine` label exactly.
   */
  foldLabel?: string;
  /** Desktop only. Given, the head grows a fold control; omitted, the pane cannot be folded. */
  onCollapse?: () => void;
  right?: React.ReactNode;
  title: string;
}) {
  const foldName = (foldLabel ?? title).toLowerCase();
  return (
    <div
      className={cn(
        "flex min-h-9 shrink-0 items-center justify-between gap-2 px-3 py-1.5 text-white",
        adminPanelHeaderClassName,
      )}
    >
      {/* A 2px tick in the accent, not a heading weight competition. Four panes each need to say
          which one they are without any of them shouting; a mark reads faster than more bold. */}
      <span aria-hidden className="h-3 w-0.5 shrink-0 bg-orange-400" />
      {/* 11px, not 12. The body size on this page is 12px and that is correct for what a reader
          READS; a pane's own name is not read, it is glanced at once to place the pane. Four heads
          set at body size in bold uppercase was four labels competing with their own contents — the
          "a heading that outshouts its content" failure the look kit names. Wide tracking keeps it
          legible at the smaller step, which is what tracking is for. */}
      <span className="min-w-0 flex-1 break-words text-[11px] font-black uppercase leading-[1.45] tracking-[0.12em] text-white">
        {title}
      </span>
      {right ? (
        <span className="shrink-0 border border-orange-400/40 bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-black leading-none tabular-nums text-orange-100">
          {right}
        </span>
      ) : null}
      {children}
      {onCollapse ? (
        /* Hidden below xl, where the pane is already a drawer or a tab and folding it a second way
           would just be a second thing that can hide the CV. */
        <button
          aria-label={`Fold the ${foldName} pane away`}
          className="hidden shrink-0 border border-white/15 bg-white/10 p-0.5 text-slate-300 transition-colors hover:border-orange-300/60 hover:bg-white/20 hover:text-white xl:inline-flex"
          onClick={onCollapse}
          title={`Fold the ${foldName} pane away`}
          type="button"
        >
          {collapseTo === "right" ? (
            <ChevronsRight aria-hidden className="h-3.5 w-3.5" />
          ) : (
            <ChevronsLeft aria-hidden className="h-3.5 w-3.5" />
          )}
        </button>
      ) : null}
    </div>
  );
}

/**
 * What a folded pane leaves behind — a full-height spine, roughly 28px wide, holding the pane's name
 * turned on its side.
 *
 * NOT a disappearance. A pane that folds to nothing is a pane a recruiter cannot find again, and the
 * one thing this screen must never do is lose a control somebody was using a minute ago. The spine
 * is the whole affordance: it says which pane is folded and it is the button that brings it back.
 *
 * A slim card of its own on the cockpit's tray, lifted like the panes it stands in for, with the
 * accent arrow pointing the way the pane will come back.
 */
export function PaneSpine({
  label,
  onOpen,
  side,
}: {
  label: string;
  onOpen: () => void;
  side: "left" | "right";
}) {
  return (
    <button
      aria-label={`Bring back the ${label.toLowerCase()} pane`}
      className={`group hidden h-full w-7 shrink-0 flex-col items-center gap-2 border border-phx-line bg-white py-2 transition-colors hover:border-phx-accent-line hover:bg-phx-accent-soft xl:flex ${adminSoftDepthClassName}`}
      onClick={onOpen}
      title={`Bring back the ${label.toLowerCase()} pane`}
      type="button"
    >
      {side === "left" ? (
        <ChevronsRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-accent" />
      ) : (
        <ChevronsLeft aria-hidden className="h-3.5 w-3.5 shrink-0 text-phx-accent" />
      )}
      <span
        className="text-[11px] font-bold uppercase tracking-[0.12em] text-phx-ink-soft group-hover:text-phx-accent-press"
        style={{ writingMode: "vertical-rl" }}
      >
        {label}
      </span>
    </button>
  );
}

export type PillTone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

/**
 * The workstation's six semantic tones, spoken in the recruitment kit's six pill colours — so a
 * "Shortlisted" here is the same green chip as a "Shortlisted" on the pool, the folders or the
 * interview calendar, never a near-miss of it.
 */
const pillToneClass: Record<PillTone, string> = {
  accent: recruitmentPillToneClassName.orange,
  danger: recruitmentPillToneClassName.rose,
  info: recruitmentPillToneClassName.sky,
  neutral: recruitmentPillToneClassName.slate,
  ok: recruitmentPillToneClassName.emerald,
  warn: recruitmentPillToneClassName.amber,
};

/** A square status chip, with the kit's contact shadow. Foreground, background and border agree. */
export function Pill({
  children,
  className,
  title,
  tone = "neutral",
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
  tone?: PillTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 text-[10px] font-bold uppercase leading-[1.4] tracking-[0.08em]",
        pillToneClass[tone],
        adminChipDepthClassName,
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * A label/value pair, the shape the Summary and CV Data tabs are built from.
 *
 * The value WRAPS. The owner's ellipsis ban is absolute and the fits-the-screen rule says wrapping
 * is the permitted answer — a truncated employer name in a 300px column is exactly the case both
 * rules were written for.
 */
export function KeyValue({
  children,
  hint,
  label,
}: {
  children: React.ReactNode;
  hint?: React.ReactNode;
  label: string;
}) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-2 border-b border-phx-line/70 px-3 py-1.5 transition-colors last:border-b-0 hover:bg-phx-surface-2">
      <span className="text-[10px] font-bold uppercase leading-[1.6] tracking-[0.12em] text-phx-ink-faint">{label}</span>
      <span className="min-w-0 break-words text-[13px] leading-[1.45] text-phx-ink">
        {children}
        {hint ? <span className="mt-0.5 block text-[11px] leading-tight text-phx-ink-soft">{hint}</span> : null}
      </span>
    </div>
  );
}

/**
 * "Nothing here", said in the words of the specific thing that is empty.
 *
 * Never a generic "no results": an empty duplicate pile is good news and an empty candidate list is
 * a filter somebody should undo, and one sentence cannot mean both.
 *
 * Given a `title`, it is a whole pane with nothing in it — the empty queue, the empty CV pane — and
 * it says so with the module's own empty state (`RecruitmentEmptyState`: the orange medallion, the
 * title, the sentence). Without one it stays the quiet single line a section uses for "none yet".
 */
export function EmptyNote({
  children,
  icon,
  title,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}) {
  if (title) return <RecruitmentEmptyState icon={icon} message={children} title={title} />;
  return <p className="px-3 py-6 text-center text-[13px] leading-relaxed text-phx-ink-soft">{children}</p>;
}

/**
 * The confidence marker on an extracted value.
 *
 * FOUR STATES, NOT TWO, because the module's data has four: a value a person typed, a value the CV
 * reader was confident enough to write into a column, a value it hedged on, and no value at all.
 * Collapsing the middle two is what let 250 hedged answers be shown as settled fact.
 */
export type TrustLevel = "verified" | "extracted" | "review" | "missing";

const trustLabel: Record<TrustLevel, string> = {
  extracted: "AI extracted",
  missing: "Not on file",
  review: "Needs review",
  verified: "Verified",
};

const trustTone: Record<TrustLevel, PillTone> = {
  extracted: "info",
  missing: "neutral",
  review: "warn",
  verified: "ok",
};

const trustTitle: Record<TrustLevel, string> = {
  extracted: "Read off the CV and accepted by intake because the reader was confident.",
  missing: "Nobody has answered this, and nothing on the CV does either.",
  review:
    "Read off the CV, but the reader was not confident — check it against the CV before relying on it.",
  verified: "Typed by a person, or answered by the applicant themselves.",
};

export function TrustBadge({ level }: { level: TrustLevel }) {
  return (
    <Pill tone={trustTone[level]} title={trustTitle[level]}>
      {trustLabel[level]}
    </Pill>
  );
}

/**
 * A horizontal meter for one role-fit dimension.
 *
 * SQUARE, and it carries no number of its own — the state and the evidence beside it are the
 * finding; the bar is only there so five dimensions can be compared at a glance. An `unknown`
 * dimension draws an empty track rather than a zero-width bar, because "we do not know" and "scored
 * nothing" are opposite readings and a 0% bar says the second.
 */
export function FitBar({ state }: { state: "met" | "partial" | "missing" | "unknown" }) {
  const width = state === "met" ? "100%" : state === "partial" ? "50%" : state === "missing" ? "12%" : "0%";
  const tone =
    state === "met"
      ? "bg-phx-ok"
      : state === "partial"
        ? "bg-phx-warn"
        : "bg-phx-danger";
  return (
    <span className={cn("block h-2 w-full border border-phx-line bg-phx-surface-2", adminRecessedDepthClassName)} aria-hidden>
      {state === "unknown" ? null : <span className={cn("block h-full transition-[width] duration-300", tone)} style={{ width }} />}
    </span>
  );
}

/**
 * A time, in Cairo, always — never a raw UTC instant and never the browser's own zone.
 *
 * The platform-wide rule, and it matters more here than most places: an applicant who wrote in at
 * 01:30 Cairo reads as the previous day to a UTC renderer, so "arrived today" would be wrong for
 * the first hours of every working morning.
 */
const cairoDateTime = stableEnGbFormatter({
  day: "2-digit",
  hour: "2-digit",
  hour12: true,
  minute: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

const cairoDateOnly = stableEnGbFormatter({
  day: "2-digit",
  month: "short",
  timeZone: "Africa/Cairo",
  year: "numeric",
});

export function cairoStamp(iso: string | null | undefined, options?: { dateOnly?: boolean }): string {
  const value = String(iso ?? "").trim();
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return options?.dateOnly ? cairoDateOnly.format(at) : cairoDateTime.format(at);
}

/** "3 days ago", "today" — the reading a recruiter chases on, beside the stamp, never instead of it. */
export function relativeDays(iso: string | null | undefined, now: number = Date.now()): string {
  const value = String(iso ?? "").trim();
  if (!value) return "";
  const at = new Date(value).getTime();
  if (!Number.isFinite(at)) return "";
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/**
 * WHAT A COLLAPSED SECTION REMEMBERS, and why it is a module-level map rather than localStorage.
 *
 * The annoyance a collapsible panel creates is not collapsing — it is having to collapse the same
 * block again on the next candidate, forty times in a screening session. So the answer is kept for
 * the SESSION, keyed by section, and every section of that name opens the way you last left it as
 * you move down the list.
 *
 * Not `localStorage`, deliberately. This value is read during the first render to decide what to
 * paint, and a browser value read at that moment differs from what the server rendered, which is a
 * hydration mismatch. A module-level map is empty on both sides at hydration and fills only as a
 * person clicks, so the first paint always agrees with itself.
 */
const sectionOpenState = new Map<string, boolean>();

/** The fold state itself, for a block whose header is not a plain CollapsibleSection bar. */
export function useSectionFold(storageKey: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState<boolean>(() => sectionOpenState.get(storageKey) ?? defaultOpen);
  const toggle = useCallback(() => {
    setOpen((current) => {
      sectionOpenState.set(storageKey, !current);
      return !current;
    });
  }, [storageKey]);
  return [open, toggle];
}

/**
 * A named block that folds away, with its summary still readable when it is folded.
 *
 * THE SUMMARY SURVIVES THE COLLAPSE, and that is the whole design. A section that hides its own
 * count when shut makes a recruiter open it just to find out whether it was worth opening — so the
 * right-hand slot ("5 dimensions · 88", "3 notes", "nothing on file") stays visible either way, and
 * folding costs no information, only space.
 *
 * Square, like everything else in this folder. The chevron rotates rather than swapping glyph, so
 * the control has one shape and one meaning.
 */
export function CollapsibleSection({
  children,
  defaultOpen = true,
  right,
  storageKey,
  title,
  tone = "default",
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  /** Stays visible while collapsed — the count, the verdict, the "nothing here". */
  right?: React.ReactNode;
  /** Stable across candidates, so the fold survives moving down the list. */
  storageKey: string;
  title: string;
  /** `quiet` is for a sub-block inside another section — one shade less structure. */
  tone?: "default" | "quiet";
}) {
  const [open, toggle] = useSectionFold(storageKey, defaultOpen);

  return (
    <section className={cn("border-b border-phx-line last:border-b-0", tone === "quiet" && "border-phx-line/70")}>
      {/* THE SUMMARY SLOT SITS OUTSIDE THE BUTTON, not inside it. Two reasons, and the second is the
          one that forced this shape: a control nested inside a <button> is invalid HTML and a real
          usability bug — a screen reader reads the pair as one target and a click on the inner one is
          ambiguous. The queue rail's "Clear filter" is exactly that case, so the header is a row that
          HOLDS a button rather than a button that holds everything. */}
      <div
        className={cn(
          "flex items-center gap-1.5 pr-3 transition-colors",
          tone === "default" ? "bg-phx-surface-2 hover:bg-phx-paper" : "bg-white hover:bg-phx-surface-2",
        )}
      >
        <button
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-2 text-left"
          onClick={toggle}
          type="button"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
              open ? "rotate-90 text-phx-accent" : "text-phx-ink-faint",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 text-[11px] font-bold uppercase leading-[1.45] tracking-[0.12em]",
              tone === "default" ? "text-phx-ink-2" : "text-phx-ink-soft",
            )}
          >
            {title}
          </span>
        </button>
        {right ? (
          <span className="shrink-0 text-[11px] font-semibold leading-[1.45] tabular-nums text-phx-ink-soft">
            {right}
          </span>
        ) : null}
      </div>
      {open ? <div className="border-t border-phx-line/70">{children}</div> : null}
    </section>
  );
}
