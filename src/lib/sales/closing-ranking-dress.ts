import path from "node:path";

import { normalizeLineKey } from "@/lib/sales/confidential-products";

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A LINE'S REP RANKING WORKBOOK WEARS.
//
// One record per line that has a ranking workbook, and the workbook builder reads nothing about the
// look anywhere else. It exists because the second line arrived: the owner asked on 2026-10-13 for
// "the new identity ranking rep closing sheet, exactly as you did for anti-infective, but for CNS
// with CNS identity", and a builder with Royafloxacin red compiled into eighty places cannot wear a
// second identity without being copied — and a copied builder drifts from the one it was copied
// from the first time either is fixed.
//
// THE SPLIT IS THE SAME ON EVERY LINE, and it is the one the Anti-Infective file established:
//
//   THE CHROME IS RENDERED, NEVER IMITATED. The masthead and the per-sheet letterhead bars are real
//   pixels from that identity's own reference HTML at its own width, with its own self-hosted
//   typefaces, committed under public/brand/<line>-ranking/. Excel cannot draw a radial field, a
//   grain, a vignette or a box-reflect, so it is not asked to.
//
//   THE TABLE WEARS THE IDENTITY'S TOKENS. Fills, rules, inks and bars are things Excel does
//   natively, so they carry the identity's own hex values and nothing is approximated.
//
//   WHAT IS NOT THE IDENTITY'S IS SAID SO, ON THE TRUST SHEET, IN THAT LINE'S OWN WORDS. The rows
//   differ per line because the facts differ: the CNS identity has a zebra of its own because its
//   closing sheet has a table, and the Anti-Infective identity has none because its one sheet is a
//   grid of cards.
//
// 🔴 THE CHROME IS MONTH-AGNOSTIC ON EVERY LINE FROM HERE ON. The Anti-Infective strips were
// rendered with SEPTEMBER 2026, 51.54% and 47 SEATS · 33 RANKED · 21 VACANT baked into the
// artwork, so every later month's file prints September's month and September's figures over its
// own cells. The CNS chrome carries the line, the identity and the title only; every figure and the
// month itself live in cells, where they are built from the month being exported. New art for the
// Anti-Infective strips is the owner's to commission — this file cannot repair pixels.
// ─────────────────────────────────────────────────────────────────────────────

/** ARGB as ExcelJS wants it: alpha first, eight hex digits, upper case. */
type Argb = string;

export type RankingDressColours = {
  /** The deepest tone of the field — the Trust tab's colour. */
  base: Argb;
  /** A seat at or above its target. The bracket on every achievement cell, and the data bars. */
  covered: Argb;
  /** The keycard label over the field. */
  eyebrow: Argb;
  /** The keycard ground: the field's own dark body, not its base. */
  field: Argb;
  /** The keycard's sub line, under the figure. */
  keycardSub: Argb;
  /**
   * The seam's left half.
   *
   * 🔴 ITS ORDER IS THE IDENTITY'S, NOT A DERIVATION FROM THE TWO ACCENTS. Anti-Infective runs
   * Royafloxacin red into Saginkgo blue; CNS runs Tebofortin leaf into Tebofortin amber, which is
   * the reverse pairing. Building the seam out of `short` and `covered` would silently flip one of
   * them, and the seam is each identity's signature.
   */
  seamLeft: Argb;
  /** The seam's right half. */
  seamRight: Argb;
  /** A seat under its target, and the alarm colour generally. */
  short: Argb;
  /** Its deeper tone, for text that has to hold its own on white. */
  shortDeep: Argb;
  /** The matrix's subtotal band, carrying a manager's line. */
  teamBand: Argb;
  /** A vacant seat's row tint. */
  vacantFill: Argb;
  /** The vacant-seat keycard's figure, which sits on the field rather than on white. */
  vacantKeycard: Argb;
  /** The alternating row tint. */
  zebra: Argb;
};

export type RankingDress = {
  /** Where the rendered chrome lives, relative to the server's working directory. */
  bannerDir: string;
  /** The sentence the Trust sheet uses for the achievement column's bracket. */
  bracketNote: string;
  colours: RankingDressColours;
  /**
   * The Trust sheet's dress table: which choices in the look were the identity's and which were
   * mine. Every line answers this for itself — a shared answer would be wrong on one of them.
   */
  dressRows: ReadonlyArray<readonly [string, string]>;
  /** The sentence that closes the Trust sheet, naming the look the file wears. */
  identityLine: string;
  /**
   * What the alarm colour is CALLED on this line, for the footnotes that name it in words.
   *
   * A reader checking a vacant row against the sentence that explains it has to find the same
   * colour named, so the name travels with the hex rather than being written out beside it.
   */
  shortName: string;
};

/**
 * The Anti-Infective dress — the first one, built 2026-10-13 against
 * `.claude/skills/anti-infective-identity/reference/one-sheet.html`.
 */
export const ANTI_INFECTIVE_RANKING_DRESS: RankingDress = {
  bannerDir: path.join("public", "brand", "anti-infective-ranking"),
  bracketNote:
    "THE ACHIEVEMENT COLUMN CARRIES A BRACKET: Royafloxacin red where the seat is under its target, "
    + "Saginkgo blue where it covered it - the identity's two product colours, which it allows as "
    + "seams, rules and brackets.",
  colours: {
    base: "FF000A26",
    covered: "FF0384DB",
    eyebrow: "FF67C2F6",
    field: "FF001641",
    keycardSub: "FFA9B6C2",
    // red into blue, as the one sheet runs it
    seamLeft: "FFD20000",
    seamRight: "FF0384DB",
    short: "FFD20000",
    shortDeep: "FF8E0000",
    teamBand: "FFE8EEF5",
    vacantFill: "FFFBE5E5",
    vacantKeycard: "FFFF8C8C",
    zebra: "FFF5F7FA",
  },
  dressRows: [
    ["The masthead", "Rendered pixels, not an imitation: reference/one-sheet.html at its own 2480 width, with the grid of cards removed and its height collapsed. Real Playfair Display, Inter and Cairo, fetched at render time. The navy radial, the grain, the vignette, the double keyline, the arc sets, the red/blue seam, the two cartons, the Arabic wordmark and the base bar are all the identity's own. It sits on THIS sheet, which is the document-identity page and is never scrolled for a figure."],
    ["The month and the figures ON the masthead - STALE BY CONSTRUCTION", "The strips were rendered with September 2026, 51.54% and the September seat counts baked into the artwork, so on any other month the picture disagrees with the cells beside it. THE CELLS ARE THE FIGURES; the picture is letterhead. New art is the only fix, and the CNS chrome beside it was built month-agnostic so it cannot happen again."],
    ["The carton lockup", "Never overlapped and never shrunk to make room: Royafloxacin 368px in front, Saginkgo 350px, 54px margin - the one sheet's own values at this width. Measured clear on the render, not taken on trust. Both products are named in full in the In combination block."],
    ["The Arabic wordmark", "Laid to the right trim and never cropped, with about 62% of its ink behind the cartons - measured at 62.8%, which is the one sheet's own figure. Its ink centre sits at 63.2% of the file's height, as the identity requires."],
    ["The table's colours", "The identity's own tokens: ink #0a1322, hair #dde4e8, soft #69757e, Royafloxacin red #d20000 and its #8e0000, Saginkgo blue #0384db, the navy field's #001641 for the keycards, eyebrow blue #67c2f6 for their labels."],
    ["The zebra - DERIVED", "NOT an identity token. The identity has no table and therefore no zebra. This is its navy at about 4% on white."],
    ["The probation yellow - NOT THE IDENTITY'S", "The identity has no yellow at all. It is kept only because the owner asked for a probation mark in yellow by name."],
    ["The body typeface - SUBSTITUTED", "The identity's body face is Inter. Inter is NOT installed on the machine that built this file, so naming it in a cell would have substituted another face silently - the exact failure the identity warns about. Cells use Calibri. The rendered chrome above carries real Inter, because the renderer fetched it."],
  ],
  identityLine:
    "SATO-DIS-2026-01 v1.0. The event look is the Anti-Infective identity, built for Royafloxacin "
    + "500 mg and Saginkgo 120 mg.",
  shortName: "Royafloxacin red",
};

/**
 * The CNS dress — owner, 2026-10-13: "the new identity ranking rep closing sheet, exactly as you
 * did for anti-infective, but for CNS with CNS identity".
 *
 * Built against `.claude/skills/cns-identity/`, whose own closing sheet already answers three of
 * the questions this workbook asks: the field's four stops, the leaf/amber seam, and a 6% zebra
 * that is the identity's own rather than a derived one.
 *
 * 🔴 THE TWO ACCENTS ARE ONE PRODUCT'S TWO INKS, not two products. The Anti-Infective file reads
 * red/blue as Royafloxacin against Saginkgo. Here both are Tebofortin's — the ribbon green off the
 * pack and the Intens wordmark's orange — because Tebofortin IS the line. Conviban is beside it, not
 * opposite it, so nothing on this file colours one line's seat against the other's.
 */
export const CNS_RANKING_DRESS: RankingDress = {
  bannerDir: path.join("public", "brand", "cns-ranking"),
  bracketNote:
    "THE ACHIEVEMENT COLUMN CARRIES A BRACKET: Tebofortin amber where the seat is under its target, "
    + "Tebofortin leaf where it covered it - the hero pack's own two inks, which the identity allows "
    + "as seams, rules and brackets. They are one product's two colours, not two products: the CNS "
    + "identity puts Conviban beside Tebofortin, never opposite it.",
  colours: {
    // #04210f — the field's fourth stop, and the closing bar's green
    base: "FF04210F",
    // Tebofortin leaf #63b24a — the ribbon green, read as #63b14a / #65b34c / #65ae41 on three packs
    covered: "FF63B24A",
    // eyebrow green #a7e08f
    eyebrow: "FFA7E08F",
    // #0f3a1a — the field's third stop, which is its dark body rather than its base
    field: "FF0F3A1A",
    // derived: the base green at about 32% on white, the quiet grey-green the field will carry
    keycardSub: "FFA9C2AE",
    // 🔴 leaf for the left half and amber for the right — the identity states this order outright,
    // and it is the REVERSE of its sibling's accent pairing
    seamLeft: "FF63B24A",
    seamRight: "FFE5732A",
    // Tebofortin amber #e5732a — the Intens wordmark's orange, median #e37329 / #e77325
    short: "FFE5732A",
    // amber-lo #b4531a
    shortDeep: "FFB4531A",
    // derived: the field's #1d5226 at 10% on white
    teamBand: "FFE8EEE9",
    // derived: the amber at 12% on white
    vacantFill: "FFFCEEE5",
    // amber-hi #ffa061, an identity token, used where the figure sits on the green field
    vacantKeycard: "FFFFA061",
    // the identity's OWN zebra: base green at 6% on white, the value its closing sheet ships
    zebra: "FFF0F2F1",
  },
  dressRows: [
    ["The masthead", "Rendered pixels, not an imitation: reference/ranking-chrome.html at its own 2480 width, with real Playfair Display, Inter, Cairo and Amiri loaded from the identity's self-hosted folder rather than from a CDN, which fails DNS on the machine that renders these. The forest-green radial and its four stops, the connectome, the grain, the vignette, the double keyline, the ginkgo seal, the leaf/amber seam, the two Tebofortin cartons, the Arabic wordmark and the base bar are all the identity's own. It sits on THIS sheet, which is the document-identity page and is never scrolled for a figure."],
    ["The chrome carries NO month and NO figure - deliberately", "Every strip and the masthead name the line, the identity and the tab, and nothing else. A month or a percentage rendered into artwork is stale the following month and disagrees with the cells beside it, which is exactly what the Anti-Infective strips do. Here the month and every figure are cells, built from the month being exported."],
    ["The ginkgo", "A circular sector of radius 104 about the stalk head, 155 degrees to 25, blade 189 x 104 - wider than it is tall, and never two lobes with a notch, which reads as a playing-card heart at the size this mark is used. One ink through currentColor. It is the centre of the ruleset and the face of the corner seal, and it is never a watermark: that is the Arabic wordmark's job."],
    ["The connectome", "Sato's own texture, not a trace of the carton's printed network: generated deterministically by reference/connectome.py and cut to this chrome's height rather than cropped from the sheet's. One white ink at 26%, edges capped so no chord runs across the title."],
    ["The Arabic wordmark", "Laid to the right trim and never cropped, behind the pack lockup on the white foot at 11% and across the field at 5%. A watermark a reader can see over a number has stopped being a watermark."],
    ["The two cartons", "Tebofortin Intens 120 at 218px and Forte 80 at 208px, bottoms aligned, Intens in front, on a 1px reflection - the identity's two-pack law. They are never shrunk to make room and they never overlap: 42px clear between them, measured on the render. Both products are named on the piece."],
    ["The table's colours", "The identity's own tokens: ink #0a1322, hair #dde4e8, soft #69757e, Tebofortin leaf #63b24a, Tebofortin amber #e5732a and its #b4531a, amber-hi #ffa061, the field's #0f3a1a for the keycards, eyebrow green #a7e08f for their labels, base green #04210f for the Trust tab."],
    ["The zebra - THE IDENTITY'S OWN", "Unlike its Anti-Infective sibling, this identity HAS a zebra: its closing sheet carries tables, and the house ink rule allows exactly one filled area on a document, the 6% zebra row. That is the value here - base green #04210f at 6% on white - not a derived one."],
    ["The team band and the vacant tint - DERIVED", "Neither is an identity token. The band is the field's #1d5226 at about 10% on white and carries a district manager's line; the vacant tint is the amber at about 12%. The identity has no table rows to take them from."],
    ["The probation yellow - NOT THE IDENTITY'S", "The identity has no yellow at all. It is kept only because the owner asked for a probation mark in yellow by name."],
    ["The body typeface - SUBSTITUTED", "The identity's body face is Inter. Inter is NOT installed on the machine that built this file, so naming it in a cell would have substituted another face silently - the exact failure the identity warns about. Cells use Calibri. The rendered chrome above carries real Inter, because the renderer loaded it from the identity's own folder."],
    ["What the identity does NOT put on a sheet", "People. Its own closing sheet says so: a rep ranking is personal performance data and does not belong in a design template. That rule governs the TEMPLATE, not this file - this one IS the ranking, it is access-scoped to its reader, and the names on it are the point of it."],
  ],
  identityLine:
    "SATO-DIS-2026-01 v1.0. The event look is the CNS identity, built around Tebofortin - Ginkgo "
    + "biloba leaves extract, 40 / Forte 80 / Intens 120 / Max 240 mg and the 40 mg/ml drops - with "
    + "Conviban beside it.",
  shortName: "Tebofortin amber",
};

/**
 * Every line that has a ranking dress, in the order they were built.
 *
 * The line names are written here as a human writes them and normalized on the way in, because
 * `normalizeLineKey` is what every other sales module compares lines with — "Anti Infective",
 * "anti-infective" and "ANTI INFECTIVE" are one line everywhere else and must be one line here.
 */
const DRESSES: ReadonlyArray<readonly [string, RankingDress]> = [
  ["Anti Infective", ANTI_INFECTIVE_RANKING_DRESS] as const,
  ["CNS", CNS_RANKING_DRESS] as const,
].map(([line, dress]) => [normalizeLineKey(line), dress] as const);

/**
 * The dress this line's ranking workbook wears, or null when the line has none.
 *
 * 🔴 NULL IS NOT A DEFAULT TO FALL BACK FROM. A line with no dress has no ranking workbook at all —
 * `isRepRankingLine` answers the same question for the route and the screen, and
 * `tests/closing-rep-ranking.test.ts` pins the two to each other so they cannot drift to different
 * answers about which lines these are.
 */
export function rankingDressFor(line: string | null | undefined): RankingDress | null {
  const key = normalizeLineKey(line ?? "");
  return DRESSES.find(([dressed]) => dressed === key)?.[1] ?? null;
}

/** The lines that have a dress, in registry order — the test's side of the drift check. */
export function dressedRankingLines(): string[] {
  return DRESSES.map(([line]) => line);
}
