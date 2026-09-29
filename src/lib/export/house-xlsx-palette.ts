/**
 * The house document identity's PALETTE, and nothing that touches a disk — SATO-DIS-2026-01 v1.0.
 *
 * WHY THIS IS A SEPARATE FILE FROM `house-xlsx-identity.ts`. That module embeds the wordmark, so it
 * opens `public/brand/sato-pharma-logo-on-light.png` with `node:fs` at call time. `table-workbook.ts`
 * is imported by BOTH an API route and a client component (`personal-expense-workload-dashboard`),
 * and a client bundle cannot carry `node:fs`: Turbopack fails the build outright with "the chunking
 * context does not support external modules (request: node:fs)". Merely wanting a colour therefore
 * pulled a server-only file into the browser graph.
 *
 * A workbook builder that runs on the server may import either. Anything a client component can
 * reach must import THIS one. The split is the same one `closing-performance-review-regions.ts`
 * exists for, and for the same reason.
 *
 * Nothing here re-types a colour. Every value is DERIVED from `HOUSE_COLORS` at module load and
 * converted from `#RRGGBB` to the `AARRGGBB` that OOXML wants, so re-sampling the logo changes one
 * module and the workbooks follow.
 *
 * THE ONE COLOUR THAT IS NOT IN THE PALETTE is `flag` — the house palette is four blues and black,
 * and none of them can say "this cell is wrong". It is used for defect text and nowhere else, it is
 * never a fill, and it is deliberately a dark red rather than a signal red so that it sits beside
 * the blues instead of shouting over them.
 */

import { HOUSE_COLORS, HOUSE_TYPE } from "@/lib/hiring-pack/house-identity";

/** `#RRGGBB` (or `#RGB`) as the opaque `AARRGGBB` string every ExcelJS colour field expects. */
export function toArgb(hex: string): string {
  const raw = hex.replace("#", "").trim();
  const full = raw.length === 3 ? raw.split("").map((character) => character + character).join("") : raw;
  return `FF${full.toUpperCase()}`;
}

export const HOUSE_XLSX_COLORS = {
  /** The SATO wordmark. Body text. */
  ink: toArgb(HOUSE_COLORS.ink),
  /** The wave's darkest stroke. Titles, column headers, section labels. */
  deep: toArgb(HOUSE_COLORS.deep),
  /** The PHARMA wordmark. The brand rule under the masthead, and section rules. */
  blue: toArgb(HOUSE_COLORS.blue),
  /** The wave's lightest stroke. Callout edges, secondary rules. */
  light: toArgb(HOUSE_COLORS.light),
  /** Brand Blue at 6%. The zebra row — the only filled element in the format. */
  tint: toArgb(HOUSE_COLORS.tint),
  /** Hairline grey for cell grids. */
  hair: toArgb(HOUSE_COLORS.hair),
  /** Secondary type: sub-labels, provenance, units. */
  muted: toArgb(HOUSE_COLORS.muted),
  /** Primary body type. */
  body: toArgb(HOUSE_COLORS.body),
  white: "FFFFFFFF",
  /** NOT from the logo — see the file header. Defect TEXT only, never a fill. */
  flag: "FFB3261E",
} as const;

/**
 * THE STATUS SIGNAL — green, amber and red, as ink AND as a soft ground.
 *
 * OWNER INSTRUCTION, 2026-09-29, in his own words: "use colors like green and red to identify what
 * needs to be identified". It is a deliberate exemption from this format's usual restraint, and it
 * is narrow on purpose — these three pairs are for a cell whose ONLY job is to say whether
 * something is done, outstanding or late. Nothing else on a house sheet takes them: the headers,
 * the zebra, the rules and the body type are unchanged, so a sheet still reads as a company
 * document with a traffic light on one column rather than as a different format.
 *
 * WHY A FILL AND NOT ONLY TYPE. The marketing coverage workbook colours its Status column as type
 * alone, on the reasoning that the word already says "Approved" so a block says it twice. That
 * holds for one column read line by line. It does not hold for a readiness MATRIX, which is what
 * hiring documents is: dozens of columns of the same five words, where the reader is not reading at
 * all but looking for the shape of the red. The word stays in the cell, so the sheet is still
 * correct with the colour stripped — printed in mono, or read by someone who cannot separate red
 * from green — and the ground is what makes it scannable.
 *
 * The tints are the ink at about 12% on white, picked to sit at the same weight as the 6% brand
 * zebra rather than to shout over it. `bad` reuses `flag`, so the standard keeps ONE red.
 */
export const HOUSE_XLSX_SIGNAL = {
  /** Done — nothing to chase. */
  good: { ink: "FF116B3A", tint: "FFE3F2E8" },
  /** Outstanding but not yet late — the "look at this" middle. */
  warn: { ink: "FF8A5A00", tint: "FFFCF1DC" },
  /** Missing, or past its deadline. */
  bad: { ink: "FFB3261E", tint: "FFFBE4E1" },
} as const;

export type HouseXlsxSignalTone = keyof typeof HOUSE_XLSX_SIGNAL;

/**
 * The identity's own reference, printed on every document that wears it.
 *
 * This is the first place the standard's id exists as a VALUE rather than as a comment — the four
 * hiring-pack renderers each mention it only in prose. If a later change gives `house-identity.ts`
 * its own exported constant, this should re-export that one rather than keep a second.
 */
export const HOUSE_DOCUMENT_STANDARD = "SATO-DIS-2026-01 v1.0";

/**
 * The house typeface, for the `name` field ExcelJS and ExcelForge both take.
 *
 * Re-exported rather than re-typed, for the same reason the colours are derived: eighteen modules
 * held the string "Aptos" and the standard held none, so the face was an assumption rather than a
 * decision. `HOUSE_TYPE` in `house-identity.ts` is the decision; this is how a workbook reads it.
 *
 * A symbol glyph is the one exception and stays hard-coded where it is used — the sparkline arrows
 * in the weekly Summarized Report set "Segoe UI Symbol" on purpose, because the house face may not
 * carry them and a missing glyph is a box, not a fallback.
 */
export const HOUSE_XLSX_FONT = HOUSE_TYPE.body;
export const HOUSE_XLSX_DISPLAY_FONT = HOUSE_TYPE.display;
export const HOUSE_XLSX_MONO_FONT = HOUSE_TYPE.mono;
