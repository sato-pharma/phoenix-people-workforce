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
