"use client";

/**
 * The one-by-one review — the pieces every slide is drawn from: the stage that holds the photograph,
 * the two-up stage of a polyclinic, an empty stage that says in words what is missing, and the column's
 * header and sections.
 *
 * Presentation only. No piece here decides anything or posts anything: every decision on a slide is a
 * control exported from the board's own lists, so the review and the board share one decision path.
 *
 * 🔴 THE PHOTOGRAPH IS SHOWN WHOLE AND AS LARGE AS THE SCREEN ALLOWS (owner, 2026-10-18: "the picture in
 * a very wide space in the screen"). `CrmPhotoThumb` with `rotatable` fills its positioned box and shows
 * the photo uncropped with ↺ ↻ on it; tapping it opens the full-screen zoom. Square corners throughout.
 */

import type { ReactNode } from "react";

import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { cn } from "@/lib/utils";

/** A photograph on the dark stage, labelled at its corner and captioned under it. */
export function DeckStagePhoto({ alt, caption, label, path }: { alt: string; caption: string | null; label: string; path: string | null }) {
  return (
    <figure className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <CrmPhotoThumb alt={alt} caption={caption ?? alt} className="absolute inset-0 h-full w-full border-0 bg-transparent" path={path} rotatable />
        <span className="pointer-events-none absolute left-3 top-3 z-10 max-w-[70%] bg-slate-950/80 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-white">
          <span className="break-words">{label}</span>
        </span>
      </div>
      <figcaption className="min-w-0 space-y-0.5 px-4 pb-3 pt-2">
        {caption ? (
          <p className="break-words text-xs font-semibold text-slate-200" dir="auto">
            {caption}
          </p>
        ) : null}
        <p className="break-words text-phx-2xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Tap the photo to zoom · turn it with the arrows on it
        </p>
      </figcaption>
    </figure>
  );
}

/**
 * A stage with nothing to photograph — a building with no timetable, a case that kept no picture. It says
 * what is missing in words, large, rather than drawing an empty frame for him to interpret.
 */
export function DeckStageEmpty({ label, lines, title, tone = "neutral" }: { label: string; lines: ReadonlyArray<string>; title: string; tone?: "neutral" | "bad" }) {
  return (
    <div className="relative flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <span className="absolute left-3 top-3 bg-slate-950/80 px-2 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-white">{label}</span>
      <p className={cn("max-w-md break-words text-lg font-black", tone === "bad" ? "text-rose-300" : "text-slate-100")}>{title}</p>
      {lines.map((line) => (
        <p key={line} className="max-w-md break-words text-sm text-slate-400">
          {line}
        </p>
      ))}
    </div>
  );
}

/** Two photographs on one stage: side by side on a wide screen, one above the other on a phone. */
export function DeckSplitStage({ first, second }: { first: ReactNode; second: ReactNode }) {
  return (
    <div className="grid h-full min-h-0 w-full min-w-0 grid-rows-2 gap-px bg-slate-800 lg:grid-cols-2 lg:grid-rows-1">
      <div className="min-h-0 min-w-0 bg-slate-950">{first}</div>
      <div className="min-h-0 min-w-0 bg-slate-950">{second}</div>
    </div>
  );
}

/** The top of the column: what this is, whose it is, and the pills that say where it stands. */
export function DeckSubjectHeader({ eyebrow, lines, pills, title }: { eyebrow: string; lines: ReadonlyArray<string>; pills?: ReactNode; title: string }) {
  return (
    <header className="min-w-0 space-y-2 border-b border-slate-200 px-5 pb-4 pt-5">
      <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">{eyebrow}</p>
      <h3 className="break-words text-xl font-black leading-tight text-slate-950" dir="auto">
        {title}
      </h3>
      {pills ? <div className="flex min-w-0 flex-wrap items-center gap-1.5">{pills}</div> : null}
      {lines.map((line) => (
        <p key={line} className="break-words text-sm text-slate-600" dir="auto">
          {line}
        </p>
      ))}
    </header>
  );
}

/** One section of the column, under a small heading. */
export function DeckSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="min-w-0 space-y-2 border-b border-slate-100 px-5 py-4 last:border-b-0">
      <h4 className="break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</h4>
      {children}
    </section>
  );
}
