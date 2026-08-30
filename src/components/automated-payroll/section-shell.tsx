"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The Automated Payroll module's shared section idiom.
 *
 * Why this file exists: the owner's rule is that a new surface matches its
 * siblings rather than inventing a one-off look. Before this, every panel in the
 * module drew its own heading — a bare `text-phx-xs uppercase` span in the
 * wizard, nothing at all inside the recommendation cards — so the same concept
 * ("this is a labelled block of related fields") had three different shapes on
 * one screen. That is what made the per-person cards read as an undifferentiated
 * wall (owner, 2026-08-30: "visually, it is not comfortable at all").
 *
 * Two primitives, one visual grammar:
 *   SectionHeading — the accent bar + micro-caps label, on its own.
 *   CardSection    — that heading welded to a bordered, padded body.
 *
 * Design constraints baked in here so no call site has to remember them:
 *   • Square corners. The admin shell force-zeroes every radius
 *     (`.admin-shell [class*="rounded"]` in app/globals.css), so a `rounded-*`
 *     here would be inert and misleading — we simply don't write one.
 *   • The label is a LITERAL `text-[11px]`, never the named `text-phx-xs`.
 *     These classes pass through `cn()`, and tailwind-merge silently drops
 *     custom named font sizes — a bug only a real browser can see.
 *   • `overflow-hidden whitespace-nowrap` and never `truncate`: the owner's
 *     standing rule is that text neither wraps to a second line nor ends in an
 *     ellipsis. Clipping is the sanctioned behaviour.
 */

type Tone = "default" | "settlement";

/**
 * Accent bar + micro-caps label. Use standalone above a group of controls.
 *
 * `icon` swaps the accent bar for a glyph — the Finance page labels its three
 * deliverables that way ("Locked workbook", "Bank submission file"). It is the
 * same heading either way, so the type and colour stay identical and only the
 * leading mark changes; before this those rows were hand-rolled at a different
 * size and weight, which is precisely the drift this file exists to stop.
 */
export function SectionHeading({
  title,
  tone = "default",
  icon,
  className,
  children,
}: {
  title: string;
  tone?: Tone;
  /** Replaces the accent bar. Size it to ~`size-3.5` and colour it at the call site. */
  icon?: ReactNode;
  /** Extra classes for the heading ROW (e.g. `justify-between`). */
  className?: string;
  /** Trailing content — a button or chip pinned to the right of the label. */
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {icon ? (
        <span aria-hidden className="flex shrink-0 items-center">
          {icon}
        </span>
      ) : (
        <span
          aria-hidden
          className={cn(
            "h-3.5 w-1 shrink-0",
            tone === "settlement" ? "bg-slate-900" : "bg-orange-500",
          )}
        />
      )}
      <span className="overflow-hidden whitespace-nowrap text-[11px] font-black uppercase tracking-wide text-slate-500">
        {title}
      </span>
      {children}
    </div>
  );
}

/**
 * A bordered block with a tinted header strip. This is the unit that gives each
 * person's card its readable structure: identity, then Details, then This step,
 * then the settlement — each one visibly its own object rather than another
 * paragraph in a stack.
 */
export function CardSection({
  title,
  tone = "default",
  bodyClassName,
  action,
  children,
}: {
  title: string;
  tone?: Tone;
  /** Overrides the body layout (default is a vertical stack). */
  bodyClassName?: string;
  /** Trailing control rendered at the right edge of the header strip. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "border border-slate-200 bg-white",
        tone === "settlement" && "border-slate-300 bg-slate-50/60",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2.5 py-1.5",
          tone === "settlement" && "border-slate-300 bg-slate-100",
        )}
      >
        <SectionHeading title={title} tone={tone} className="min-w-0" />
        {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
      </div>
      <div className={cn("flex flex-col gap-2 px-2.5 py-2", bodyClassName)}>{children}</div>
    </section>
  );
}
