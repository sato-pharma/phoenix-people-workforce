"use client";

// Recruitment / ATS — the star a person puts on a CV, and the mark that star leaves on a list row.
//
// WHY IT EXISTS. The owner, 2026-09-12: *"i want be able to favorite a cv more"*. He already had
// Shortlist, and Shortlist is a verdict with exactly one volume: everything he liked landed in one
// flat pile in arrival order, and the three he actually wanted to interview were somewhere in it.
// A star is the second axis — not "is this a yes" but "how much of a yes" — so the pile can rank
// against itself. See `candidate-rating.ts` for why a star is NOT a status, and `screening-order.ts`
// for why it is the top key of the queue order.
//
// THE CONTROL AND THE MARK ARE THE SAME MODULE on purpose. A star drawn one way in the reading pane
// and another way in the list beside it would be two features that look related; they must be the
// same five pixels of ink, because the whole value of a rating is recognising it at a glance from
// the list without opening anybody.
//
// Square edges throughout — the house rule, no exceptions.

import { Star } from "lucide-react";

import { adminControlDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  candidateRatingLabels,
  candidateRatings,
  MAX_CANDIDATE_RATING,
  type CandidateRating,
} from "@/lib/recruitment/candidate-rating";
import { cn } from "@/lib/utils";

/**
 * Three stars you can press, in the decision bar of the CV you are reading.
 *
 * PRESSING THE STAR THAT IS ALREADY LIT TAKES IT OFF. That is the only way to clear one with the
 * mouse, and it is the same gesture the region chip on the screening queue already uses — press the
 * live one to drop it. Without it, a star would be a thing you could give and never take back,
 * which is exactly wrong for a mark whose whole purpose is a working opinion that changes as you
 * read more of the pile.
 *
 * Nothing here is a decision: rating somebody does not shortlist them, does not advance the queue,
 * and does not touch their status. It re-ranks them.
 */
export function CandidateStars({
  busy,
  onRate,
  rating,
}: {
  busy: boolean;
  /** `null` clears the star. Never 0 — see candidate-rating.ts. */
  onRate: (next: CandidateRating | null) => void;
  rating: CandidateRating | null;
}) {
  return (
    <span
      aria-label={rating === null ? "Not starred" : candidateRatingLabels[rating]}
      // One control in the decision bar, so it carries the house control depth like its neighbours.
      className={`inline-flex items-center border border-phx-line bg-white ${adminControlDepthClassName}`}
      role="group"
    >
      {candidateRatings.map((value) => {
        const lit = rating !== null && value <= rating;
        return (
          <button
            aria-pressed={lit}
            className={cn(
              "inline-flex h-[30px] w-7 items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              // The hairline between stars, never around them: three bordered boxes would read as
              // three separate buttons rather than one ladder with three rungs.
              value === 1 ? "" : "border-l border-phx-line",
              lit
                ? "bg-phx-accent-soft text-phx-accent-press"
                : "text-phx-ink-soft hover:bg-phx-surface-2 hover:text-phx-accent-press",
            )}
            disabled={busy}
            key={value}
            onClick={() => onRate(value === rating ? null : value)}
            // THE NUMBER ROW IS THE FAST WAY AND IT WAS UNDISCOVERABLE. 1, 2 and 3 have starred the
            // open CV since this screen shipped and 0 has cleared it, bound in
            // screening-workstation.tsx and named nowhere a reader could see. Every star on
            // production's 1,121 CVs would have been a mouse press. The key goes in the tooltip
            // rather than on the face: the button is a 28px glyph with no room for a second mark,
            // and three stars wearing three digits would read as a score out of 3.
            title={
              value === rating
                ? `${candidateRatingLabels[value]} — press ${value} again, or 0, to take the star off`
                : `${candidateRatingLabels[value]} — press ${value}`
            }
            type="button"
          >
            <Star aria-hidden className="h-3.5 w-3.5" fill={lit ? "currentColor" : "none"} />
          </button>
        );
      })}
    </span>
  );
}

/**
 * The same star, read-only, for a row in the queue list.
 *
 * Renders NOTHING at all when nobody has starred the CV. An unrated candidate is the overwhelming
 * majority of any pool, and three empty outlines on every one of six hundred rows would be six
 * hundred pieces of furniture saying the same nothing — the mark is only worth ink where it carries
 * a fact. A row with no stars is not "zero stars"; it is a row nobody has had an opinion about yet.
 */
export function StarMark({ className, rating }: { className?: string; rating: CandidateRating | null }) {
  if (rating === null) return null;
  return (
    <span
      aria-label={candidateRatingLabels[rating]}
      className={cn("inline-flex items-center gap-px text-phx-accent-press", className)}
      title={candidateRatingLabels[rating]}
    >
      {/* Only the stars that are lit, so three stars is visibly wider than one — the difference
          between the piles is the thing being read, and padding one out to MAX with grey outlines
          would make them all the same width again. */}
      {Array.from({ length: rating }, (_, at) => (
        <Star aria-hidden className="h-3 w-3" fill="currentColor" key={at} />
      ))}
      {/* Belt and braces for anybody reading with the stars turned off, and the reason
          MAX_CANDIDATE_RATING is exported at all: widening the ladder to 1–5 later must not leave a
          screen-reader saying "3" where the record now means "3 of 5". */}
      <span className="sr-only">
        {rating} of {MAX_CANDIDATE_RATING}
      </span>
    </span>
  );
}
