// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE OWNER'S CARD, MEASURED — NOT DESIGNED.
//
// The card is the owner's own Canva design with its spacing fixed by hand on 2026-09-12 and
// approved. "A design he hands you is FINAL": every number below was read off that PDF — font,
// size, the exact CMYK ink of each line, the tracking of the two letter-spaced lines, and where
// each baseline sits — so the generated card is the approved card with a different person's
// details in it. Change a number here and the card no longer matches the design he signed off.
//
// Everything that is not text (white ground, blue stripe, logo, underline, divider, the four
// contact icons, and the whole back) comes from `assets/business-cards/business-card-template.pdf`,
// cut from that same PDF without redrawing anything. Positions are millimetres from the top-left
// corner of the TRIMMED card; the renderer adds the 3 mm bleed.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const MM_TO_PT = 72 / 25.4;

export type CardInk = readonly [cyan: number, magenta: number, yellow: number, black: number];

/** The design's own DeviceCMYK values, verbatim. */
export const CARD_INKS = {
  blue: [0.972838938, 0.295292586, 0.01371786, 0.068909741],
  dark: [0.93328756, 0.742366671, 0.577325105, 0.86042571],
  grey: [0.773311972, 0.557930886, 0.490821689, 0.332509338],
} as const satisfies Record<string, CardInk>;

export type CardFace = "bold" | "regular";

export type CardTextSlot = {
  baselineMm: number;
  face: CardFace;
  ink: CardInk;
  /** Longest the line may run before its size is reduced to fit — the card's own side margin. */
  maxWidthMm: number;
  sizePt: number;
  /** Letter-spacing, in em. Applied between glyphs only. */
  trackingEm: number;
  xMm: number;
};

/** The trimmed card: 255 × 141.75 pt, which is 89.96 × 50.01 mm. */
export const CARD_WIDTH_MM = (255 * 25.4) / 72;
const TEXT_LEFT_MM = 4.937;
const HEADING_MAX_WIDTH_MM = CARD_WIDTH_MM - 2 * TEXT_LEFT_MM;

export const CARD_NAME_SLOT: CardTextSlot = {
  baselineMm: 17.179,
  face: "bold",
  ink: CARD_INKS.dark,
  maxWidthMm: HEADING_MAX_WIDTH_MM,
  sizePt: 14.9931,
  trackingEm: 0,
  xMm: TEXT_LEFT_MM,
};

export const CARD_TITLE_SLOT: CardTextSlot = {
  baselineMm: 22.205,
  face: "bold",
  ink: CARD_INKS.blue,
  maxWidthMm: HEADING_MAX_WIDTH_MM,
  sizePt: 5.7948,
  // 0.993 pt between glyphs at 5.7948 pt, as measured. 0.1708 drifted 0.02 mm by the last letter.
  trackingEm: 0.17136,
  xMm: TEXT_LEFT_MM,
};

export const CARD_LINE_AREA_SLOT: CardTextSlot = {
  baselineMm: 26.721,
  face: "bold",
  ink: CARD_INKS.grey,
  maxWidthMm: HEADING_MAX_WIDTH_MM,
  sizePt: 4.9927,
  // 0.799 pt between glyphs at 4.9927 pt, as measured.
  trackingEm: 0.16003,
  xMm: TEXT_LEFT_MM,
};

const CONTACT_LEFT_MM = 8.626;

/** The four contact rows, top to bottom, in the design's order. */
export const CARD_CONTACT_ROWS = ["mobile", "email", "website", "address"] as const;
export type CardContactRow = (typeof CARD_CONTACT_ROWS)[number];

export const CARD_CONTACT_BASELINES_MM = [34.018, 37.767, 41.518, 45.267] as const;

export function contactSlot(row: number): CardTextSlot {
  return {
    baselineMm: CARD_CONTACT_BASELINES_MM[row],
    face: "regular",
    ink: CARD_INKS.dark,
    maxWidthMm: CARD_WIDTH_MM - CONTACT_LEFT_MM - TEXT_LEFT_MM,
    sizePt: 6.9968,
    trackingEm: 0,
    xMm: CONTACT_LEFT_MM,
  };
}

/**
 * Where each contact icon sits on the template's icon page. Each is cut out with a margin that is
 * still well clear of its neighbour (rows are 3.75 mm apart, an icon is 2.47 mm tall), so a row that
 * moves up when the row above it is empty takes exactly its own icon with it.
 */
export const CARD_ICON_BOX_MM = {
  heightMm: 2.47,
  leftMm: 4.27,
  paddingMm: 0.5,
  rightMm: 6.74,
  topsMm: [31.92, 35.67, 39.42, 43.17] as const,
};

/** Printed on every card, exactly as on the owner's design. */
export const CARD_WEBSITE = "www.satopharma.com";
export const CARD_ADDRESS = "Property No. 8, Model N, Square 1258, Sheraton El Matar, Cairo";
