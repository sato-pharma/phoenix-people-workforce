import Link from "next/link";
import { ArrowUpRight, Star } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { LANDING_FOCUS, LandingMeta, LandingTick } from "@/components/employee-portal/landing-kit";
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
// ─── THE LOOK IS THE LANDING KIT'S WHITE PANEL (owner, 2026-11-20 redesign). ─────────────────
// It used to be a dark bar over white columns. Every landing it sits on now keeps night navy for its
// ONE headline board, so this card is a white sheet with the kit's orange tick before its title, the
// fortnight as a chip in the header, and each star as a column of small-capital line name, navy name
// and a quiet area line. The national winner's star is SAID ("National winner") instead of being a
// filled square with a hover title a phone can never show. Only the look changed: the Early Birds
// module, its data and the stars this card is handed are untouched.
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
// old `sm:` prefixes are VIEWPORT queries. On the rep landing page this card sat in a 402px right
// rail, so on a wide screen `sm:` fired on the window and split those 402px three ways: a 75px name
// column, with "Hana Abdelaziz Samir Abdelaziz Ghoniem" stacked one word per line over 4 lines.
// Every reading was clean — `main` 1440/1440, nothing past the card, `text-overflow: clip` — which
// is exactly why a viewport prefix is the wrong tool in a component dropped into rails of
// different widths.
// The golden rule's own remedy is to MERGE columns rather than shrink type, so the three columns
// now collapse into three full-width rows whenever the CARD is under 768px, however wide the
// window is. Tailwind v4 ships container queries natively: `@container` on the card's body, then
// `@3xl:` for the columns and `@sm:` for the header. 768px is the measured floor at which three names
// still read on two lines. Do not put an `sm:` prefix back on this card — it cannot see the rail.

function StarColumn({ star }: { star: EarlyBirdsWinnerRecord }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col px-3 py-3 @sm:px-4 @3xl:py-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
        <span className="min-w-0 break-words" dir="auto">
          {star.lineName ?? "—"}
        </span>
        {star.isNational && (
          <span className="inline-flex items-center gap-1 text-[#08111f]" title="Also this fortnight's overall national winner">
            <Star aria-hidden="true" className="h-3 w-3 shrink-0 text-amber-500" fill="currentColor" />
            National winner
          </span>
        )}
      </p>
      {/* Egyptian names run four and five parts long; this one has to wrap, never clip. */}
      <p className="mt-1.5 break-words text-phx-base font-bold leading-snug text-[#08111f]" dir="auto">
        {star.employeeName}
      </p>
      <p className="mt-1 break-words text-phx-xs leading-snug text-slate-500">
        <span dir="auto">{star.areaName ?? "—"}</span>
        <span aria-hidden="true" className="px-1.5 text-slate-300">
          ·
        </span>
        Joined {formatHireDate(star.hireDate)}
      </p>
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
    <section aria-label="Early Birds of the fortnight" className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="@container">
        {/* The title takes the whole row in a narrow card (`basis-full`) so it wraps across the full
            header instead of fighting the fortnight and the link for it. From 384px of CARD width up,
            all three sit on one line. */}
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-200 px-3 py-2.5 @sm:px-4">
          <h2 className="flex min-w-0 basis-full items-center gap-2 break-words text-phx-xs font-black uppercase tracking-[0.12em] text-[#08111f] @sm:basis-auto">
            <LandingTick />
            <span className="min-w-0">{stars.length > 1 ? "Stars of the Fortnight" : "Early Bird"}</span>
          </h2>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 @sm:ml-auto">
            <LandingMeta items={[stars[0].periodLabel]} />
            {/* A 40px tap target that barely grows the header: the negative margin hands back most of
                the height the target adds (the text alone was a ~15px target on a phone). */}
            <Link
              className={`-my-2 inline-flex min-h-10 shrink-0 items-center gap-1 text-phx-xs font-bold uppercase tracking-[0.08em] text-[#08111f] underline-offset-4 hover:underline ${LANDING_FOCUS}`}
              href={href}
            >
              View board
              <ArrowUpRight aria-hidden="true" className="h-3 w-3 shrink-0" />
            </Link>
          </div>
        </header>

        <div className="flex flex-col divide-y divide-slate-200 @3xl:flex-row @3xl:divide-x @3xl:divide-y-0">
          {stars.map((star) => (
            <StarColumn key={star.id} star={star} />
          ))}
        </div>
      </div>
    </section>
  );
}
