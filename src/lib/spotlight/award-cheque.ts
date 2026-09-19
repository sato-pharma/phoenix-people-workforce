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

// The three boxes (Rank, Achievement, Amount) and the Arabic words share one width — the words line
// runs exactly the span of the boxes and never past it (owner, 2026-09-20).
const STAT_ROW_WIDTH_MM = 118 + 6 + 120;
const AMOUNT_WIDTH_MM = 226;
const FOOT_GAP_MM = 16;
const BOXES_WIDTH_MM = STAT_ROW_WIDTH_MM + FOOT_GAP_MM + AMOUNT_WIDTH_MM;

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
function bandSvg(widthMm: number): string {
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
    <g fill="none" stroke="${C.deep}" stroke-width="${n(stroke)}"><path d="${run(1)}"/><path d="${run(-1)}"/></g></svg>`;
}

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
      <h1>Award Cheque</h1>
      <p class="head__prog">${escapeHtml(row.programName)}</p>
    </header>

    <section class="numdate">
      <div class="cap"><span>Cheque No.</span><span class="ar" dir="rtl" lang="ar">رقم الشيك</span></div>
      <p class="no">${escapeHtml(row.serial)}</p>
      <div class="cap cap--date"><span>Transfer date</span><span class="ar" dir="rtl" lang="ar">تاريخ التحويل</span></div>
      <div class="date">
        <div class="date__cell"><b>${date.d}</b><i>DD</i></div>
        <div class="date__cell"><b>${date.m}</b><i>MM</i></div>
        <div class="date__cell date__cell--y"><b>${date.y}</b><i>YYYY</i></div>
      </div>
    </section>

    <section class="payee">
      <div class="cap"><span>Pay to the order of</span><span class="ar" dir="rtl" lang="ar">ادفعوا لأمر</span></div>
      <div class="payee__line">
        <p class="payee__name" style="font-size:${namePt(row.recipientName, 570, 84, 44)}pt">${escapeHtml(row.recipientName)}</p>
      </div>
      ${position === "" ? "" : `<p class="payee__pos">${escapeHtml(position)}</p>`}
    </section>

    <div class="sumrule"></div>

    <section class="words">
      <div class="cap"><span>The sum of</span><span class="ar" dir="rtl" lang="ar">مبلغ وقدره</span></div>
      <div class="words__ruled">
        <div class="words__rule"></div>
        <p class="words__ar" dir="rtl" lang="ar" style="font-size:${wordsPt(words, BOXES_WIDTH_MM, 76, 40)}pt">${escapeHtml(words)}</p>
      </div>
    </section>

    <section class="foot">
      <div class="memo">
        <div class="cap"><span>For</span><span class="ar" dir="rtl" lang="ar">عن</span></div>
        ${
          stats
            ? `<div class="stats">
          <div class="stat stat--rank"><i>Rank</i><b>${
            row.rank == null ? "&ndash;" : `${row.rank}<small>${ordinalSuffix(row.rank)}</small>`
          }</b></div>
          <div class="stat stat--wide"><i>Achievement</i><b>${
            row.achievementPct == null ? "&ndash;" : `${row.achievementPct.toFixed(1)}<small>%</small>`
          }</b></div>
        </div>`
            : `<p class="memo__line">${escapeHtml(row.awardTitle)}</p>`
        }
      </div>
      <div class="amount">
        <div class="cap"><span>Amount</span><span class="ar" dir="rtl" lang="ar">المبلغ</span></div>
        <div class="amount__box">
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
    <div class="watermark">${arabicMark()}</div>
    <div class="frame"></div>
    <div class="page">
      <header class="lh">
        <div class="lh__mark">${houseMark()}</div>
        <div class="lh__id"><strong dir="rtl" lang="ar">${escapeHtml(systemLegalEntity.legalNameAr)}</strong><span dir="ltr">${escapeHtml(systemLegalEntity.legalNameEn)}</span></div>
      </header>
      <div class="band">${bandSvg(BAND_WIDTH_MM)}</div>
      <div class="inner">${chequeBody(row)}</div>
      <div class="band band--foot">${bandSvg(BAND_WIDTH_MM)}</div>
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

  .sheet { position: relative; width: 914mm; height: 406mm; overflow: hidden; background: #FFF; }

  /* The Arabic wordmark as the certificate carries it: large, one ink, faint, on the right, its
     ink laid to the trim and never past it, behind everything else. */
  .watermark { position: absolute; right: 0; top: 46mm; height: 262mm; z-index: 0; pointer-events: none; }
  .watermark img { display: block; height: 100%; width: auto; opacity: .12; filter: brightness(0); }

  .frame { position: absolute; inset: 12mm; border: var(--hair-w) solid var(--hair); z-index: 1; }
  .frame::after { content: ""; position: absolute; inset: 3.4mm; border: ${0.25 * SCALE}pt solid var(--light); }
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

  .head { grid-column: 1; grid-row: 1; display: flex; flex-direction: column; justify-content: center; }
  .head h1 { font-size: 54pt; font-weight: 700; line-height: 1.1; color: var(--deep); }
  .head__ar { text-align: left; margin-top: 1mm; font-family: var(--arabic); font-size: 36pt; font-weight: 600; line-height: 1.3; color: var(--blue); }
  .head__prog { margin-top: 3mm; font-size: 20pt; font-weight: 600; color: var(--muted); }

  .numdate { grid-column: 2; grid-row: 1; display: flex; flex-direction: column; justify-content: center; }
  .no { margin: 1.5mm 0 4mm; font-size: 30pt; font-weight: 700; color: var(--deep); letter-spacing: .04em;
    font-variant-numeric: lining-nums tabular-nums; }
  .cap--date { margin-top: 1mm; }
  .date { margin-top: 2.5mm; display: flex; gap: 3mm; }
  .date__cell { flex: 1 1 0; background: rgba(255, 255, 255, .8); border: var(--rule-w) solid var(--deep); text-align: center; padding: 2.2mm 0 1.4mm; }
  .date__cell--y { flex: 1.9 1 0; }
  .date__cell b { display: block; font-size: 32pt; font-weight: 700; color: var(--body);
    font-variant-numeric: lining-nums tabular-nums; }
  .date__cell i { display: block; margin-top: .5mm; font-style: normal; font-size: 10pt; font-weight: 700;
    letter-spacing: .3em; color: var(--muted); }

  .payee { grid-column: 1; grid-row: 2; display: flex; flex-direction: column; justify-content: center; }
  .payee__line { margin-top: 3mm; border-bottom: var(--rule-w) solid var(--deep); padding-bottom: 2mm; }
  .payee__name { font-weight: 500; line-height: 1.15; color: var(--ink); white-space: nowrap; letter-spacing: -.005em; }
  .payee__pos { margin-top: 4mm; font-size: 24pt; font-weight: 700; letter-spacing: .16em; text-transform: uppercase;
    color: var(--blue); white-space: nowrap; }

  /* The words and the figures sit between two rules — a deep one above and a hairline below. No
     fill anywhere: the house ink rule allows only the 6% zebra row. */
  .sumrule { grid-column: 1 / -1; grid-row: 3; border-top: var(--rule-w) solid var(--deep); }
  .words { grid-column: 1 / -1; grid-row: 3; width: ${BOXES_WIDTH_MM}mm; border-bottom: var(--hair-w) solid var(--hair); display: flex; flex-direction: column; justify-content: center; }
  .words__ruled { position: relative; margin-top: 2mm; height: 42mm; }
  .words__rule { position: absolute; left: 0; right: 0; top: 34mm; border-top: var(--hair-w) solid var(--deep); }
  .words__ar { position: relative; top: 2.2mm; font-family: var(--quran); font-weight: 400; font-size: 70pt;
    line-height: 34mm; word-spacing: .12em; color: var(--ink); text-align: right; white-space: nowrap; }

  .amount { width: ${AMOUNT_WIDTH_MM}mm; display: flex; flex-direction: column; padding-bottom: 8mm; }
  /* A double keyline — Deep outside, Light inside — instead of a fill. */
  .amount__box { position: relative; background: rgba(255, 255, 255, .8); margin-top: 3mm; height: 48mm; border: var(--rule-w) solid var(--deep);
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1.5mm; }
  .amount__box::after { content: ""; position: absolute; inset: 2.6mm; border: ${0.25 * SCALE}pt solid var(--light); pointer-events: none; }
  .amount__cur { font-size: 16pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase; color: var(--blue); }
  .amount__cur .ar { font-size: 21pt; }
  .amount__fig { font-size: 72pt; font-weight: 700; color: var(--deep); line-height: 1.05;
    font-variant-numeric: lining-nums tabular-nums; }
  .amount__fig small { font-size: 36pt; }

  .foot { grid-column: 1 / -1; grid-row: 4; display: grid; grid-template-columns: ${STAT_ROW_WIDTH_MM}mm ${AMOUNT_WIDTH_MM}mm minmax(0, 1fr);
    column-gap: ${FOOT_GAP_MM}mm; align-items: end; }
  .memo__line { margin-top: 3mm; border-bottom: var(--hair-w) solid var(--hair); padding-bottom: 2mm;
    font-size: 25pt; line-height: 1.5; color: var(--body); white-space: nowrap; }
  .stats { margin-top: 3mm; margin-bottom: 8mm; display: flex; gap: 6mm; }
  .stat { flex: 0 0 auto; min-width: 64mm; background: rgba(255, 255, 255, .8); border: var(--rule-w) solid var(--deep); text-align: center; padding: 2mm 8mm 2.5mm; }
  .stat--wide { width: 120mm; min-width: 120mm; }
  .stat { display: flex; flex-direction: column; justify-content: center; height: 48mm; box-sizing: border-box; }
  /* The rank is the headline: a larger box, a double keyline (Deep outside, Light inside) and the
     ordinal set beside the figure. Still no fill. */
  .stat--rank { position: relative; width: 118mm; min-width: 118mm; padding-top: 3mm; padding-bottom: 3.5mm; }
  .stat--rank::after { content: ""; position: absolute; inset: 2mm; border: ${0.25 * SCALE}pt solid var(--light); pointer-events: none; }
  .stat.stat--rank b { font-size: 84pt; }
  .stat.stat--rank b small { font-size: 40pt; margin-left: 1.5mm; }
  .stat i .ar { font-size: 15pt; letter-spacing: 0; margin-left: 3mm; }
  .stat i { display: block; font-style: normal; font-size: 13pt; font-weight: 700; letter-spacing: .3em;
    text-transform: uppercase; color: var(--blue); }
  .stat b { display: block; margin-top: 1mm; font-size: 50pt; font-weight: 700; line-height: 1.05; color: var(--deep);
    font-variant-numeric: lining-nums tabular-nums; }
  .stat b small { font-size: 30pt; }
  .sig { justify-self: end; width: 260mm; padding-bottom: 8mm; }
  .sig__rule { position: relative; height: 36mm; border-bottom: var(--hair-w) solid var(--deep); margin-bottom: 4mm; }
  .sig__img { position: absolute; left: 50%; bottom: 0; height: 76mm; transform: translateX(-50%); }
  .sig .cap { font-size: 13pt; letter-spacing: .16em; }
  .sig .ar { font-size: 19pt; }

  /* Machine line and the house record, the sheet's foot. */
  .machine { grid-column: 1 / -1; grid-row: 5; align-self: end; display: flex; align-items: flex-end;
    justify-content: space-between; padding-top: 3mm; }
  .machine__line { font-family: var(--mono); font-weight: 700; font-size: 24pt; letter-spacing: .3em;
    color: var(--body); white-space: nowrap; }
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
