// A big presentation CHEQUE in Sato Pharma's corporate house identity — SATO-DIS-2026-01 v1.0, the
// identity every company document wears (`src/lib/hiring-pack/house-identity.ts`): the mark on the
// left, the legal name on the right, the engine-turned band under the masthead, Brand Deep titles,
// hairlines and type instead of filled areas. The Spotlight sheet's own look (navy crest, plinth,
// shaded band) is a different, owner-approved exemption and is deliberately NOT used here.
//
// The layout is a cheque's: cheque number, segmented transfer date, "pay to the order of" on a rule
// with the recipient's position beneath it, the sum in words on a ruled line, a figures box, the
// rank and achievement highlighted, two signature lines and a machine-readable foot. The amount in
// words is written in Arabic, in the Amiri Quran hand.
//
// What is deliberately NOT here: a bank name, an account number, a routing or sort code — the sheet
// is a ceremonial presentation cheque for an amount transferred through payroll on the date printed
// on it, and nothing on it can be mistaken for a negotiable instrument. And NO COMPANY SEAL: the
// house seal is on signature lines by the owner's decision of 2026-09-11 and "a new paper does not
// get the seal because its neighbours have one" (house-identity.ts) — a cheque that arrives
// pre-stamped is a cheque nobody stamped.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";

import { systemLegalEntity } from "@/config/system-settings";
import { spellEgyptianAmount } from "@/lib/hiring-pack/arabic-amount";
import {
  HOUSE_BAND_HEIGHT_MM,
  HOUSE_BAND_WAVELENGTH_MM,
  HOUSE_COLORS,
} from "@/lib/hiring-pack/house-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { withChromiumPage } from "@/lib/pdf/chromium";

const C = HOUSE_COLORS;

// Owner, 2026-09-20: this sheet is a presentation piece for an announcement video, not a real cheque —
// "add some colors, add some artistic touches". Gold is the award accent laid over the house blues; it
// belongs to this sheet only and is not a house-identity colour.
const GOLD = { deep: "#8F6A22", mid: "#B8893B", light: "#E2C275", tint: "#FFFBEF", tint2: "#F6E7BE" };
const num = (v: number) => Number(v.toFixed(2));

// The three boxes (Rank, Achievement, Amount) and the Arabic words share one width — the words line
// runs exactly the span of the boxes and never past it (owner, 2026-09-20).
const STAT_ROW_WIDTH_MM = 118 + 6 + 120;
/** Width the name, the dash and the position share on the payee line (the grid's first column, less a margin). */
const PAYEE_ROW_MM = 590;
const AMOUNT_WIDTH_MM = 226;
const FOOT_GAP_MM = 16;
const BOXES_WIDTH_MM = STAT_ROW_WIDTH_MM + FOOT_GAP_MM + AMOUNT_WIDTH_MM;
// The two labels ("The sum of" left, "مبلغ وقدره" right) sit on the words line, so the words keep the middle.
const WORDS_LABEL_EN_MM = 54;
const WORDS_LABEL_AR_MM = 40;
const WORDS_GUTTER_MM = WORDS_LABEL_EN_MM + WORDS_LABEL_AR_MM;

// The house documents are A4 (210 mm wide); this sheet is 914 mm wide. Every house measure that is
// drawn (the band, the hairlines, the mark) is scaled by this factor so the identity keeps its
// proportions instead of shrinking to a thread on a 36-inch sheet.
const SCALE = 4;
// Inner width the bands run across: the page (914 - 2 x 12 inset) less its 22 mm side padding.
const BAND_WIDTH_MM = 914 - 24 - 44;

// Read once and inlined — `setContent` gives Chromium no base URL, so a plain `<img src="/…">` or
// `url(/fonts/…)` renders as a hole with no error. Same device as the Spotlight sheet's own.
const assetCache = new Map<string, string>();
function dataUri(file: string, mime: string): string {
  const cached = assetCache.get(file);
  if (cached !== undefined) return cached;
  const uri = `data:${mime};base64,${readFileSync(join(process.cwd(), file)).toString("base64")}`;
  assetCache.set(file, uri);
  return uri;
}
// Always the ON-LIGHT mark on paper: the stock mark sets "SATO" in white (house-identity.ts).
const houseMark = () => `<img alt="" src="${dataUri("public/brand/sato-pharma-logo-on-light.svg", "image/svg+xml")}">`;
const arabicMark = () => `<img alt="" src="${dataUri("public/brand/sato-pharma-arabic-on-light.png", "image/png")}">`;
// Amiri Quran (SIL Open Font License 1.1, aliftype/amiri) — the Quranic naskh the owner supplied for the amount in words.
const quranFace = () => dataUri("public/fonts/amiri-quran-regular.ttf", "font/ttf");

export type AwardChequeRow = {
  recipientName: string;
  /** What the cheque is for — the memo line ("For / عن") when no rank and achievement are given. */
  awardTitle: string;
  /** The recipient's position in full, written under the name ("Senior Medical Representative"). */
  positionTitle?: string | null;
  /** The CEO's signature as a transparent-PNG data URI, printed on the CEO line. Supplied per run and
   *  never stored in the repository or under public/ — a signature image served statically is a forgery kit. */
  ceoSignatureUri?: string | null;
  /** Semester rank and achievement (percent, one decimal) — highlighted in the memo. */
  rank?: number | null;
  achievementPct?: number | null;
  /** The programme naming the award — the masthead's subtitle and the foot. */
  programName: string;
  /** Null prints a placeholder box rather than "0", so an unfilled cheque never reads as EGP 0. */
  amountEgp: number | null;
  /** ISO date `YYYY-MM-DD` of the transfer; null prints an empty DD MM YYYY. */
  transferDate: string | null;
  serial: string;
};

/** What prints before real names, awards and amounts are supplied. */
export const AWARD_CHEQUE_PLACEHOLDER: AwardChequeRow = {
  recipientName: "[ RECIPIENT NAME ]",
  awardTitle: "[ AWARD TITLE — e.g. Rank 1 · Achievement ]",
  positionTitle: "[ POSITION ]",
  rank: null,
  achievementPct: null,
  programName: "Semester Achievers Award — S1 2026",
  amountEgp: null,
  transferDate: null,
  serial: "[ 000001 ]",
};

function egpFigures(n: number | null): string {
  if (n === null) return "X,XXX";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
}

/** "فقط … لا غير" — the words a cheque writes so the figure cannot be raised. Empty when unknown. */
export function chequeAmountInArabic(amountEgp: number | null): string {
  const spelled = spellEgyptianAmount(amountEgp);
  return spelled === "" ? "" : `فقط ${spelled} لا غير`;
}

function dateParts(iso: string | null): { d: string; m: string; y: string; digits: string } {
  const match = iso === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return { d: "DD", m: "MM", y: "YYYY", digits: "00000000" };
  return { d: match[3], m: match[2], y: match[1], digits: `${match[3]}${match[2]}${match[1]}` };
}

/** Shrinks a long name to its line instead of letting it wrap or clip — never truncates. */
/** Shrinks the Arabic words until they sit on their one line — measured on the page once the face has
 *  loaded, because a per-character estimate under-counts some spellings and the words wrapped. */
const FIT_WORDS_SCRIPT = `
document.fonts.ready.then(function () {
  document.querySelectorAll(".words__ar").forEach(function (el) {
    var pt = parseFloat(el.style.fontSize) || 70;
    var range = document.createRange();
    range.selectNodeContents(el);
    while (pt > 30 && range.getBoundingClientRect().width > el.clientWidth - 1) {
      pt -= 1;
      el.style.fontSize = pt + "pt";
    }
  });
});`;

function namePt(name: string, widthMm: number, maxPt: number, minPt: number): number {
  const fit = widthMm / (Math.max(name.length, 1) * 0.6 * 0.3528);
  return Math.max(minPt, Math.min(maxPt, Math.floor(fit)));
}

/** Fits the Arabic words on their one ruled line — measured on Amiri Quran, ~0.117 mm per pt per character (0.12 with a margin). */
function wordsPt(words: string, widthMm: number, maxPt: number, minPt: number): number {
  const fit = widthMm / (Math.max(words.length, 1) * 0.12);
  return Math.max(minPt, Math.min(maxPt, Math.floor(fit)));
}

/** 1 -> "st", 2 -> "nd", 3 -> "rd", 11-13 -> "th". */
function ordinalSuffix(n: number): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
}

const bare = (serial: string) => serial.replace(/[\[\]\s]/g, "");

/**
 * The house engine-turned band as one inline vector: the same two sine passes half a wavelength
 * apart as `houseEngineTurnedBand`, drawn across the whole width in a single path so the PDF holds
 * one shape instead of a tiled image pattern (which printed at ~3 MB a page).
 */
function bandSvg(widthMm: number, id: string): string {
  const w = HOUSE_BAND_WAVELENGTH_MM * SCALE;
  const h = HOUSE_BAND_HEIGHT_MM * SCALE;
  const stroke = 0.26 * SCALE;
  const mid = h / 2;
  const amp = (mid - stroke) * (4 / 3);
  const n = (v: number) => Number(v.toFixed(3));
  const halves = Math.ceil((widthMm / w) * 2);
  const run = (sign: 1 | -1) => {
    let d = `M0 ${n(mid)}Q${n(w / 4)} ${n(mid - sign * amp)} ${n(w / 2)} ${n(mid)}`;
    for (let i = 2; i <= halves; i += 1) d += `T${n((w / 2) * i)} ${n(mid)}`;
    return d;
  };
  return `<svg class="band__svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(widthMm)} ${n(h)}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stop-color="${C.deep}"/><stop offset="0.4" stop-color="${C.blue}"/>
      <stop offset="0.72" stop-color="${C.light}"/><stop offset="1" stop-color="${GOLD.mid}"/></linearGradient></defs>
    <g fill="none" stroke="url(#${id})" stroke-width="${n(stroke)}"><path d="${run(1)}"/><path d="${run(-1)}"/></g></svg>`;
}


/** A four-point sparkle, the sheet's one recurring ornament. */
const SPARK = `<svg class="spk" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0 14.2 9.8 24 12 14.2 14.2 12 24 9.8 14.2 0 12 9.8 9.8Z"/></svg>`;

/** A guilloche rosette: thirty ellipses turned round one centre — the engraver's pattern banknotes use. */
function rosette(cx: number, cy: number, radius: number, color: string, opacity: number): string {
  let g = "";
  for (let a = 0; a < 180; a += 6) {
    g += `<ellipse cx="${cx}" cy="${cy}" rx="${radius}" ry="${num(radius * 0.3)}" transform="rotate(${a} ${cx} ${cy})"/>`;
  }
  return `<g fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="0.3">${g}</g>`;
}

/** A sheaf of fine curves sweeping across the ground, the way the wordmark's own waves do. */
function swoosh(): string {
  let d = "";
  for (let i = 0; i < 16; i += 1) {
    const dy = i * 2.6;
    d += `<path d="M-20 ${num(292 + dy)}C200 ${num(392 + dy)} 430 ${num(112 + dy)} 940 ${num(196 + dy)}" stroke="${i % 2 === 0 ? GOLD.mid : C.blue}"/>`;
  }
  return `<g fill="none" stroke-opacity="0.22" stroke-width="0.32">${d}</g>`;
}

/** The engraved ground: a field of phase-shifted waves in blue, and two gold rosettes, all faint. */
function groundSvg(): string {
  const width = 914;
  const height = 406;
  const wavelength = 44;
  const amp = 5;
  let waves = "";
  for (let row = 0; row < 30; row += 1) {
    const y = 8 + row * 13.4;
    const sign = row % 2 === 0 ? 1 : -1;
    let d = `M0 ${num(y)}Q${num(wavelength / 4)} ${num(y - sign * amp)} ${num(wavelength / 2)} ${num(y)}`;
    for (let i = 2; i <= Math.ceil(width / (wavelength / 2)); i += 1) d += `T${num((wavelength / 2) * i)} ${num(y)}`;
    waves += `<path d="${d}"/>`;
  }
  return `<svg class="ground" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <g fill="none" stroke="${C.deep}" stroke-opacity="0.05" stroke-width="0.3">${waves}</g>
    ${rosette(150, 200, 150, GOLD.mid, 0.2)}
    ${rosette(150, 200, 96, C.blue, 0.1)}
    ${rosette(770, 330, 105, GOLD.mid, 0.2)}
    ${rosette(770, 330, 66, C.blue, 0.1)}
    ${swoosh()}
  </svg>`;
}

/** A mitred corner ornament — square, gold outside and blue within, a diamond at the turn. */
const CORNER = `<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M2 98V2H98" fill="none" stroke="${GOLD.mid}" stroke-width="3"/>
  <path d="M14 98V14H98" fill="none" stroke="${C.light}" stroke-width="1.4"/>
  <path d="M26 98V26H98" fill="none" stroke="${GOLD.light}" stroke-width="0.9"/>
  <path d="M14 5 23 14 14 23 5 14Z" fill="${GOLD.mid}"/>
  <path d="M2 52A50 50 0 0 1 52 2M2 66A64 64 0 0 1 66 2" fill="none" stroke="${GOLD.light}" stroke-width="0.8"/>
  <path d="M2 80A78 78 0 0 1 80 2" fill="none" stroke="${C.light}" stroke-width="0.6"/>
  <circle cx="14" cy="14" r="2.2" fill="#FFFBEF"/>
</svg>`;

/** Sunburst rays fanning from the middle of a box — the rank's halo. */
function raysSvg(widthMm: number, heightMm: number): string {
  let g = "";
  const cx = widthMm / 2;
  const cy = heightMm / 2;
  for (let a = 0; a < 360; a += 7.5) {
    const rad = (a * Math.PI) / 180;
    g += `M${num(cx + 30 * Math.cos(rad))} ${num(cy + 30 * Math.sin(rad))}L${num(cx + 90 * Math.cos(rad))} ${num(cy + 90 * Math.sin(rad))}`;
  }
  return `<svg class="rays" viewBox="0 0 ${widthMm} ${heightMm}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${g}" fill="none" stroke="${GOLD.mid}" stroke-opacity="0.45" stroke-width="0.4"/></svg>`;
}

/** Four small L-brackets tucked into the corners of a box, inside its keyline. */
function bracketsSvg(widthMm: number, heightMm: number, color: string): string {
  const inset = 5.4;
  const len = 6;
  const c = (x: number, y: number, sx: number, sy: number) => `M${x} ${y + sy * len}V${y}H${x + sx * len}`;
  const d = [
    c(inset, inset, 1, 1),
    c(widthMm - inset, inset, -1, 1),
    c(inset, heightMm - inset, 1, -1),
    c(widthMm - inset, heightMm - inset, -1, -1),
  ].join("");
  return `<svg class="brk" viewBox="0 0 ${widthMm} ${heightMm}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="0.5"/></svg>`;
}

/** The title as vector text with a gradient fill — background-clip:text prints as a solid block in a PDF. */
const TITLE_SVG = `<svg class="ttl" viewBox="0 0 142 20" aria-label="Award Cheque">
  <defs><linearGradient id="ttlFill" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.deep}"/><stop offset="0.4" stop-color="${C.blue}"/><stop offset="0.43" stop-color="${GOLD.deep}"/><stop offset="0.72" stop-color="${GOLD.mid}"/><stop offset="1" stop-color="${GOLD.light}"/></linearGradient></defs>
  <text x="0" y="15" font-family="Noto Sans, Segoe UI, Arial, sans-serif" font-weight="700" font-size="19.05" fill="url(#ttlFill)">Award Cheque</text></svg>`;

const MICROTEXT = Array.from({ length: 30 }, () => "SATO PHARMA \u00b7 SEMESTER ACHIEVERS AWARD \u00b7 S1 2026 \u00b7 ").join("");

function chequeBody(row: AwardChequeRow): string {
  const date = dateParts(row.transferDate);
  const words = chequeAmountInArabic(row.amountEgp);
  const position = row.positionTitle?.trim() ?? "";
  const stats = row.rank != null || row.achievementPct != null;
  const machine = `| ${bare(row.serial)} | ${date.digits} : ${
    row.amountEgp === null ? "0000000000" : String(Math.round(row.amountEgp * 100)).padStart(10, "0")
  } |`;

  return `
    <header class="head">
      <h1>${TITLE_SVG}${SPARK}${SPARK}</h1>
      <p class="head__prog">${escapeHtml(row.programName)}</p>
    </header>

    <section class="numdate">
      <div class="cap"><span>Cheque No.</span></div>
      <p class="no">${escapeHtml(row.serial)}</p>
      <div class="cap cap--date"><span>Transfer date</span></div>
      <div class="date">
        <div class="date__cell"><b>${date.d}</b><i>DD</i></div>
        <div class="date__cell"><b>${date.m}</b><i>MM</i></div>
        <div class="date__cell date__cell--y"><b>${date.y}</b><i>YYYY</i></div>
      </div>
    </section>

    <section class="payee">
      <div class="cap"><span>Pay to the order of</span><span class="ar" dir="rtl" lang="ar">ادفعوا لأمر</span></div>
      <div class="payee__line">
        <p class="payee__row">
          <span class="payee__name" style="font-size:${namePt(row.recipientName, PAYEE_ROW_MM - (position === "" ? 0 : position.length * 6.6 + 26), 84, 44)}pt">${escapeHtml(row.recipientName)}</span>${
            position === "" ? "" : `<span class="payee__dash">&ndash;</span><span class="payee__pos">${escapeHtml(position)}</span>`
          }
        </p>
      </div>
    </section>

    <section class="words">
      <div class="words__ruled">
        <div class="words__rule"></div>
        <span class="words__lab words__lab--en">The sum of</span>
        <span class="words__lab words__lab--ar" dir="rtl" lang="ar">مبلغ وقدره</span>
        <p class="words__ar" dir="rtl" lang="ar" style="font-size:${wordsPt(words, BOXES_WIDTH_MM - WORDS_GUTTER_MM, 76, 36)}pt">${escapeHtml(words)}</p>
      </div>
    </section>

    <section class="foot">
      <div class="memo">
        <div class="cap"><span>For</span><span class="ar" dir="rtl" lang="ar">عن</span></div>
        ${
          stats
            ? `<div class="stats">
          <div class="stat stat--rank">${raysSvg(118, 48)}${bracketsSvg(118, 48, GOLD.deep)}<i>${SPARK}Rank${SPARK}</i><b>${
            row.rank == null ? "&ndash;" : `${row.rank}<small>${ordinalSuffix(row.rank)}</small>`
          }</b></div>
          <div class="stat stat--wide">${bracketsSvg(120, 48, C.deep)}<i>Achievement</i><b>${
            row.achievementPct == null ? "&ndash;" : `${row.achievementPct.toFixed(1)}<small>%</small>`
          }</b></div>
        </div>`
            : `<p class="memo__line">${escapeHtml(row.awardTitle)}</p>`
        }
      </div>
      <div class="amount">
        <div class="cap"><span>Amount</span><span class="ar" dir="rtl" lang="ar">المبلغ</span></div>
        <div class="amount__box">
          <svg class="amount__pat" viewBox="0 0 226 48" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${rosette(113, 24, 70, "#FFFFFF", 0.13)}</svg>
          ${bracketsSvg(226, 48, GOLD.light)}
          <p class="amount__cur">EGP <span class="ar" dir="rtl" lang="ar">ج.م</span></p>
          <p class="amount__fig">${egpFigures(row.amountEgp)}<small>.${row.amountEgp === null ? "XX" : "00"}</small></p>
        </div>
      </div>
      <div class="sig">
        <div class="sig__rule">${
          row.ceoSignatureUri ? `<img class="sig__img" alt="" src="${row.ceoSignatureUri}">` : ""
        }</div>
        <div class="cap"><span>Chief Executive Officer</span><span class="ar" dir="rtl" lang="ar">الرئيس التنفيذي</span></div>
      </div>
    </section>

    <div class="machine">
      <p class="machine__line" dir="ltr">${machine}</p>
      <p class="machine__rec"><span>Record</span> <strong>SATO-DIS-2026-01 v1.0</strong></p>
    </div>`;
}

function pageShell(row: AwardChequeRow): string {
  return `<div class="sheet">
    ${groundSvg()}
    <div class="watermark">${arabicMark()}</div>
    <div class="micro micro--top" aria-hidden="true">${MICROTEXT}</div>
    <div class="micro micro--foot" aria-hidden="true">${MICROTEXT}</div>
    <div class="frame">
      <i class="corner corner--tl">${CORNER}</i><i class="corner corner--tr">${CORNER}</i>
      <i class="corner corner--bl">${CORNER}</i><i class="corner corner--br">${CORNER}</i>
    </div>
    <div class="page">
      <header class="lh">
        <div class="lh__mark">${houseMark()}</div>
        <div class="lh__id"><strong dir="rtl" lang="ar">${escapeHtml(systemLegalEntity.legalNameAr)}</strong><span dir="ltr">${escapeHtml(systemLegalEntity.legalNameEn)}</span></div>
      </header>
      <div class="band">${bandSvg(BAND_WIDTH_MM, "bandTop")}</div>
      <div class="inner">${chequeBody(row)}</div>
      <div class="band band--foot">${bandSvg(BAND_WIDTH_MM, "bandFoot")}</div>
    </div>
  </div>`;
}

const CSS = `
  /* A real cheque's own proportions (~2.25:1), printed at a common oversized presentation-cheque
     size — 36in x 16in. */
  @page { size: 914mm 406mm; margin: 0; }
  @font-face { font-family: "Amiri Quran"; font-weight: 400; font-style: normal;
    src: url("${quranFace()}") format("truetype"); }
  :root {
    --ink: ${C.ink}; --deep: ${C.deep}; --blue: ${C.blue}; --light: ${C.light};
    --hair: ${C.hair}; --muted: ${C.muted}; --body: ${C.body};
    --gold: ${GOLD.mid}; --gold-deep: ${GOLD.deep}; --gold-light: ${GOLD.light};
    /* Chromium in the production image installs font-noto and nothing else, so the sheet is set in
       faces that are actually there. */
    --text: "Noto Sans", "Segoe UI", Calibri, Helvetica, Arial, sans-serif;
    --arabic: "Noto Naskh Arabic", "Noto Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif;
    --quran: "Amiri Quran", "Noto Naskh Arabic", "Segoe UI", Tahoma, serif;
    --mono: "Noto Sans Mono", "Consolas", "Courier New", monospace;
    /* The house hairline is 0.5 pt on A4; on this sheet it is scaled with everything else. */
    --hair-w: ${0.5 * SCALE}pt; --rule-w: ${0.6 * SCALE}pt;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; border-radius: 0; }
  body { font-family: var(--text); color: var(--body); background: #FFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; font-kerning: normal; }

  .sheet { position: relative; width: 914mm; height: 406mm; overflow: hidden;
    background: linear-gradient(135deg, #FFFFFF 0%, #F3F8FD 42%, #E4EEF8 74%, #F6EFDC 100%); }
  .ground { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }

  /* The Arabic wordmark as the certificate carries it: large, one ink, faint, on the right, its
     ink laid to the trim and never past it, behind everything else. */
  .watermark { position: absolute; right: 0; top: 46mm; height: 262mm; z-index: 0; pointer-events: none; }
  .watermark img { display: block; height: 100%; width: auto; opacity: .13; filter: brightness(0); }

  .frame { position: absolute; inset: 12mm; border: ${0.5 * SCALE}pt solid var(--gold); border-image: linear-gradient(135deg, ${GOLD.deep} 0%, ${GOLD.light} 25%, ${GOLD.mid} 50%, ${GOLD.light} 75%, ${GOLD.deep} 100%) 1; z-index: 1; }
  .corner { position: absolute; width: 21mm; height: 21mm; display: block; }
  .corner svg { display: block; width: 100%; height: 100%; }
  .corner--tl { left: -1.2mm; top: -1.2mm; }
  .corner--tr { right: -1.2mm; top: -1.2mm; transform: scaleX(-1); }
  .corner--bl { left: -1.2mm; bottom: -1.2mm; transform: scaleY(-1); }
  .corner--br { right: -1.2mm; bottom: -1.2mm; transform: scale(-1, -1); }
  .frame::after { content: ""; position: absolute; inset: 3.4mm; border: ${0.25 * SCALE}pt solid var(--light); }
  .micro { position: absolute; left: 30mm; right: 30mm; height: 4.6mm; overflow: hidden; white-space: nowrap; z-index: 1;
    font-size: 8pt; font-weight: 700; letter-spacing: .5em; line-height: 4.6mm; color: var(--gold-deep); opacity: .8; text-align: center; }
  .micro--top { top: 17.6mm; }
  .micro--foot { bottom: 17mm; }
  .page { position: absolute; inset: 12mm; z-index: 2; padding: 15mm 22mm 12mm; display: flex; flex-direction: column; }

  /* ---------- the letterhead, as house-identity.ts draws it, scaled ---------- */
  .lh { flex: 0 0 auto; display: flex; direction: ltr; align-items: flex-end; justify-content: space-between; gap: 32mm; }
  .lh__mark img { display: block; width: ${34 * 3}mm; height: auto; }
  .lh__id { text-align: right; color: var(--muted); font-size: 21pt; line-height: 1.5; }
  .lh__id strong { display: block; color: var(--deep); font-size: 27pt; font-weight: 700; }
  .lh__id span { display: block; }
  /* The engine-turned band — line, never area. The tile is exactly one wavelength, scaled here by
     the same factor as the rest of the sheet so it still tiles without a seam. */
  .band { flex: 0 0 auto; height: ${HOUSE_BAND_HEIGHT_MM * SCALE}mm; margin-top: 7mm; }
  .band__svg { display: block; width: 100%; height: 100%; }
  .band--foot { margin-top: 5mm; }
  .band { position: relative; }
  .band:not(.band--foot)::after { content: ""; position: absolute; left: 0; right: 0; top: calc(100% + 2.2mm);
    border-top: ${0.3 * SCALE}pt solid var(--gold-light); }

  /* The cheque's grid: title | cheque no. and date, payee and position, the words and the figures
     box between two rules, memo and signatures, machine line. */
  .inner { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 226mm;
    column-gap: 24mm; grid-template-rows: 54mm 64mm 60mm 80mm 1fr; row-gap: 3mm; padding-top: 10mm; }

  /* Bilingual caption row: English left, Arabic right, the way a bilingual cheque prints it. The
     house micro label: small, bold, upper case, tracked; the Arabic keeps no letter-spacing. */
  .cap { display: flex; justify-content: space-between; align-items: baseline; gap: 8mm;
    font-size: 15pt; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--muted); }
  .ar { font-family: var(--arabic); font-size: 21pt; font-weight: 700; letter-spacing: 0;
    text-transform: none; color: var(--deep); }

  .head { position: relative; grid-column: 1; grid-row: 1; display: flex; flex-direction: column; justify-content: center; }
  .head h1 { font-size: 54pt; font-weight: 700; line-height: 1.1; color: var(--deep); }
  .head h1 .ttl { display: inline-block; height: 20mm; width: auto; vertical-align: -4.6mm; }
  .spk { display: inline-block; width: 15mm; height: 15mm; margin-left: 6mm; vertical-align: 5mm; fill: var(--gold); }
  .head h1 .spk + .spk { width: 8mm; height: 8mm; margin-left: 2mm; vertical-align: 15mm; fill: var(--gold-light); }
  .head__ar { text-align: left; margin-top: 1mm; font-family: var(--arabic); font-size: 36pt; font-weight: 600; line-height: 1.3; color: var(--blue); }
  .head__prog { margin-top: 3mm; font-size: 20pt; font-weight: 700; letter-spacing: .04em; color: var(--gold-deep); }

  .numdate { grid-column: 2; grid-row: 1; display: flex; flex-direction: column; justify-content: center; }
  .no { margin: 1.5mm 0 4mm; font-size: 30pt; font-weight: 700; color: var(--deep); letter-spacing: .04em;
    font-variant-numeric: lining-nums tabular-nums; }
  .cap--date { margin-top: 1mm; }
  .date { margin-top: 2.5mm; display: flex; gap: 3mm; }
  .date__cell { flex: 1 1 0; background: linear-gradient(180deg, #FFFFFF 0%, #E6F0F8 100%); border: var(--rule-w) solid var(--deep); text-align: center; padding: 2.2mm 0 1.4mm; }
  .date__cell--y { flex: 1.9 1 0; }
  .date__cell { position: relative; }
  .date__cell::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1.3mm;
    background: linear-gradient(90deg, var(--gold-deep), var(--gold-light) 50%, var(--gold-deep)); }
  .date__cell b { display: block; font-size: 32pt; font-weight: 700; color: var(--body);
    font-variant-numeric: lining-nums tabular-nums; }
  .date__cell i { display: block; margin-top: .5mm; font-style: normal; font-size: 10pt; font-weight: 700;
    letter-spacing: .3em; color: var(--blue); }

  .payee { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; justify-content: center; }
  .payee__line { position: relative; margin-top: 3mm; padding-bottom: 2mm;
    background: linear-gradient(90deg, var(--deep) 0, var(--deep) 30%, var(--blue) 68%, var(--light) 100%) left bottom / 100% var(--rule-w) no-repeat; }
  /* A finer gold rule under the strong one, and a diamond closing its end — the engraved double rule. */
  .payee__line::after { content: ""; position: absolute; left: 0; right: 9mm; top: calc(100% + 1.6mm); height: ${0.35 * SCALE}pt;
    background: linear-gradient(90deg, var(--gold-deep) 0, var(--gold) 30%, var(--gold-light) 100%); }
  .payee__line::before { content: ""; position: absolute; right: 1.6mm; bottom: -1.8mm; width: 5.2mm; height: 5.2mm;
    background: var(--gold); transform: rotate(45deg); z-index: 1; }
  .payee__row { display: flex; align-items: baseline; white-space: nowrap; }
  .payee__dash { margin: 0 6mm; font-size: 44pt; font-weight: 500; color: var(--gold); }
  .payee__name { font-weight: 500; line-height: 1.15; color: var(--ink); white-space: nowrap; letter-spacing: -.005em; }
  .payee__pos { font-size: 24pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase;
    color: var(--gold-deep); white-space: nowrap; }

  /* The words and the figures sit between two rules — a deep one above and a hairline below. No
     fill anywhere: the house ink rule allows only the 6% zebra row. */
  .words { grid-column: 1 / -1; grid-row: 3; width: ${BOXES_WIDTH_MM}mm; padding-top: 5mm; display: flex; flex-direction: column; justify-content: center; }
  .words__ruled { position: relative; margin-top: 2mm; height: 42mm; }
  .words__rule { position: absolute; left: 0; right: 0; top: 34mm; height: var(--rule-w);
    background: linear-gradient(90deg, var(--gold) 0, var(--deep) 18%, var(--deep) 82%, var(--gold) 100%); }
  .words__rule::before, .words__rule::after { content: ""; position: absolute; top: -1.2mm; width: 3.2mm; height: 3.2mm;
    background: var(--gold); transform: rotate(45deg); }
  .words__rule::before { left: -1.6mm; }
  .words__rule::after { right: -1.6mm; }
  /* The two captions sit ON the words line, one at each end, the Arabic words between them. */
  .words__lab { position: absolute; top: 34mm; transform: translateY(-100%); padding-bottom: 9mm; white-space: nowrap;
    font-size: 16pt; font-weight: 700; letter-spacing: .24em; text-transform: uppercase; color: var(--gold-deep); }
  .words__lab--en { left: 0; }
  .words__lab--ar { right: 0; font-family: var(--arabic); font-size: 25pt; letter-spacing: 0; text-transform: none; color: var(--deep); }
  .words__ar { position: relative; top: 5.8mm; font-family: var(--quran); font-weight: 400; font-size: 70pt;
    line-height: 34mm; word-spacing: .12em; color: var(--ink); text-align: right; white-space: nowrap;
    margin-left: ${WORDS_LABEL_EN_MM}mm; margin-right: ${WORDS_LABEL_AR_MM}mm; }

  .amount { width: ${AMOUNT_WIDTH_MM}mm; display: flex; flex-direction: column; padding-bottom: 8mm; }
  /* A double keyline — Deep outside, Light inside — instead of a fill. */
  .amount__box { position: relative; overflow: hidden; background: linear-gradient(135deg, #073A58 0%, #0A527D 48%, #0A6BA6 100%); margin-top: 3mm; height: 48mm; border: var(--rule-w) solid var(--gold);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5mm; }
  .amount__box::after { content: ""; position: absolute; inset: 2.6mm; border: ${0.25 * SCALE}pt solid var(--gold-light); pointer-events: none; }
  .amount__pat { position: absolute; inset: 0; width: 100%; height: 100%; }
  .amount__box > p { position: relative; }
  .amount__cur { font-size: 16pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--gold-light); }
  .amount__cur .ar { font-size: 21pt; color: var(--gold-light); }
  .amount__fig { font-size: 72pt; font-weight: 700; color: #FFFFFF; line-height: 1.05;
    font-variant-numeric: lining-nums tabular-nums; }
  .amount__fig small { font-size: 36pt; color: var(--gold-light); }

  .foot { grid-column: 1 / -1; grid-row: 4; display: grid; grid-template-columns: ${STAT_ROW_WIDTH_MM}mm ${AMOUNT_WIDTH_MM}mm minmax(0, 1fr);
    column-gap: ${FOOT_GAP_MM}mm; align-items: end; }
  .memo__line { margin-top: 3mm; border-bottom: var(--hair-w) solid var(--hair); padding-bottom: 2mm;
    font-size: 25pt; line-height: 1.5; color: var(--body); white-space: nowrap; }
  .stats { margin-top: 3mm; margin-bottom: 8mm; display: flex; gap: 6mm; }
  .stat { flex: 0 0 auto; min-width: 64mm; background: linear-gradient(180deg, #F7FBFE 0%, #D9E9F6 100%); border: var(--rule-w) solid var(--deep); text-align: center; padding: 2mm 8mm 2.5mm; }
  .stat--wide { position: relative; width: 120mm; min-width: 120mm; }
  .stat--wide::after { content: ""; position: absolute; inset: 2mm; border: ${0.25 * SCALE}pt solid var(--light); pointer-events: none; }
  .stat { display: flex; flex-direction: column; justify-content: center; height: 48mm; box-sizing: border-box; }
  /* The rank is the headline: a larger box, a double keyline (Deep outside, Light inside) and the
     ordinal set beside the figure. Still no fill. */
  .stat--rank { position: relative; width: 118mm; min-width: 118mm; padding-top: 3mm; padding-bottom: 3.5mm;
    background: linear-gradient(180deg, ${GOLD.tint} 0%, ${GOLD.tint2} 100%); border-color: var(--gold); }
  .stat--rank::after { content: ""; position: absolute; inset: 2mm; border: ${0.25 * SCALE}pt solid var(--gold-deep); pointer-events: none; }
  .stat--rank i { color: var(--gold-deep); }
  .stat--rank { overflow: hidden; }
  .rays, .brk { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .stat--rank i, .stat.stat--rank b { position: relative; }
  .amount__box .brk { z-index: 0; }
  .stat--rank .spk { width: 6mm; height: 6mm; margin: 0 4mm; vertical-align: -.6mm; fill: var(--gold); }
  .stat.stat--rank b { font-size: 84pt; color: var(--gold-deep); }
  .stat.stat--rank b small { font-size: 40pt; margin-left: 1.5mm; }
  .stat i .ar { font-size: 15pt; letter-spacing: 0; margin-left: 3mm; }
  .stat i { display: block; font-style: normal; font-size: 13pt; font-weight: 700; letter-spacing: .3em;
    text-transform: uppercase; color: var(--blue); }
  .stat b { display: block; margin-top: 1mm; font-size: 50pt; font-weight: 700; line-height: 1.05; color: var(--deep);
    font-variant-numeric: lining-nums tabular-nums; }
  .stat b small { font-size: 30pt; }
  .sig { justify-self: end; width: 260mm; padding-bottom: 8mm; }
  .sig__rule { position: relative; height: 36mm; margin-bottom: 4mm;
    background: linear-gradient(90deg, var(--gold-light) 0, var(--gold) 20%, var(--gold-deep) 50%, var(--gold) 80%, var(--gold-light) 100%) left bottom / 100% var(--rule-w) no-repeat; }
  .sig__rule::before, .sig__rule::after { content: ""; position: absolute; bottom: -1.6mm; width: 3.2mm; height: 3.2mm;
    background: var(--gold); transform: rotate(45deg); }
  .sig__rule::before { left: 2mm; }
  .sig__rule::after { right: 2mm; }
  .sig__img { position: absolute; left: 50%; bottom: -9mm; height: 76mm; transform: translateX(-50%); }
  .sig .cap { font-size: 13pt; letter-spacing: .16em; }
  .sig .ar { font-size: 19pt; }

  /* Machine line and the house record, the sheet's foot. */
  .machine { grid-column: 1 / -1; grid-row: 5; align-self: end; display: flex; align-items: flex-end;
    justify-content: space-between; padding-top: 3mm; }
  .machine__line { font-family: var(--mono); font-weight: 700; font-size: 24pt; letter-spacing: .3em;
    color: var(--deep); white-space: nowrap; }
  .machine__rec { font-size: 16pt; color: var(--body); }
  .machine__rec span { font-size: 13pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase;
    color: var(--muted); margin-right: 3mm; }
  .machine__rec strong { color: var(--deep); font-weight: 700; }
`;

/** The whole document as HTML — pure, so it can be previewed or tested without Chromium. */
export function awardChequeDocumentHtml(row: AwardChequeRow = AWARD_CHEQUE_PLACEHOLDER): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(row.recipientName)} — ${escapeHtml(row.awardTitle)}</title><style>${CSS}</style></head>
<body>${pageShell(row)}<script>${FIT_WORDS_SCRIPT}</script></body></html>`;
}

/** Render one cheque to PDF. Throws `ChromiumUnavailableError` when the runtime cannot produce one. */
export async function renderAwardChequePdf(row: AwardChequeRow = AWARD_CHEQUE_PLACEHOLDER): Promise<Uint8Array> {
  const html = awardChequeDocumentHtml(row);
  return withChromiumPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    // The Amiri Quran face arrives as a data URI; print before it has decoded and the words fall back.
    await page.evaluate("document.fonts.ready.then(() => document.fonts.size)");
    await page.emulateMediaType("print");
    return page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}

/** One cheque per row, merged into a single multi-page PDF — for a batch review pass or a print run. */
export async function renderAwardChequeBatchPdf(rows: AwardChequeRow[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  for (const row of rows) {
    const source = await PDFDocument.load(await renderAwardChequePdf(row));
    for (const page of await merged.copyPages(source, source.getPageIndices())) merged.addPage(page);
  }
  return merged.save();
}
