import Link from "next/link";
import { ArrowUpRight, Star, Trophy } from "lucide-react";

import type { EarlyBirdsWinnerRecord } from "@/lib/early-birds/service";
import { formatHireDate } from "./early-birds-format";

// The compact stars card for a landing page.
//
// One star per line (Pedia / Anti Infective / CNS), never a single company-wide "best of the
// best" — that could go whole fortnights without ever being a CNS rep's own line. Each line gets
// its own column, so a rep always sees a name from their own line, not someone else's.
//
// Renders NOTHING when there are no stars. An empty "no winner yet" box sitting on every role's home
// screen for the module's first fortnight is worse than no box at all — the same rule the coaching
// Stars of the Month card follows.
//
// ─── NOTHING IN THIS CARD MAY CARRY `whitespace-nowrap`. ───────────────────────────────────────
// Measured 2026-09-02 at 375x812 on /employee-portals as a Medical Rep. Every text node here used
// to carry it, and this card's own `overflow-hidden` then CLIPPED what overflowed instead of
// scrolling it — so the page measured a clean 375/375 while the content sat unreachable off the
// right edge, which is the failure mode that hides itself from the usual check:
//   • the header held "STARS OF THE FORTNIGHT · AUGUST 1-15, 2026" and "VIEW BOARD" on one
//     unbreakable line. The link's right edge measured 399px against a 363px `main`, and the bar
//     read "STARS OF THE FORTNIGHT · AUGUST 1-15, 2026VIEW BOA".
//   • a winner's own name clipped mid-word — "Hana Abdelaziz Samir Abdelaziz Ghoniem".
// The owner's fits-the-screen golden rule (AGENTS.md §4) permits exactly one remedy here, and it
// is the one applied below: WRAPPING. Not a smaller type scale, not an ellipsis or `truncate`, not
// `overflow-x-auto` over a min-width floor. Pinned by tests/early-birds-fortnight-card-wraps.test.ts.
//
// ─── EVERY BREAKPOINT HERE IS THE CARD'S OWN WIDTH, NOT THE WINDOW'S. ─────────────────────────
// Measured 2026-09-05 at 1440x1000 on /employee-portals as a Medical Rep. The wrapping above was
// working and nothing was clipped or truncated — and the card still read as mangled, because the
// old `sm:` prefixes are VIEWPORT queries. On the rep landing page this card sits in a 402px right
// rail, so on a wide screen `sm:` fired on the window and split those 402px three ways: a 75px name
// column, with "Hana Abdelaziz Samir Abdelaziz Ghoniem" stacked one word per line over 4 lines.
// Every reading was clean — `main` 1440/1440, nothing past the card, `text-overflow: clip` — which
// is exactly why a viewport prefix is the wrong tool in a component dropped into rails of
// different widths.
// The golden rule's own remedy is to MERGE columns rather than shrink type, so the three columns
// now collapse into three full-width rows whenever the CARD is under 768px, however wide the
// window is. Tailwind v4 ships container queries natively: `@container` on the root, then `@3xl:`
// for the columns and `@sm:` for the header. 768px is the measured floor at which three names
// still read on two lines. Do not put an `sm:` prefix back on this card — it cannot see the rail.

function StarColumn({ star }: { star: EarlyBirdsWinnerRecord }) {
  return (
    <div className="flex flex-1 items-center gap-3 px-4 py-4 @3xl:px-5">
      {star.isNational && (
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center bg-amber-400 text-slate-900 shadow"
          title="Also this fortnight's overall national winner"
        >
          <Star className="h-3 w-3" fill="currentColor" />
        </span>
      )}
      <div className="min-w-0">
        <p className="text-phx-2xs font-black uppercase tracking-widest text-orange-500" dir="auto">
          {star.lineName ?? "—"}
        </p>
        {/* Egyptian names run four and five parts long; this one has to wrap, never clip. */}
        <p className="break-words text-base font-black leading-tight text-slate-900" dir="auto">
          {star.employeeName}
        </p>
        <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400" dir="auto">
          {star.areaName ?? "—"}
        </p>
        <p className="mt-0.5 text-phx-xs font-semibold text-slate-500">
          Joined {formatHireDate(star.hireDate)}
        </p>
      </div>
    </div>
  );
}

export function EarlyBirdOfTheFortnightCard({
  stars,
  href = "/employee-portals/early-birds",
}: {
  stars: EarlyBirdsWinnerRecord[];
  href?: string;
}) {
  if (stars.length === 0) return null;

  return (
    <div className="@container overflow-hidden border border-slate-200 bg-white" role="region" aria-label="Early Birds of the fortnight">
      {/* The title takes the whole row in a narrow card (`basis-full`) so it wraps across the full bar
          instead of fighting the link for it. From 384px of CARD width up, both sit on one line. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-slate-900 px-4 py-2.5 @sm:px-5">
        <h2 className="flex min-w-0 basis-full items-center gap-1.5 text-phx-2xs font-bold uppercase tracking-widest text-slate-300 @sm:basis-auto">
          <Trophy className="h-3.5 w-3.5 shrink-0 text-amber-400" />
          {stars.length > 1 ? "Stars of the Fortnight" : "Early Bird"} · {stars[0].periodLabel}
        </h2>
        <Link
          className="inline-flex shrink-0 items-center gap-1 text-phx-2xs font-bold uppercase tracking-widest text-slate-400 hover:text-orange-400"
          href={href}
        >
          View board
          <ArrowUpRight className="h-3 w-3 shrink-0" />
        </Link>
      </div>

      <div className="flex flex-col divide-y divide-slate-100 @3xl:flex-row @3xl:divide-x @3xl:divide-y-0">
        {stars.map((star) => (
          <StarColumn key={star.id} star={star} />
        ))}
      </div>
    </div>
  );
}
