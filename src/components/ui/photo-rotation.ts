import type { CSSProperties } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Turning a photo a quarter at a time, for the viewer only (owner, 2026-10-17: "make me able to
// rotate the picture of validation in place checks bec some timetables are rotated and i cannot
// read"). The stored photograph is never touched — this is how it is LOOKED at.
//
// Pure, so the one thing that is easy to get wrong is pinned by a test: a photo turned a quarter is
// as tall as its frame is WIDE, so on a quarter turn the box it is fitted into swaps its two sides.
// Without that a sideways timetable turned upright overflows its frame, or shrinks to a strip.
//
// The swap is done with container-query units (`cqw`/`cqh`) against a frame that declares
// `container-type: size`, so it needs no measuring, no resize listener and no effect.
// ─────────────────────────────────────────────────────────────────────────────

/** Quarter turns clockwise from how the photo was taken: 0, 90°, 180°, 270°. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export function turnPhoto(turns: QuarterTurns, direction: "left" | "right"): QuarterTurns {
  return (((turns + (direction === "right" ? 1 : 3)) % 4) as QuarterTurns);
}

/** Whether this turn lays the photo on its side, so its frame's width and height trade places. */
export function swapsFrameSides(turns: QuarterTurns): boolean {
  return turns % 2 === 1;
}

/** The style the frame around a turnable photo carries: it is the container the photo is measured against. */
export const TURNABLE_FRAME_STYLE: CSSProperties = { containerType: "size" };

/**
 * A photo filling its frame (`object-fit: contain`), turned. Upright or upside down it fills the frame
 * as it is; on its side it is sized to the frame's height by its width, centred, then turned.
 */
export function turnedFillStyle(turns: QuarterTurns): CSSProperties {
  if (!swapsFrameSides(turns)) {
    return { height: "100%", objectFit: "contain", transform: turns === 0 ? undefined : `rotate(${turns * 90}deg)`, width: "100%" };
  }
  return {
    height: "100cqw",
    left: "50%",
    objectFit: "contain",
    position: "absolute",
    top: "50%",
    transform: `translate(-50%, -50%) rotate(${turns * 90}deg)`,
    width: "100cqh",
  };
}

/**
 * The full-screen viewer's limits for a turned photo: on its side, it may be as wide as the stage is
 * TALL and as tall as the stage is WIDE, so that once turned it still fits inside the stage.
 */
export function turnedFitLimits(turns: QuarterTurns): CSSProperties {
  return swapsFrameSides(turns) ? { maxHeight: "100cqw", maxWidth: "100cqh" } : {};
}
