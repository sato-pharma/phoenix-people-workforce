// The rank insignia on screen. The drawing itself lives in `@/lib/rep-ranks/insignia-svg` — ONE
// geometry for the board and the printed certificate, so the badge on paper is the badge on the
// page. Why each rank looks as it does (the owner's "real Egyptian insignia", every rank distinct,
// on a transparent ground, square-edged): the head of that file.

import { insigniaSpriteDefs, insigniaSymbolInner } from "@/lib/rep-ranks/insignia-svg";
import { RANK_LADDER, type MilitaryRank } from "@/lib/rep-ranks/ladder";

/** The sprite symbol every badge of one rank points at — one per ladder level, so no two ranks share a drawing. */
export function insigniaSymbolId(rank: Pick<MilitaryRank, "level">): string {
  return `phx-rank-insignia-${rank.level}`;
}

/**
 * Every rank's insignia drawn ONCE, as a `<symbol>` the badges reference (2 Nov 2026, the speed root
 * cause, Stage 2). The board used to carry the whole drawing inside each of its ~64 badges — the eagle
 * alone is 21 KB of paths — which made the Ranks page 2.8 MB of HTML, and the same again in the RSC
 * payload, for twelve distinct pictures. Rendered once per page, at the top of the board, ahead of the
 * first badge. Hidden by size, never `display: none`: a hidden-by-display sprite leaves its gradients
 * unrendered in some browsers.
 *
 * The gold, the shadow and the eagle's artwork are drawn once more, in the sprite's own `<defs>`, and
 * every rank's symbol points at them (12 Nov 2026, "make the Ranks page lighter too" — five ranks
 * each carried their own 21 KB eagle).
 */
export function RankInsigniaSprite() {
  return (
    <svg aria-hidden="true" className="absolute h-0 w-0 overflow-hidden" focusable="false" height={0} width={0}>
      {/* Built from the ladder's own constants, never from user input. */}
      <defs dangerouslySetInnerHTML={{ __html: insigniaSpriteDefs() }} />
      {RANK_LADDER.map((rank) => (
        <symbol
          // The markup is built from the ladder's own constants, never from user input.
          dangerouslySetInnerHTML={{ __html: insigniaSymbolInner(rank.insignia) }}
          id={insigniaSymbolId(rank)}
          key={rank.level}
          viewBox="0 0 64 32"
        />
      ))}
    </svg>
  );
}

/**
 * The insignia alone, on a transparent ground. `size` is the rendered width in pixels; the box is 2:1.
 * A reference into `RankInsigniaSprite`, which the board renders once — the badge itself is a few bytes.
 */
export function RankInsigniaBadge({ rank, size = 48 }: { rank: MilitaryRank; size?: number }) {
  return (
    <svg aria-label={`${rank.english} insignia`} className="shrink-0" height={size / 2} role="img" viewBox="0 0 64 32" width={size}>
      <use href={`#${insigniaSymbolId(rank)}`} />
    </svg>
  );
}

/** The rank's name: Arabic first (the owner's choice), English beside it for every reader. */
export function RankName({ rank, className = "" }: { rank: MilitaryRank; className?: string }) {
  return (
    <span className={`break-words ${className}`}>
      <span dir="rtl" lang="ar">{rank.arabic}</span>
      <span className="text-slate-400"> · </span>
      <span>{rank.english}</span>
    </span>
  );
}

/** Stars earned: ★ per title, the count beside them once there are many. */
export function StarRow({ stars }: { stars: number }) {
  if (stars <= 0) return null;
  const shown = Math.min(stars, 5);
  return (
    <span aria-label={`${stars} ${stars === 1 ? "star" : "stars"}`} className="inline-flex flex-wrap items-center gap-0.5 text-amber-500">
      {Array.from({ length: shown }, (_, index) => (
        <span aria-hidden="true" key={index}>
          ★
        </span>
      ))}
      {stars > shown ? <span className="text-phx-3xs font-black text-amber-600">×{stars}</span> : null}
    </span>
  );
}
