/**
 * The Reps List board's chrome — the section frame and the KPI tile, shared by both tabs.
 *
 * The vocabulary is copied verbatim from doctor-list-board.tsx, the board Reps List replaced: flat
 * borders, slate-900 header bar, KPI tiles, orange accent. Never a one-off look (owner's standing
 * rule).
 *
 * EXTRACTED so the Contact List tab and the Reps Weekly Plans tab cannot drift apart visually. Two
 * tabs inside one border that each define their own header bar is two headers that differ the first
 * time either is touched — and the whole reason the owner asked for a tab rather than a second page
 * is that these are one screen.
 */

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

/**
 * The way back from one rep to all of them, as the FIRST thing on a rep's screen (owner, 2026-11-09: "when I
 * press a rep there is no back button to go back to all reps"). The small outlined link in the dark title bar
 * stays; this bar is the one a reader cannot miss, on a phone as on a desktop.
 */
export function BackToAllReps({ href }: { href: string }) {
  return (
    <div className="border-b border-slate-200 bg-white px-5 py-3">
      <Link
        className="inline-flex items-center gap-2 border border-orange-500 bg-orange-50 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-orange-800 transition-colors hover:bg-orange-100"
        href={href}
      >
        <ArrowLeft aria-hidden className="h-4 w-4 shrink-0" />
        Back to all reps
      </Link>
    </div>
  );
}

export function Section({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-2xs text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * A KPI tile, and — when given an `href` — the control that filters the board down to what it counts.
 *
 * ONE COMPONENT FOR BOTH, rather than a `FilterTile` beside it. These sit in the same four-across
 * row, and a second component would match on the day it was written and stop matching on the next
 * change to either: the row would then read as three stats and one button, which is exactly the
 * "one-off look" the owner's standing rule forbids. A tile with no `href` is a plain `div` and is
 * byte-identical to what it always rendered.
 *
 * The active tile keeps its tone on the NUMBER and takes the orange accent on the BORDER. Tinting
 * the number instead would collide with what the tone means here — amber is "waiting on you", rose
 * is "nobody filed" — so the selected state has to be carried by something the tones do not use.
 */
export function Tile({
  active,
  href,
  label,
  sub,
  tone,
  value,
}: {
  /** Whether this tile is the filter currently applied. Ignored without an `href`. */
  active?: boolean;
  /** Makes the tile a link. Omit it and the tile is exactly the static one it has always been. */
  href?: string;
  label: string;
  sub?: string;
  tone?: "amber" | "emerald" | "rose" | "sky";
  value: string;
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : tone === "sky"
            ? "text-sky-700"
            : "text-slate-900";
  const body = (
    <>
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-2xs text-slate-400">{sub}</p> : null}
    </>
  );

  if (!href) return <div className="border border-slate-200 px-3 py-2.5">{body}</div>;

  return (
    <Link
      aria-current={active ? "true" : undefined}
      className={
        active
          ? "block border border-orange-500 bg-orange-50 px-3 py-2.5"
          : "block border border-slate-200 px-3 py-2.5 transition-colors hover:border-orange-400 hover:bg-orange-50"
      }
      href={href}
    >
      {body}
    </Link>
  );
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
export function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}
