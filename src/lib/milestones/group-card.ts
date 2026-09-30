// The group milestone card — A4 LANDSCAPE, one seal, several faces.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IT IS FOR. "I have five employees that have the same milestone in one day … I want to make a
// photo that has them all" (the owner, 2026-09-30). The batch already prints a window as one PDF,
// one card per page — that is a thing to print and hand out. This is the other thing: ONE picture,
// with every face on it, that can go in a message or on a wall. `group.ts` decides what may share a
// picture and what it says; this file only draws it.
//
// 🔴 LANDSCAPE, AND THAT IS THE POINT. The single card is A4 portrait because it frames ONE face.
// A row of faces reads across, so the sheet turns; a portrait sheet would either stack them into a
// column or shrink every face to fit the width. The variants (trim / safe / bleed) work exactly as
// they do on the single card, so the same sheet still prints.
//
// 🔴 IT IS THE SINGLE CARD'S IDENTITY, NOT A NEW LOOK. Same navy masses, same one brand blue, same
// single Phoenix orange (the head seam's lead-in and the base seam's mirrored tick), same square
// seal, same 90° corners, same Pinyon Script reserved for a person's NAME and nothing else. It is
// not the house document identity `SATO-DIS-2026-01` and its INK RULE, for the same reason the
// single card is not: this is a gift, not a document (AGENTS.md §4).
//
// 🔴 THE DRAWING PRIMITIVES ARE DELIBERATELY NOT SHARED WITH `card.ts`. That file is the owner's own
// artwork, ported coordinate for coordinate and signed off over three rounds of revisions; it is
// left byte-for-byte alone. The only thing borrowed from it is the asset cache and the palette,
// through its exported geometry — so the two pieces can never drift on colour.
//
// 🔴 THE ARABIC WORDMARK'S RIGHT EDGE IS NEVER BLED OFF THE PAGE, here as there. Arabic begins on
// the right, so trimming that edge cuts the س and the ف off the two words. Its ink is laid TO the
// trim with 16pt of air and never past it.
//
// Verification is on the emitted SVG and the emitted PDF, never on this source — see
// `tests/milestone-group-card.test.ts`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MILESTONE_CARD_GEOMETRY } from "./card";
import { MILESTONE_GROUP_MAX } from "./group";

// ── Palette ───────────────────────────────────────────────────────────────────────────────────
// The single card's own inks, imported rather than restated, so a colour can never drift between
// the two pieces.
const C = MILESTONE_CARD_GEOMETRY.colours;

// ── Geometry, in points ───────────────────────────────────────────────────────────────────────
// A4 landscape: the single card's page, turned. Every number below is a PDF point, because the SVG
// user unit IS the point — a baseline written here is the baseline that prints.
const PW = 841.89;
const PH = 595.276;
const M = 42;
const CONTENT_W = PW - 2 * M;
const BAND_H = 62;

/** The masthead, top to bottom: seal, eyebrow, date, sentence, rule. */
const TILE = 46;
const TILE_Y = 80;
const EYEBROW_BASE = 144;
const HEADLINE_BASE = 166;
const HEADLINE_PT = 13;
const CITATION_TOP = 188;
const CITATION_PT = 9.4;
const CITATION_LEADING = 13.5;
/** The sentence is set narrower than the page so it reads as a block rather than a banner. */
const CITATION_FIT = 620;
const RULE_Y = 214;
const RULE_W = 96;

/** The box the faces are laid inside. Nothing else may enter it. */
const GRID_TOP = 228;
const GRID_BOTTOM = 542;

/** Base seam and bar, mirroring the head exactly as the single card's do. */
const BASE_SEAM_Y = 558;
const BASE_BAR_Y = 561;
const BASE_LABEL_BASE = 583;

const MICRO_PT = 7.4;
const MICRO_TRACK = 1.3;
/** 4:5 — the portrait window every milestone photograph is already cropped to. */
const PHOTO_RATIO = 1.25;

/** 3 mm of bleed, in points — the single card's figure. */
const BLEED = (3 / 25.4) * 72;

/** The reverse lockup's own proportions, and the owner's Arabic mark's. */
const MARK_W = 401;
const MARK_H = 158;
const ARABIC_W = 1100;
const ARABIC_H = 813;

export type MilestoneGroupCardVariant = "trim" | "safe" | "bleed";

/** One face on the picture. Everything is decided before it arrives here. */
export type MilestoneGroupMember = {
  /** The name as it prints, in full. Never truncated — the type shrinks instead. */
  displayName: string;
  /**
   * The one line under the name: the job title, or THIS person's own date when the group's dates
   * differ. Decided by the builder, because only it knows whether the dates are shared.
   */
  subLine: string;
  /** The polished 4:5 portrait as a data URI, or null for the monogram plate. */
  photoDataUri: string | null;
  /** Two letters for the monogram plate when there is no photograph. */
  initials: string;
};

export type MilestoneGroupCardInput = {
  /** The commemorative seal — the shared occasion, never one person's. */
  tile: { numeral: string; unit: string };
  /** The tracked line over the date. Upper-cased here, not by the caller. */
  eyebrow: string;
  /** "30 September 2026", or "3 – 27 September 2026" when the dates differ. */
  headline: string;
  /** One sentence about the occasion. No names — they are set under the faces. */
  citation: string;
  /** The right label on the base bar. */
  footerRight: string;
  members: MilestoneGroupMember[];
};

// ── Drawing helpers ───────────────────────────────────────────────────────────────────────────
// Small, and deliberately this file's own — see the header on why `card.ts` is not refactored.

function n(value: number): string {
  return Number(value.toFixed(3)).toString();
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function rect(x: number, y: number, w: number, h: number, fill: string, opacity = 1): string {
  const o = opacity === 1 ? "" : ` opacity="${opacity}"`;
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"${o}/>`;
}

function stroked(x: number, y: number, w: number, h: number, colour: string, width: number): string {
  // Inset by half the stroke so the keyline sits ON the edge it describes rather than straddling it.
  const i = width / 2;
  return `<rect x="${n(x + i)}" y="${n(y + i)}" width="${n(w - width)}" height="${n(h - width)}" fill="none" stroke="${colour}" stroke-width="${n(width)}"/>`;
}

/**
 * Text on a baseline.
 *
 * 🔴 THE TRACKING COMPENSATION IS NOT OPTIONAL — the same reason as on the single card. Chromium
 * adds `letter-spacing` after the LAST character too, so a tracked string's advance is one track
 * wider than its ink; centred, that pushes the ink half a track left of where it belongs. Visible
 * on the base bar, where the left and right labels must mirror.
 */
function svgText(
  content: string,
  x: number,
  baseline: number,
  options: {
    cls: string;
    size: number;
    fill: string;
    anchor?: "start" | "middle" | "end";
    track?: number;
    id?: string;
    extra?: string;
  },
): string {
  const anchor = options.anchor ?? "start";
  const track = options.track ?? 0;
  const shift = anchor === "middle" ? track / 2 : anchor === "end" ? track : 0;
  const attrs = [
    options.id ? `id="${options.id}"` : "",
    `class="${options.cls}"`,
    `x="${n(x + shift)}"`,
    `y="${n(baseline)}"`,
    `font-size="${n(options.size)}"`,
    `fill="${options.fill}"`,
    anchor === "start" ? "" : `text-anchor="${anchor}"`,
    track ? `letter-spacing="${n(track)}"` : "",
    options.extra ?? "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${esc(content)}</text>`;
}

/** The one voice of every label on the page: bold, uppercase, tracked. */
function micro(
  content: string,
  x: number,
  baseline: number,
  fill: string,
  anchor: "start" | "middle" | "end" = "middle",
  size = MICRO_PT,
  track = MICRO_TRACK,
  extra?: string,
): string {
  return svgText(content.toUpperCase(), x, baseline, { cls: "micro", size, fill, anchor, track, extra });
}

/** White hairlines every 56pt — the `.ink-grid` the identity puts on a navy band. */
function inkGrid(x0: number, y0: number, x1: number, y1: number, step = 56): string {
  const lines: string[] = [];
  for (let x = x0; x < x1; x += step) {
    lines.push(`<rect x="${n(x)}" y="${n(y0)}" width="0.4" height="${n(y1 - y0)}" fill="#FFF" opacity="0.03"/>`);
  }
  return lines.join("");
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────────
// Read once per process and held as data URIs. `setContent` has no origin for a relative path to
// resolve against, and Chromium decodes one copy however many times a URI is referenced.
const assetCache = new Map<string, string>();

function dataUri(file: string, mime: string): string {
  const cached = assetCache.get(file);
  if (cached !== undefined) return cached;
  const bytes = readFileSync(join(process.cwd(), "public", file));
  const uri = `data:${mime};base64,${bytes.toString("base64")}`;
  assetCache.set(file, uri);
  return uri;
}

// ── The grid ──────────────────────────────────────────────────────────────────────────────────

export type MilestoneGroupGrid = {
  rows: number;
  cols: number;
  gap: number;
  /** The keyline's offset outside the photograph, and the corner tick's length. */
  frame: number;
  tick: number;
  photoW: number;
  photoH: number;
  captionH: number;
  namePt: number;
  nameMinPt: number;
  nameBaselineOffset: number;
  subPt: number;
  subMinPt: number;
  subBaselineOffset: number;
  /** Where each face's photograph sits, in order. */
  cells: { x: number; y: number }[];
};

/**
 * One tier per number of rows: the air around a face, and the type under it.
 *
 * 🔴 A TWO-ROW SHEET IS NOT A ONE-ROW SHEET WITH MORE FACES ON IT. Every point spent on a gap, a
 * keyline offset or a caption is spent ROWS times over, and the band is what it is — so the second
 * tier is tighter, never smaller than the type can carry: the names are still fitted in the browser
 * and still shrink rather than truncate.
 *
 * 🔴 THERE IS NO THREE-ROW TIER, AND ADDING ONE WOULD MAKE EVERY LARGE GROUP WORSE. A third row caps
 * a face at 50pt wide against two rows' 84pt, while two rows of six still fit the width at the
 * ceiling of twelve — so three rows can only ever win past about twenty-six faces, which
 * `MILESTONE_GROUP_MAX` does not allow.
 */
const TIERS = [
  { rows: 1, gap: 26, frame: 9, tick: 12, captionH: 46, namePt: 19, nameMinPt: 11, nameBaselineOffset: 26, subPt: 6.8, subBaselineOffset: 40 },
  { rows: 2, gap: 20, frame: 6, tick: 8, captionH: 36, namePt: 14, nameMinPt: 8.5, nameBaselineOffset: 19, subPt: 5.8, subBaselineOffset: 30 },
] as const;

/**
 * The widest a face can be in one tier — the SMALLER of the two budgets, never just the first one.
 *
 * Both subtract the OUTER KEYLINE, which sits `frame` points outside the photograph on every side:
 * forgetting it is how a keyline ends up touching its neighbour's, or crossing the rule above the
 * grid. The height budget is what stops a group of two printing two portraits 457pt tall on a 314pt
 * band; the width budget is what stops twelve in a row.
 */
function faceWidthIn(tier: (typeof TIERS)[number], count: number): { cols: number; photoW: number } {
  const cols = Math.ceil(count / tier.rows);
  const byWidth = (CONTENT_W - 2 * tier.frame - tier.gap * (cols - 1)) / cols;
  const byHeight =
    (GRID_BOTTOM - GRID_TOP - 2 * tier.frame - tier.gap * (tier.rows - 1) - tier.rows * tier.captionH) /
    tier.rows /
    PHOTO_RATIO;
  return { cols, photoW: Math.min(byWidth, byHeight) };
}

/**
 * Where every face goes.
 *
 * 🔴 THE SHAPE IS CHOSEN BY MEASURING BOTH, NEVER BY A TABLE OF COUNTS. A fixed "six or more goes to
 * two rows" reads sensibly and is wrong in both directions: six faces fit ACROSS at 102pt and were
 * being printed at 84, and twelve were sent to three rows at 50pt when two rows of six fit the width
 * at 84 — a picture using a third of its own page, which is what it looked like. So each tier is
 * measured for this count and the one giving the biggest face wins.
 *
 * 🔴 MORE ROWS MUST WIN BY A MARGIN, NOT BY A ROUNDING. At seven faces the two shapes are 83.4pt and
 * 84pt apart — a twentieth of a millimetre — and one row of seven is the better picture. So a second
 * row has to beat one row by more than 2% before the faces are split up.
 *
 * 🔴 SMALL GROUPS GET BIG FACES AND LARGE ONES GET SMALL FACES, AND THAT IS THE HONEST ANSWER.
 * Measured: two or three faces print at 200 × 250pt (71 × 88 mm), five at 127 × 159 (45 × 56 mm),
 * seven at 83 × 104 (29 × 37 mm), and everything from eight to twelve at 84 × 105 (30 × 37 mm) —
 * which is why `MILESTONE_GROUP_MAX` stops at twelve rather than going on until nobody is
 * recognisable.
 */
export function milestoneGroupGrid(count: number): MilestoneGroupGrid {
  // Typed as the UNION, not inferred from `TIERS[0]`. `as const` makes each tier its own literal
  // type, so an inferred `tier` can only ever hold the one-row tier and the two-row one will not
  // assign to it.
  let tier: (typeof TIERS)[number] = TIERS[0];
  let { cols, photoW } = faceWidthIn(tier, count);
  for (const candidate of TIERS.slice(1)) {
    const measured = faceWidthIn(candidate, count);
    if (measured.photoW > photoW * 1.02) {
      tier = candidate;
      cols = measured.cols;
      photoW = measured.photoW;
    }
  }
  const { rows, gap, frame, tick, captionH } = tier;
  const photoH = photoW * PHOTO_RATIO;

  const rowH = photoH + captionH;
  const blockH = rows * rowH + gap * (rows - 1);
  const top = GRID_TOP + frame + (GRID_BOTTOM - GRID_TOP - 2 * frame - blockH) / 2;

  const cells: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row += 1) {
    const inRow = Math.min(cols, count - row * cols);
    if (inRow <= 0) break;
    // Each row is centred on its own, so a last row of two under a row of three is not left-hung.
    const rowW = inRow * photoW + gap * (inRow - 1);
    const x0 = (PW - rowW) / 2;
    for (let col = 0; col < inRow; col += 1) {
      cells.push({ x: x0 + col * (photoW + gap), y: top + row * (rowH + gap) });
    }
  }

  return {
    rows,
    cols,
    gap,
    frame,
    tick,
    photoW,
    photoH,
    captionH,
    namePt: tier.namePt,
    nameMinPt: tier.nameMinPt,
    nameBaselineOffset: tier.nameBaselineOffset,
    subPt: tier.subPt,
    subMinPt: 4.4,
    subBaselineOffset: tier.subBaselineOffset,
    cells,
  };
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────

function cardBody(input: MilestoneGroupCardInput): string {
  const parts: string[] = [];
  const members = input.members;
  const grid = milestoneGroupGrid(members.length);

  // 1 ── Head band, the reverse mark, and the seam that closes it.
  parts.push(rect(0, 0, PW, BAND_H, C.navy));
  parts.push(inkGrid(0, 0, PW, BAND_H));
  const logoH = 28;
  const logoW = (logoH * MARK_W) / MARK_H;
  parts.push(
    `<image x="${n((PW - logoW) / 2)}" y="${n((BAND_H - logoH) / 2)}" width="${n(logoW)}" height="${n(logoH)}" href="${dataUri("brand/sato-pharma-logo.png", "image/png")}" preserveAspectRatio="xMidYMid meet"/>`,
  );
  parts.push(rect(0, BAND_H, PW, 3, C.brand));
  parts.push(rect(M, BAND_H, 64, 3, C.orange)); // the Phoenix lead-in

  // 2 ── The Arabic wordmark: very faint, on the right of the masthead, ink laid TO the trim.
  const wmH = 150;
  const wmW = (wmH * ARABIC_W) / ARABIC_H;
  parts.push(
    `<image x="${n(PW - 16 - wmW)}" y="${n(BAND_H - 6)}" width="${n(wmW)}" height="${n(wmH)}" opacity="0.085" href="${dataUri("brand/sato-pharma-arabic-on-light.png", "image/png")}" preserveAspectRatio="xMidYMid meet"/>`,
  );

  // 3 ── The commemorative seal. A square, never a disc (SHARP rule 4).
  const tx = (PW - TILE) / 2;
  parts.push(rect(tx, TILE_Y, TILE, TILE, C.ink));
  parts.push(stroked(tx + 4, TILE_Y + 4, TILE - 8, TILE - 8, C.onEdge, 0.8));
  parts.push(
    svgText(input.tile.numeral, PW / 2, TILE_Y + 29, {
      cls: "micro",
      size: 19,
      fill: C.orange,
      anchor: "middle",
    }),
  );
  parts.push(micro(input.tile.unit, PW / 2, TILE_Y + 38.5, C.tileLabel, "middle", 5.6, 0.9));

  // 4 ── Eyebrow, the date, the sentence, and the rule that closes the masthead.
  parts.push(micro(input.eyebrow, PW / 2, EYEBROW_BASE, C.brand));
  parts.push(micro(input.headline, PW / 2, HEADLINE_BASE, C.navy, "middle", HEADLINE_PT, 1.5));
  parts.push(
    `<text id="group-citation" class="body" x="${n(PW / 2)}" y="${n(CITATION_TOP)}" font-size="${n(CITATION_PT)}" fill="${C.body}" text-anchor="middle">${esc(input.citation)}</text>`,
  );
  parts.push(rect((PW - RULE_W) / 2, RULE_Y, RULE_W, 0.7, C.faint));

  // 5 ── The faces.
  members.forEach((member, index) => {
    const cell = grid.cells[index];
    if (!cell) return;
    const { x, y } = cell;
    const { photoW, photoH, frame, tick } = grid;

    if (member.photoDataUri) {
      parts.push(
        `<image x="${n(x)}" y="${n(y)}" width="${n(photoW)}" height="${n(photoH)}" href="${member.photoDataUri}" preserveAspectRatio="xMidYMid slice"/>`,
      );
    } else {
      parts.push(rect(x, y, photoW, photoH, C.tint));
      parts.push(
        svgText(member.initials, x + photoW / 2, y + photoH / 2 + photoH * 0.16, {
          cls: "name",
          size: photoH * 0.46,
          fill: C.tintLine,
          anchor: "middle",
        }),
      );
    }
    parts.push(stroked(x, y, photoW, photoH, C.line, 0.8));
    parts.push(stroked(x - frame, y - frame, photoW + 2 * frame, photoH + 2 * frame, C.hair, 0.8));

    // Corner ticks on the outer keyline, in brand blue — the single card's detail, scaled.
    const fx0 = x - frame;
    const fy0 = y - frame;
    const fx1 = x + photoW + frame;
    const fy1 = y + photoH + frame;
    for (const [cx, cy, sx, sy] of [
      [fx0, fy0, 1, 1],
      [fx1, fy0, -1, 1],
      [fx0, fy1, 1, -1],
      [fx1, fy1, -1, -1],
    ] as const) {
      parts.push(rect(sx > 0 ? cx : cx - tick, sy > 0 ? cy : cy - 0.8, tick, 0.8, C.brand));
      parts.push(rect(sx > 0 ? cx : cx - 0.8, sy > 0 ? cy : cy - tick, 0.8, tick, C.brand));
    }

    // The name, and the one line under it. Both are fitted in the browser, where the type can be
    // measured; the width they must fit is the OUTER KEYLINE's, carried on the element itself.
    //
    // 🔴 `data-gname="1"`, NEVER A BARE `data-gname`. Chromium parses the sheet as HTML and tolerates
    // a valueless attribute, so the picture would print perfectly — and the SVG would still not be
    // well-formed XML, which any XML reader refuses with a tag-mismatch error thousands of characters
    // away from the real cause. Measured 2026-09-30: sharp would not open the sheet at all.
    const fit = photoW + 2 * frame;
    parts.push(
      `<text id="gname-${index}" data-gname="1" data-fit="${n(fit)}" data-floor="${n(grid.nameMinPt)}" class="name" x="${n(x + photoW / 2)}" y="${n(y + photoH + grid.nameBaselineOffset)}" font-size="${n(grid.namePt)}" fill="${C.navy}" stroke="${C.navy}" stroke-width="0.25" text-anchor="middle">${esc(member.displayName)}</text>`,
    );
    if (member.subLine.trim()) {
      parts.push(
        micro(
          member.subLine,
          x + photoW / 2,
          y + photoH + grid.subBaselineOffset,
          C.soft,
          "middle",
          grid.subPt,
          0.7,
          `id="gsub-${index}" data-gsub="1" data-fit="${n(fit)}" data-floor="${n(grid.subMinPt)}"`,
        ),
      );
    }
  });

  // 6 ── Base seam and bar, mirroring the head.
  parts.push(rect(0, BASE_SEAM_Y, PW, 3, C.brand));
  parts.push(rect(PW - M - 64, BASE_SEAM_Y, 64, 3, C.orange));
  parts.push(rect(0, BASE_BAR_Y, PW, PH - BASE_BAR_Y, C.ink));
  parts.push(inkGrid(0, BASE_BAR_Y, PW, PH));
  parts.push(micro("Sato Pharma", M, BASE_LABEL_BASE, C.onMuted, "start"));
  parts.push(micro(input.footerRight, PW - M, BASE_LABEL_BASE, C.onMuted, "end"));

  return parts.join("");
}

function svgTag(width: number, height: number, content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}pt" height="${n(height)}pt" viewBox="0 0 ${n(width)} ${n(height)}">${content}</svg>`;
}

export function milestoneGroupCardSvg(
  input: MilestoneGroupCardInput,
  variant: MilestoneGroupCardVariant = "trim",
): string {
  const body = cardBody(input);

  if (variant === "safe") {
    // 92%, centred. The artwork is untouched — only the transform changes, so a safe-margin sheet
    // and a trim sheet can never drift apart.
    const s = 0.92;
    return svgTag(
      PW,
      PH,
      `${rect(0, 0, PW, PH, C.paper)}<g transform="translate(${n((PW * (1 - s)) / 2)} ${n((PH * (1 - s)) / 2)}) scale(${s})">${body}</g>`,
    );
  }

  if (variant === "bleed") {
    const bw = PW + 2 * BLEED;
    const bh = PH + 2 * BLEED;
    // UNIFORM scale, so nothing on the page is stretched.
    const s = Math.max(bw / PW, bh / PH);
    const marks: string[] = [];
    const len = BLEED * 0.9;
    const w = 0.24;
    for (const x of [BLEED, bw - BLEED]) {
      marks.push(rect(x - w, 0, w, len, "#000"), rect(x - w, bh - len, w, len, "#000"));
    }
    for (const y of [BLEED, bh - BLEED]) {
      marks.push(rect(0, y - w, len, w, "#000"), rect(bw - len, y - w, len, w, "#000"));
    }
    return svgTag(
      bw,
      bh,
      `${rect(0, 0, bw, bh, C.paper)}<g transform="translate(${n((bw - PW * s) / 2)} ${n((bh - PH * s) / 2)}) scale(${n(s)})">${body}</g>${marks.join("")}`,
    );
  }

  return svgTag(PW, PH, `${rect(0, 0, PW, PH, C.paper)}${body}`);
}

/** The page size a variant prints on, in millimetres — what `page.pdf` has to be told. */
export function milestoneGroupPageSizeMm(variant: MilestoneGroupCardVariant): {
  width: number;
  height: number;
} {
  const pt = variant === "bleed" ? { width: PW + 2 * BLEED, height: PH + 2 * BLEED } : { width: PW, height: PH };
  return { width: (pt.width / 72) * 25.4, height: (pt.height / 72) * 25.4 };
}

/**
 * The layout pass that only a browser can do: fit every name and every sub-line to its own frame,
 * and wrap the sentence.
 *
 * 🔴 IT WALKS THE ELEMENTS AND REPORTS ONE ENTRY PER NAME, so the renderer can COUNT them. Fitting
 * the first name only would leave the rest at full size, running across their neighbours — and the
 * first name's report would come back perfectly valid, so nothing would show it until the picture
 * was already sent.
 *
 * 🔴 A NAME SHRINKS; IT NEVER TRUNCATES (owner rule: no ellipsis, ever). Below the floor it is
 * allowed to run wider than its frame, because a clipped name is the worse failure.
 *
 * It is a source string because `ChromiumPage.evaluate` takes one. It contains no `</` sequence, so
 * it is also safe to inline in a `<script>` for the on-screen preview — a test pins that.
 */
export const MILESTONE_GROUP_LAYOUT_SCRIPT = `(async () => {
  await document.fonts.ready;
  var PW = ${PW};
  var CITE_MAX = ${CITATION_PT}, CITE_FLOOR = 7.6, CITE_BUDGET = 2;
  var CITE_TOP = ${CITATION_TOP}, CITE_LEAD = ${CITATION_LEADING}, CITE_FIT = ${CITATION_FIT};
  var FUNCTION_WORDS = /^(a|an|the|of|with|and|in|on|at|to|for|as|is|by)$/i;

  // The frame each element must fit, and the size below which it stops shrinking, both travel on
  // the element — they depend on how many faces are on the page, which this script cannot know.
  var shrink = function (node) {
    var fit = Number(node.getAttribute('data-fit')) || 0;
    var floor = Number(node.getAttribute('data-floor')) || 4;
    var pt = Number(node.getAttribute('font-size')) || 12;
    while (pt > floor && fit > 0 && node.getComputedTextLength() > fit) {
      pt = Math.round((pt - 0.25) * 100) / 100;
      node.setAttribute('font-size', String(pt));
    }
    return pt;
  };

  var names = [];
  var nameNodes = document.querySelectorAll('[data-gname]');
  for (var i = 0; i < nameNodes.length; i += 1) names.push(shrink(nameNodes[i]));

  var sublines = [];
  var subNodes = document.querySelectorAll('[data-gsub]');
  for (var s = 0; s < subNodes.length; s += 1) sublines.push(shrink(subNodes[s]));

  // ── The sentence. Balanced rather than greedy: greedy leaves a two-word orphan on the last line,
  //    which on a centred block reads as a mistake. It fits a two-line budget by SHRINKING the type,
  //    never by spilling a third line into the rule above the faces.
  var cite = document.getElementById('group-citation');
  var words = cite.textContent.trim().split(/\\s+/);
  var probe = cite.cloneNode(true);
  probe.removeAttribute('id');
  probe.setAttribute('visibility', 'hidden');
  cite.parentNode.appendChild(probe);

  var wrapAt = function (size) {
    probe.setAttribute('font-size', String(size));
    var measure = function (text) { probe.textContent = text; return probe.getComputedTextLength(); };
    var total = measure(words.join(' '));
    var lineCount = Math.max(1, Math.ceil(total / CITE_FIT));
    var lines = [];
    for (var attempt = 0; attempt < 6; attempt += 1) {
      var target = total / lineCount;
      lines = [];
      var current = '';
      for (var w = 0; w < words.length; w += 1) {
        var next = current ? current + ' ' + words[w] : words[w];
        if (current && lines.length < lineCount - 1 && measure(next) > target) {
          lines.push(current);
          current = words[w];
        } else {
          current = next;
        }
      }
      if (current) lines.push(current);
      var widest = 0;
      for (var j = 0; j < lines.length; j += 1) widest = Math.max(widest, measure(lines[j]));
      if (widest <= CITE_FIT) break;
      lineCount += 1;
    }
    for (var k = 0; k < lines.length - 1; k += 1) {
      var parts = lines[k].split(' ');
      if (parts.length > 2 && FUNCTION_WORDS.test(parts[parts.length - 1])) {
        var moved = parts.pop();
        if (measure(moved + ' ' + lines[k + 1]) <= CITE_FIT) {
          lines[k] = parts.join(' ');
          lines[k + 1] = moved + ' ' + lines[k + 1];
        }
      }
    }
    return lines;
  };

  var citeSize = CITE_MAX;
  var lines = wrapAt(citeSize);
  while (lines.length > CITE_BUDGET && citeSize > CITE_FLOOR) {
    citeSize = Math.max(CITE_FLOOR, Math.round((citeSize - 0.3) * 10) / 10);
    lines = wrapAt(citeSize);
  }
  probe.parentNode.removeChild(probe);
  cite.setAttribute('font-size', String(citeSize));
  cite.textContent = '';
  for (var m = 0; m < lines.length; m += 1) {
    var span = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    span.setAttribute('x', String(PW / 2));
    span.setAttribute('y', String(CITE_TOP + m * CITE_LEAD));
    span.textContent = lines[m];
    cite.appendChild(span);
  }

  return { names: names, sublines: sublines, citationLines: lines.length, citationSize: citeSize };
})()`;

export type MilestoneGroupCardHtmlOptions = {
  variant?: MilestoneGroupCardVariant;
  /**
   * Run the layout pass from an inline `<script>` instead of waiting for the caller to evaluate it.
   * The print path evaluates it explicitly, so it knows the pass finished before it prints; a
   * preview in an `<iframe>` has no such hook and needs this.
   */
  autoLayout?: boolean;
};

/** The picture's page, ready for `page.setContent` or an `<iframe srcdoc>`. */
export function milestoneGroupCardHtml(
  input: MilestoneGroupCardInput,
  options: MilestoneGroupCardHtmlOptions = {},
): string {
  const variant = options.variant ?? "trim";
  const pinyon = dataUri("fonts/pinyon-script.woff2", "font/woff2");
  const size = milestoneGroupPageSizeMm(variant);
  const wPt = (size.width / 25.4) * 72;
  const hPt = (size.height / 25.4) * 72;
  const script = options.autoLayout
    ? `<script>${MILESTONE_GROUP_LAYOUT_SCRIPT}.catch(function () {});</script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Milestone group picture</title><style>
  @font-face { font-family: "Pinyon Script"; font-style: normal; font-weight: 400;
    font-display: block; src: url("${pinyon}") format("woff2"); }
  @page { size: ${n(wPt)}pt ${n(hPt)}pt; margin: 0; }
  * { margin: 0; padding: 0; border-radius: 0; box-sizing: border-box; }
  html, body { width: ${n(wPt)}pt; background: #FFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: ${n(wPt)}pt; height: ${n(hPt)}pt; overflow: hidden; position: relative; }
  svg { display: block; }
  /* The identity's own stacks. "Noto Sans" is what the container has; the Windows and macOS names
     follow so a local render looks the same as the deployed one. */
  .micro, .body { font-family: "Noto Sans", "Segoe UI", Calibri, Helvetica, Arial, sans-serif;
    font-kerning: normal; }
  .micro { font-weight: 700; }
  /* Pinyon Script sets exactly one thing: a person's name. */
  .name { font-family: "Pinyon Script", "Great Vibes", cursive; font-weight: 400; }
  </style></head><body><div class="sheet">${milestoneGroupCardSvg(input, variant)}</div>${script}</body></html>`;
}

export const MILESTONE_GROUP_GEOMETRY = {
  pageWidthPt: PW,
  pageHeightPt: PH,
  marginPt: M,
  contentWidthPt: CONTENT_W,
  bandHeightPt: BAND_H,
  gridTopPt: GRID_TOP,
  gridBottomPt: GRID_BOTTOM,
  citationFitPt: CITATION_FIT,
  ruleYPt: RULE_Y,
  baseSeamYPt: BASE_SEAM_Y,
  photoRatio: PHOTO_RATIO,
  maxMembers: MILESTONE_GROUP_MAX,
  colours: C,
} as const;
