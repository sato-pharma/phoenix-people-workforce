// The milestone card — A4 portrait, Sato Pharma identity, Phoenix orange as the secondary.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE OWNER'S OWN DESIGN, ported. He commissioned it as a one-off keepsake on 2026-09-23,
// worked three rounds of revisions on it himself, and then asked for it as a module. The layout
// here is that approved artwork to the point: every coordinate below is the coordinate he signed
// off, only parameterised for a different name, period and photograph.
//
// 🔴 IT IS NOT THE HOUSE DOCUMENT IDENTITY, DELIBERATELY. `SATO-DIS-2026-01` and its INK RULE
// govern company DOCUMENTS — letters, forms, packs. This is a gift, and it carries filled navy
// masses for the same reason the Spotlight sheet's crest band, plinth and stat band do: the owner
// approved them on a celebratory piece. Do not "bring it into line" with the house identity, and
// do not read its filled bands as a precedent for anything that is a document.
//
// 🔴 DRAWN AS ONE SVG IN POINTS, NOT AS CSS BOXES. The user unit IS the PDF point, so a baseline
// written here is the baseline that prints — `<text y=...>` positions a baseline, which is what
// the original artwork was laid out against. Reproducing it in flowed CSS would mean guessing at
// every font's ascent, and the first wrong guess is invisible until it is on paper.
//
// 🔴 THE ARABIC WORDMARK'S RIGHT EDGE IS NEVER BLED OFF THE PAGE. Arabic begins on the right, so
// trimming that edge cuts the س and the ف off the two words. Its ink is laid TO the trim with
// 16pt of air and never past it.
//
// Verification is on the emitted PDF, never on this source — see `tests/milestone-card.test.ts`
// and the measurement notes in `docs/`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  birthdayEyebrow,
  birthdayStripLabel,
  birthdayTileNumeral,
  birthdayTileUnit,
  formatPlainDateLong,
  milestoneEyebrow,
  milestoneStripLabel,
  milestoneTileNumeral,
  milestoneTileUnit,
  type MilestoneSpec,
  type PlainDate,
} from "./periods";

// ── Palette ───────────────────────────────────────────────────────────────────────────────────
// Straight from the Sato identity. One brand blue, navy masses, hairline greys — plus the single
// Phoenix orange, which appears exactly three times: the seam lead-in, the tile numeral, and the
// mirrored tick on the base seam.
const C = {
  ink: "#111820",
  navy: "#17304D",
  brand: "#0879B8",
  body: "#45515A",
  soft: "#69757E",
  faint: "#8A959D",
  line: "#DDE4E8",
  hair: "#E1E7EB",
  tint: "#F3F9FC",
  tintLine: "#B9D8E9",
  onEdge: "#3A4652",
  onMuted: "#9AA6AF",
  tileLabel: "#B0BCC4",
  paper: "#FFFFFF",
  /** Phoenix secondary — `--phx-accent`. The only warm ink on the page. */
  orange: "#F97316",
} as const;

// ── Geometry, in points ───────────────────────────────────────────────────────────────────────
const PW = 595.276;
const PH = 841.89;
const M = 42; // the one margin everything aligns to
const BAND_H = 76;
const PHOTO_W = 350;
const PHOTO_H = PHOTO_W * 1.25;
const PHOTO_X = (PW - PHOTO_W) / 2;
const PHOTO_Y = 112;
const PHOTO_X1 = PHOTO_X + PHOTO_W;
const PHOTO_Y1 = PHOTO_Y + PHOTO_H;
const FRAME_O = 12; // the outer keyline's offset from the image edge
const TICK = 14; // corner tick length
const TILE = 62;
const MICRO_PT = 7.2;
const MICRO_TRACK = 1.3;
/** The name may fill the outer keyline's width and not a point more. */
const NAME_FIT = PHOTO_W + 2 * FRAME_O;
const NAME_MAX_PT = 42;
const NAME_MIN_PT = 22;
const CITATION_PT = 10.2;
const CITATION_LEADING = 16;
const CITATION_TOP = 716;

export type MilestoneCardInput = {
  /** The name as it prints, in full. Never truncated — the type shrinks instead. */
  displayName: string;
  /** "HR Generalist · Head Office · Cairo" — already joined. */
  roleLine: string;
  employeeId: string;
  hireDate: PlainDate;
  spec: MilestoneSpec;
  on: PlainDate;
  citation: string;
  /** The polished portrait as a data URI, or null for the monogram plate. */
  photoDataUri: string | null;
  /** Two letters for the monogram plate when there is no photograph. */
  initials: string;
  /**
   * When present, this is a BIRTHDAY card, not a service milestone. The tile, eyebrow and strip
   * count WHICH birthday at Sato Pharma it is (`ordinal` — a count of birthdays, NEVER an age); the
   * citation is passed in `citation` and prints the birthday date, never an age. Absent, the card is
   * a service milestone and renders BYTE-IDENTICALLY to the owner's frozen design.
   */
  occasion?: { kind: "birthday"; ordinal: number };
};

// ── Assets ────────────────────────────────────────────────────────────────────────────────────
// Read once per process and held as data URIs. Chromium decodes one copy however many times a
// URI is referenced, and `setContent` has no origin for a relative path to resolve against.
const assetCache = new Map<string, string>();

function dataUri(file: string, mime: string): string {
  const cached = assetCache.get(file);
  if (cached !== undefined) return cached;
  const bytes = readFileSync(join(process.cwd(), "public", file));
  const uri = `data:${mime};base64,${bytes.toString("base64")}`;
  assetCache.set(file, uri);
  return uri;
}

/** The reverse lockup: white type, blue emblem. It is the mark that reads on a dark ground. */
const MARK_W = 401;
const MARK_H = 158;
/** The owner's Arabic mark. It is his placeholder and stays until he sends the official file. */
const ARABIC_W = 1100;
const ARABIC_H = 813;

// ── Drawing helpers ───────────────────────────────────────────────────────────────────────────

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
 * 🔴 THE TRACKING COMPENSATION IS NOT OPTIONAL. Chromium adds `letter-spacing` after the LAST
 * character too, so a tracked string's advance is one track wider than its ink. Centred, that
 * pushes the ink half a track left of where it belongs; right-aligned, a whole track. The original
 * artwork tracked only BETWEEN characters, so every tracked label would sit fractionally off
 * without this shift — visible on the base bar, where the left and right labels must mirror.
 */
function text(
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
): string {
  return text(content.toUpperCase(), x, baseline, { cls: "micro", size, fill, anchor, track });
}

/** White hairlines every 56pt — the `.ink-grid` the identity puts on a navy band. */
function inkGrid(x0: number, y0: number, x1: number, y1: number, step = 56): string {
  const lines: string[] = [];
  for (let x = x0; x < x1; x += step) {
    lines.push(`<rect x="${n(x)}" y="${n(y0)}" width="0.4" height="${n(y1 - y0)}" fill="#FFF" opacity="0.03"/>`);
  }
  return lines.join("");
}

function n(value: number): string {
  return Number(value.toFixed(3)).toString();
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────

/**
 * Which sheet is coming out.
 *
 * `trim`  — A4 exactly, for a good printer and a guillotine.
 * `safe`  — the same artwork at 92%, centred, so an office printer's unprintable margin cannot
 *           eat the navy bands. This is the one to hand somebody who is printing it themselves.
 * `bleed` — 216×303 mm with the artwork scaled past the trim and crop marks on the corners, which
 *           is what a print shop asks for.
 */
export type MilestoneCardVariant = "trim" | "safe" | "bleed";

/** 3 mm of bleed, in points. */
const BLEED = (3 / 25.4) * 72;

function cardBody(input: MilestoneCardInput, idPrefix = ""): string {
  const parts: string[] = [];
  // A birthday card differs from a service card ONLY in four strings — the tile numeral, the tile
  // unit, the eyebrow and the strip's middle label. Everything else (geometry, colours, the photo
  // frame, the citation) is shared, so the frozen design is untouched for a service milestone.
  const birthday = input.occasion?.kind === "birthday" ? input.occasion : null;
  // The three elements the layout pass fits, keyed per card so a document of many cards can fit each
  // one. The FIRST card carries an empty prefix, so a single card's SVG is byte-for-byte the frozen
  // design; only cards 2..N are prefixed (`c1-card-name`, …).
  const nameId = `${idPrefix}card-name`;
  const ruleId = `${idPrefix}card-name-rule`;
  const citationId = `${idPrefix}card-citation`;

  // 1 ── Head band, the reverse mark, and the seam that closes it.
  parts.push(rect(0, 0, PW, BAND_H, C.navy));
  parts.push(inkGrid(0, 0, PW, BAND_H));
  const logoH = 32;
  const logoW = (logoH * MARK_W) / MARK_H;
  parts.push(
    `<image x="${n((PW - logoW) / 2)}" y="${n((BAND_H - logoH) / 2)}" width="${n(logoW)}" height="${n(logoH)}" href="${dataUri("brand/sato-pharma-logo.png", "image/png")}" preserveAspectRatio="xMidYMid meet"/>`,
  );
  parts.push(rect(0, BAND_H, PW, 3, C.brand));
  parts.push(rect(M, BAND_H, 64, 3, C.orange)); // the Phoenix lead-in

  // 2 ── The Arabic wordmark: very faint, on the right, ink laid to the trim. See the header.
  const wmH = 168;
  const wmW = (wmH * ARABIC_W) / ARABIC_H;
  parts.push(
    `<image x="${n(PW - 16 - wmW)}" y="552" width="${n(wmW)}" height="${n(wmH)}" opacity="0.095" href="${dataUri("brand/sato-pharma-arabic-on-light.png", "image/png")}" preserveAspectRatio="xMidYMid meet"/>`,
  );

  // 3 ── The photograph, or the monogram plate when there is none.
  if (input.photoDataUri) {
    parts.push(
      `<image x="${n(PHOTO_X)}" y="${n(PHOTO_Y)}" width="${n(PHOTO_W)}" height="${n(PHOTO_H)}" href="${input.photoDataUri}" preserveAspectRatio="xMidYMid slice"/>`,
    );
  } else {
    parts.push(rect(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H, C.tint));
    parts.push(
      text(input.initials, PW / 2, PHOTO_Y + PHOTO_H / 2 + 46, {
        cls: "name",
        size: 132,
        fill: C.tintLine,
        anchor: "middle",
      }),
    );
  }
  parts.push(stroked(PHOTO_X, PHOTO_Y, PHOTO_W, PHOTO_H, C.line, 0.8));
  parts.push(
    stroked(
      PHOTO_X - FRAME_O,
      PHOTO_Y - FRAME_O,
      PHOTO_W + 2 * FRAME_O,
      PHOTO_H + 2 * FRAME_O,
      C.hair,
      0.8,
    ),
  );
  // Corner ticks on the outer keyline, in brand blue.
  const fx0 = PHOTO_X - FRAME_O;
  const fy0 = PHOTO_Y - FRAME_O;
  const fx1 = PHOTO_X1 + FRAME_O;
  const fy1 = PHOTO_Y1 + FRAME_O;
  for (const [cx, cy, sx, sy] of [
    [fx0, fy0, 1, 1],
    [fx1, fy0, -1, 1],
    [fx0, fy1, 1, -1],
    [fx1, fy1, -1, -1],
  ] as const) {
    const hx = sx > 0 ? cx : cx - TICK;
    const hy = sy > 0 ? cy : cy - 0.8;
    parts.push(rect(hx, hy, TICK, 0.8, C.brand));
    const vx = sx > 0 ? cx : cx - 0.8;
    const vy = sy > 0 ? cy : cy - TICK;
    parts.push(rect(vx, vy, 0.8, TICK, C.brand));
  }

  // 4 ── The commemorative tile. A square seal, never a disc (SHARP rule 4).
  const tx = (PW - TILE) / 2;
  const ty = PHOTO_Y1 - 30;
  parts.push(rect(tx, ty, TILE, TILE, C.ink));
  parts.push(stroked(tx + 5, ty + 5, TILE - 10, TILE - 10, C.onEdge, 0.8));
  parts.push(
    text(birthday ? birthdayTileNumeral(birthday.ordinal) : milestoneTileNumeral(input.spec), PW / 2, ty + 38, {
      cls: "micro",
      size: 25,
      fill: C.orange,
      anchor: "middle",
    }),
  );
  parts.push(
    micro(birthday ? birthdayTileUnit() : milestoneTileUnit(input.spec), PW / 2, ty + 50.5, C.tileLabel, "middle", 6.6, 1.1),
  );

  // 5 ── Eyebrow, name, rule, role.
  parts.push(micro(birthday ? birthdayEyebrow(birthday.ordinal) : milestoneEyebrow(input.spec), PW / 2, 604, C.brand));
  parts.push(
    // The size and the rule's width are settled in the browser, where the font can be measured.
    `<text id="${nameId}" class="name" x="${n(PW / 2)}" y="652" font-size="${NAME_MAX_PT}" fill="${C.navy}" stroke="${C.navy}" stroke-width="0.3" text-anchor="middle">${esc(input.displayName)}</text>`,
  );
  parts.push(`<rect id="${ruleId}" x="${n(PW / 2)}" y="672" width="0" height="0.7" fill="${C.faint}"/>`);
  if (input.roleLine.trim()) parts.push(micro(input.roleLine, PW / 2, 692, C.soft));

  // 6 ── The citation. One sentence, wrapped and balanced in the browser.
  parts.push(
    `<text id="${citationId}" class="body" x="${n(PW / 2)}" y="${CITATION_TOP}" font-size="${CITATION_PT}" fill="${C.body}" text-anchor="middle">${esc(input.citation)}</text>`,
  );

  // 7 ── The figures strip.
  const sx0 = fx0;
  const sx1 = fx1;
  const sy0 = 752;
  const sy1 = 796;
  parts.push(rect(sx0, sy0, sx1 - sx0, sy1 - sy0, C.tint));
  parts.push(stroked(sx0, sy0, sx1 - sx0, sy1 - sy0, C.tintLine, 0.7));
  const cells: [string, string][] = [
    ["Joined", formatPlainDateLong(input.hireDate)],
    [birthday ? birthdayStripLabel(birthday.ordinal) : milestoneStripLabel(input.spec), formatPlainDateLong(input.on)],
    ["Employee id", input.employeeId],
  ];
  const cw = (sx1 - sx0) / cells.length;
  cells.forEach(([label, value], i) => {
    const cx = sx0 + cw * i + cw / 2;
    if (i > 0) parts.push(rect(sx0 + cw * i, sy0 + 9, 0.7, sy1 - sy0 - 18, C.tintLine));
    parts.push(micro(label, cx, sy0 + 19, C.faint, "middle", 6.6, 1.1));
    parts.push(text(value, cx, sy0 + 34, { cls: "micro", size: 10, fill: C.ink, anchor: "middle" }));
  });

  // 8 ── Base seam and bar, mirroring the head.
  parts.push(rect(0, 805, PW, 3, C.brand));
  parts.push(rect(PW - M - 64, 805, 64, 3, C.orange));
  parts.push(rect(0, 808, PW, PH - 808, C.ink));
  parts.push(inkGrid(0, 808, PW, PH));
  parts.push(micro("Sato Pharma", M, 830, C.onMuted, "start"));
  parts.push(
    micro(
      `${String(input.on.day).padStart(2, "0")} . ${String(input.on.month).padStart(2, "0")} . ${input.on.year}`,
      PW - M,
      830,
      C.onMuted,
      "end",
    ),
  );

  return parts.join("");
}

export function milestoneCardSvg(
  input: MilestoneCardInput,
  variant: MilestoneCardVariant = "trim",
  idPrefix = "",
): string {
  const body = cardBody(input, idPrefix);

  if (variant === "safe") {
    // 92%, centred. The artwork is untouched — only the transform changes, so a safe-margin sheet
    // and a trim sheet can never drift apart.
    const s = 0.92;
    const tx = (PW * (1 - s)) / 2;
    const ty = (PH * (1 - s)) / 2;
    return svgTag(
      PW,
      PH,
      `${rect(0, 0, PW, PH, C.paper)}<g transform="translate(${n(tx)} ${n(ty)}) scale(${s})">${body}</g>`,
    );
  }

  if (variant === "bleed") {
    const bw = PW + 2 * BLEED;
    const bh = PH + 2 * BLEED;
    // UNIFORM scale, so nothing on the page is stretched. The larger of the two ratios, so the
    // navy bands reach every edge even after the crop falls where it likes inside the 3 mm.
    const s = Math.max(bw / PW, bh / PH);
    const tx = (bw - PW * s) / 2;
    const ty = (bh - PH * s) / 2;
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
      `${rect(0, 0, bw, bh, C.paper)}<g transform="translate(${n(tx)} ${n(ty)}) scale(${n(s)})">${body}</g>${marks.join("")}`,
    );
  }

  return svgTag(PW, PH, `${rect(0, 0, PW, PH, C.paper)}${body}`);
}

function svgTag(width: number, height: number, content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}pt" height="${n(height)}pt" viewBox="0 0 ${n(width)} ${n(height)}">${content}</svg>`;
}

/** The page size a variant prints on, in millimetres — what `page.pdf` has to be told. */
export function milestoneCardPageSizeMm(variant: MilestoneCardVariant): { width: number; height: number } {
  const pt = variant === "bleed" ? { width: PW + 2 * BLEED, height: PH + 2 * BLEED } : { width: PW, height: PH };
  return { width: (pt.width / 72) * 25.4, height: (pt.height / 72) * 25.4 };
}

/**
 * The layout pass that only a browser can do: fit the name to the frame and wrap the citation —
 * FOR EVERY CARD IN THE DOCUMENT, not just the first.
 *
 * It is a source string because `ChromiumPage.evaluate` takes one, and because the constants it
 * needs are baked in at build time rather than marshalled across the boundary.
 *
 * 🔴 IT WALKS `[data-card]`, IT DOES NOT REACH FOR ONE FIXED ID. A batch document holds many cards;
 * fitting only `card-name` would leave cards 2..N at 42pt off the frame and their citations on one
 * ~800pt line off the sheet — a failure invisible until the batch is printed, because the FIRST
 * card's report comes back valid. Each card carries its own `data-prefix`, and the element ids are
 * prefixed to match (`card-name`, then `c1-card-name`, …). The report is one entry PER card, so the
 * renderer can COUNT them and refuse a document that did not fit every one.
 */
export const MILESTONE_CARD_LAYOUT_SCRIPT = `(async () => {
  await document.fonts.ready;
  var PW = ${PW}, FIT = ${NAME_FIT};
  var NAME_MAX = ${NAME_MAX_PT}, NAME_MIN = ${NAME_MIN_PT};
  var CITE_MAX = ${CITATION_PT}, CITE_FLOOR = 8.6, CITE_BUDGET = 2, CITE_TOP = ${CITATION_TOP}, CITE_LEAD = ${CITATION_LEADING};
  var FUNCTION_WORDS = /^(a|an|the|of|with|and|in|on|at|to|for|as|is|by)$/i;

  var fitCard = function (prefix) {
    // ── The name. It shrinks; it NEVER truncates (owner rule: no ellipsis, ever). Below the floor
    //    it is allowed to run wider than the frame, because a clipped name is the worse failure.
    var name = document.getElementById(prefix + 'card-name');
    var pt = NAME_MAX;
    while (pt > NAME_MIN && name.getComputedTextLength() > FIT) {
      pt -= 0.5;
      name.setAttribute('font-size', String(pt));
    }
    var nw = name.getComputedTextLength();
    var rule = document.getElementById(prefix + 'card-name-rule');
    rule.setAttribute('x', String((PW - nw) / 2));
    rule.setAttribute('width', String(nw));

    // ── The citation. Balanced rather than greedy: greedy leaves a two-word orphan on the last
    //    line, which on a centred block reads as a mistake. Aim every line at total/lines.
    //
    // 🔴 IT FITS A TWO-LINE BUDGET BY SHRINKING THE TYPE, NEVER BY SPILLING A THIRD LINE. The block
    //    is anchored at CITE_TOP and the figures strip begins at 752; a third line runs its
    //    descenders INTO the strip. The 25-year service wording already overflowed here, and the
    //    birthday wording is longer again — so when two lines will not hold the sentence at the
    //    design size, the font steps down to an 8.6pt floor until it does. Only past that floor is a
    //    third line allowed, as the least bad option, because the owner's rule is never to truncate.
    var cite = document.getElementById(prefix + 'card-citation');
    var words = cite.textContent.trim().split(/\\s+/);
    var probe = cite.cloneNode(true);
    probe.removeAttribute('id');
    probe.setAttribute('visibility', 'hidden');
    cite.parentNode.appendChild(probe);

    var wrapAt = function (size) {
      probe.setAttribute('font-size', String(size));
      var measure = function (s) { probe.textContent = s; return probe.getComputedTextLength(); };
      var total = measure(words.join(' '));
      var lineCount = Math.max(1, Math.ceil(total / FIT));
      var lines = [];
      for (var attempt = 0; attempt < 6; attempt += 1) {
        var target = total / lineCount;
        lines = [];
        var current = '';
        for (var i = 0; i < words.length; i += 1) {
          var next = current ? current + ' ' + words[i] : words[i];
          if (current && lines.length < lineCount - 1 && measure(next) > target) {
            lines.push(current);
            current = words[i];
          } else {
            current = next;
          }
        }
        if (current) lines.push(current);
        var widest = 0;
        for (var j = 0; j < lines.length; j += 1) widest = Math.max(widest, measure(lines[j]));
        if (widest <= FIT) break;
        lineCount += 1;
      }
      // A line must not end on a function word — the identity's rule for the certificate citation.
      for (var k = 0; k < lines.length - 1; k += 1) {
        var parts = lines[k].split(' ');
        if (parts.length > 2 && FUNCTION_WORDS.test(parts[parts.length - 1])) {
          var moved = parts.pop();
          if (measure(moved + ' ' + lines[k + 1]) <= FIT) {
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
      citeSize = Math.max(CITE_FLOOR, Math.round((citeSize - 0.4) * 10) / 10);
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
    return { nameSize: pt, nameWidth: nw, citationLines: lines.length, citationSize: citeSize };
  };

  var cards = document.querySelectorAll('[data-card]');
  var reports = [];
  for (var c = 0; c < cards.length; c += 1) {
    reports.push(fitCard(cards[c].getAttribute('data-prefix') || ''));
  }
  var first = reports[0] || { nameSize: 0, nameWidth: 0, citationLines: 0, citationSize: 0 };
  // Top-level keys keep the single-card contract; \`cards\` is what a batch counts.
  return { cards: reports, nameSize: first.nameSize, nameWidth: first.nameWidth, citationLines: first.citationLines, citationSize: first.citationSize };
})()`;

export type MilestoneCardHtmlOptions = {
  variant?: MilestoneCardVariant;
  /**
   * Run the layout pass from an inline `<script>` instead of waiting for the caller to evaluate it.
   * The PDF path evaluates it explicitly, so it knows the pass finished before it prints; a preview
   * in an `<iframe>` has no such hook and needs this.
   *
   * Safe to inline: `MILESTONE_CARD_LAYOUT_SCRIPT` contains no `</` sequence, which is the only
   * thing that could close the tag early. A test pins that.
   */
  autoLayout?: boolean;
};

/** One card's page, ready for `page.setContent` or an `<iframe srcdoc>`. */
export function milestoneCardHtml(input: MilestoneCardInput, options: MilestoneCardHtmlOptions = {}): string {
  return milestoneCardsHtml([input], options);
}

/**
 * A whole window of cards, one per printed page, ready for `page.setContent`.
 *
 * 🔴 THIS IS THE ONE DOCUMENT BUILDER. `milestoneCardHtml` is `milestoneCardsHtml([input])`, so the
 * single card and the batch travel the exact same path — the batch cannot drift from the single one.
 *
 * Each card sits in a `.sheet` carrying `data-card` and its own `data-prefix`; the layout pass walks
 * `[data-card]` and fits every one. Card 0 takes the EMPTY prefix, so its ids are `card-name` and its
 * SVG is byte-identical to what a single card has always emitted (a test pins that). Cards 1..N take
 * `c1-`, `c2-`, … so their ids never collide.
 *
 * Page breaks are `break-before: page` on the SECOND sheet onward, never `break-after` (which emits a
 * blank trailing page) and the gap is `margin-top`, never `margin-bottom` (which would grow a single
 * card's `fullPage` PNG by a white strip below the art).
 */
export function milestoneCardsHtml(
  inputs: MilestoneCardInput[],
  options: MilestoneCardHtmlOptions = {},
): string {
  const variant = options.variant ?? "trim";
  const pinyon = dataUri("fonts/pinyon-script.woff2", "font/woff2");
  const size = variant === "bleed" ? { w: PW + 2 * BLEED, h: PH + 2 * BLEED } : { w: PW, h: PH };
  const script = options.autoLayout
    ? `<script>${MILESTONE_CARD_LAYOUT_SCRIPT}.catch(function () {});</script>`
    : "";
  const sheets = inputs
    .map((input, index) => {
      const prefix = index === 0 ? "" : `c${index}-`;
      return `<div class="sheet" data-card data-prefix="${prefix}">${milestoneCardSvg(input, variant, prefix)}</div>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Milestone card</title><style>
  @font-face { font-family: "Pinyon Script"; font-style: normal; font-weight: 400;
    font-display: block; src: url("${pinyon}") format("woff2"); }
  @page { size: ${n(size.w)}pt ${n(size.h)}pt; margin: 0; }
  * { margin: 0; padding: 0; border-radius: 0; box-sizing: border-box; }
  html, body { width: ${n(size.w)}pt; background: #FFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { width: ${n(size.w)}pt; height: ${n(size.h)}pt; overflow: hidden; position: relative; }
  .sheet + .sheet { break-before: page; margin-top: ${n(size.h)}pt; }
  svg { display: block; }
  /* The identity's own stacks. "Noto Sans" is what the container has; the Windows and macOS
     names follow so a local render looks the same as the deployed one. */
  .micro, .body { font-family: "Noto Sans", "Segoe UI", Calibri, Helvetica, Arial, sans-serif;
    font-kerning: normal; }
  .micro { font-weight: 700; }
  /* Pinyon Script sets exactly one thing: a person's name. */
  .name { font-family: "Pinyon Script", "Great Vibes", cursive; font-weight: 400; }
  </style></head><body>${sheets}${script}</body></html>`;
}

export const MILESTONE_CARD_GEOMETRY = {
  pageWidthPt: PW,
  pageHeightPt: PH,
  marginPt: M,
  bandHeightPt: BAND_H,
  photo: { x: PHOTO_X, y: PHOTO_Y, width: PHOTO_W, height: PHOTO_H },
  nameFitPt: NAME_FIT,
  colours: C,
} as const;
