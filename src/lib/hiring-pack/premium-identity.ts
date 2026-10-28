// The HR premium identity — the house identity SATO-DIS-2026-01 raised to premium.
//
// The owner named it on 2026-10-12, after the Talent Acquisition New Starter Handbook: "make all the
// normal templates or forms in Sato Pharma follow this perfect template. But not the governmental,
// the governmental as they are." The approved specimen, its generator and every measurement used here
// live in the skill `.claude/skills/hr-premium-identity/`.
//
// WHAT IT ADDS TO `house-identity.ts`, and nothing else. The palette, the on-light mark, the 6 mm
// engine-turned band and the ink rule are the house identity's, imported rather than re-typed. On top
// of them every page gets:
//   · a double-keyline FRAME with a line of security microtext between the keylines and a square
//     tile at each corner;
//   · the Arabic calligraphy as a 5% WATERMARK, and NOWHERE ELSE on the paper;
//   · a CENTRED MASTHEAD — the Latin mark, the title over a diamond rule, an empty right cell;
//   · a PHOENIX RUNNING FOOT carrying the identity code.
//
// DRESS ONLY. A paper keeps every word, field, clause, table and signature cell it had. A renderer
// swaps its masthead for `premiumMasthead()`, appends `premiumPageChrome()` to each copy, and takes
// its page geometry from `premiumSheetCss()`. Nothing in here knows what a contract says.
//
// GOVERNMENT FORMS ARE EXEMPT, PERMANENTLY, exactly as in `house-identity.ts`: Form 1, Form 6, the
// labour exit forms and the official pack forms print as the Authority issues them. Never import
// this module into `render-form1.ts`, `render-form6.ts`, `render-labour-exit.ts`,
// `render-official-form.ts` or `render-placement.ts`.
//
// THE ARABIC MARK IS NEVER IN THE MASTHEAD. The specimen set it at the masthead's right; the owner
// took it out the same evening — "make the arabic sato logo only as water mark … everywhere", then
// "watermark and footer only" (2026-10-12, about 23:50 Cairo). The right column now MIRRORS the left,
// so the title sits on the page's centre line, and the title column is exactly as wide as it was —
// it wraps on the same words and no paper can gain a line.
//
// NO SEAL, as in `house-identity.ts`. Nothing below draws a company stamp; the frame's corner tiles
// and the diamond rule are ornaments, not a seal, and they sit on no signature cell.

import {
  HOUSE_BAND_HEIGHT_MM,
  HOUSE_BAND_STROKE_MM,
  HOUSE_BAND_WAVELENGTH_MM,
  HOUSE_COLORS,
  HOUSE_MARK_SRC,
  type HouseLetterheadInput,
} from "@/lib/hiring-pack/house-identity";
import { escapeHtml } from "@/lib/hiring-pack/render-shared";

/** The identity code every premium paper carries in its running foot. */
export const PREMIUM_IDENTITY_CODE = "SATO-DIS-2026-01 v1.0";

/**
 * WHICH HIRING PAPERS WEAR THE PREMIUM DRESS — the owner's keep-or-change answers of 13 October 2026
 * (about 00:40 Cairo), given on the review page, one box per paper: "keep" means the paper prints as
 * it did before the identity existed.
 *
 * A KEPT PAPER KEEPS ITS PREMIUM BRANCH, SWITCHED OFF HERE, rather than having it torn out: the owner
 * changes his mind often and this is one line, with nothing rebuilt. Only a paper with a corporate
 * branch to fall back on needs a switch. The English certificate of experience and the English salary
 * letter were answered "change", so they wear it outright and have none; the contract, its annex and
 * its notice stay corporate by his earlier word and never import this module at all. The ARABIC
 * certificate of experience moved on his word of 2026-10-28 into the certificate's own design, through
 * its own renderer (`experience-certificate-ar.ts`) — so it is not listed in `hrPapers` either.
 *
 *   clearance   both clearance forms        custody   both custody receipts
 *   workerForm  the worker data form        hrPapers  an HR paper's FAMILY (its id without `-vN`)
 *
 * MUTABLE ON PURPOSE: `tests/hr-premium-identity.test.ts` flips each entry to prove BOTH branches
 * still render, then restores it. Nothing else writes it.
 */
export const PREMIUM_DRESS: {
  clearance: boolean;
  custody: boolean;
  workerForm: boolean;
  hrPapers: Set<string>;
} = {
  clearance: false,
  custody: false,
  workerForm: false,
  hrPapers: new Set(["exit-interview"]),
};

/** Whether an HR paper's current version wears the premium dress. `exit-interview-v1` → `exit-interview`. */
export function hrPaperWearsPremium(paperId: string): boolean {
  return PREMIUM_DRESS.hrPapers.has(paperId.replace(/-v\d+$/, ""));
}

/**
 * The Arabic calligraphy. PLACEHOLDER ART the owner is replacing himself — never regenerate it; swap
 * the file when he sends the official one (`tests/phoenix-official-logo.test.ts` pins it).
 */
export const PREMIUM_ARABIC_MARK_SRC = "/brand/sato-pharma-arabic-on-light.png";
/** Its pixel size, so the watermark's height is known without loading it. */
const ARABIC_MARK_PX = { width: 1100, height: 813 } as const;

/** The official Phoenix emblem — the ringed bird over rising bars. Running foot only. */
export const PREMIUM_PHOENIX_EMBLEM_SRC = "/brand/phoenix-login-emblem.png";

/**
 * The Latin face of the chrome: the masthead's Latin line, the frame microtext and the running foot.
 * Arabic never uses it — every paper keeps `ARABIC_FONT_STACK` for its own text, and Arabic is never
 * letter-spaced.
 */
export const PREMIUM_LATIN_FONT_STACK =
  '"Segoe UI Variable Text", "Segoe UI", "Noto Sans", Tahoma, Arial, sans-serif';

/**
 * The sheet. Fixed by the identity, not by any one paper: the frame and the foot sit at the same
 * place on every page of every premium paper, and only the content inside them moves.
 *
 * The content inset is tighter than the handbook's 15.5/17 mm because these papers were set for a
 * 190 mm column and several fill their one page exactly; at the handbook's inset the NDA and the
 * service-file sheet spill their signature blocks onto a second sheet. 12.5/14 mm still clears the
 * frame's corner tiles (which end 10 mm in) by two millimetres or more.
 */
export const PREMIUM_PAGE_MM = {
  width: 210,
  height: 297,
  /** Space above the first line on EVERY page — the frame is 8.8 mm deep at its inner keyline. */
  top: 12.5,
  /** Left and right content inset. */
  side: 14,
  /** Space below the last line on every page: the foot is 7.5 mm tall and sits 10.5 mm up. */
  bottom: 19.5,
} as const;

/**
 * The SAME sheet turned on its side, for the papers that are landscape by nature (the interview
 * calendar and the field-activity report). Only the two outer dimensions swap — the insets, the frame,
 * the foot and the watermark sit exactly where they do on a portrait sheet, measured from the edges.
 */
export const PREMIUM_LANDSCAPE_MM = {
  ...PREMIUM_PAGE_MM,
  width: PREMIUM_PAGE_MM.height,
  height: PREMIUM_PAGE_MM.width,
} as const;

export type PremiumOrientation = "portrait" | "landscape";

const pageOf = (orientation: PremiumOrientation) =>
  orientation === "landscape" ? PREMIUM_LANDSCAPE_MM : PREMIUM_PAGE_MM;

/** Where the running foot sits, measured from the bottom edge of the sheet. */
const FOOT_BOTTOM_MM = 10.5;
const FOOT_EMBLEM_MM = 5.5;

/** The content column every premium paper lays out in. */
export const PREMIUM_COLUMN_MM = PREMIUM_PAGE_MM.width - 2 * PREMIUM_PAGE_MM.side;
/** The content column of a landscape sheet. */
export const PREMIUM_LANDSCAPE_COLUMN_MM = PREMIUM_LANDSCAPE_MM.width - 2 * PREMIUM_LANDSCAPE_MM.side;

const n = (v: number) => Number(v.toFixed(3));

/**
 * The engine-turned band as ONE INLINE VECTOR across the column.
 *
 * The same geometry as `houseEngineTurnedBand()` — two sine passes half a wavelength apart, 6 mm
 * period, 1.5 mm tall, 0.26 mm stroke — but drawn as an element rather than a CSS background tile.
 * Chrome rasterises a background tile into the PDF, and on the handbook the band printed soft; an
 * inline SVG stays vector at any zoom. Centred, so the lenses fall symmetrically about the title.
 */
export function premiumBandSvg(color: string = HOUSE_COLORS.deep, widthMm: number = PREMIUM_COLUMN_MM): string {
  const w = HOUSE_BAND_WAVELENGTH_MM;
  const h = HOUSE_BAND_HEIGHT_MM;
  const mid = h / 2;
  const amp = (mid - HOUSE_BAND_STROKE_MM) * (4 / 3);
  const x0 = ((widthMm / 2 - w / 2) % w) - w;
  let up = "";
  let down = "";
  for (let x = x0; x < widthMm; x += w) {
    up += `M${n(x)} ${mid}Q${n(x + w / 4)} ${n(mid - amp)} ${n(x + w / 2)} ${mid}T${n(x + w)} ${mid}`;
    down += `M${n(x)} ${mid}Q${n(x + w / 4)} ${n(mid + amp)} ${n(x + w / 2)} ${mid}T${n(x + w)} ${mid}`;
  }
  return `<svg class="pm-band" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(widthMm)} ${h}" preserveAspectRatio="none" aria-hidden="true">`
    + `<g fill="none" stroke="${color}" stroke-width="${HOUSE_BAND_STROKE_MM}"><path d="${up}"/><path d="${down}"/></g></svg>`;
}

/** The phrase the frame's microtext repeats. Words the papers already carry, never new claims. */
export const PREMIUM_FRAME_PHRASE = "SATO PHARMA L.L.C. · HUMAN RESOURCES · HEAD OFFICE · PHOENIX WORKFORCE";
/** The same phrase for a paper that says nothing about the app: Sato Pharma alone. */
export const PREMIUM_FRAME_PHRASE_SATO = "SATO PHARMA L.L.C. · HUMAN RESOURCES · HEAD OFFICE";

/**
 * WHOSE NAME THE RUNNING FOOT CARRIES. `"phoenix"` is the specimen the owner approved: the ringed
 * emblem and PHOENIX WORKFORCE at the foot's left. `"sato"` leaves that slot empty and the frame's
 * microtext names Sato Pharma alone.
 *
 * `"sato"` is for a paper whose reader is outside the app, or one the owner has ruled must say nothing
 * about it: the job offer ("nothing says Phoenix to the candidate", `src/lib/offers/identity.ts`) and
 * the payslip and the organogram record, whose tests have pinned "no Phoenix branding on a company
 * document" since 2026-09-05. Every one of them reads this ONE constant, so changing his mind about
 * the foot is a single line.
 */
export type PremiumFootBrand = "phoenix" | "sato";
export const PREMIUM_COMPANY_DOCUMENT_BRAND: PremiumFootBrand = "sato";

/**
 * The page frame, in millimetres over the whole sheet: a deep keyline 6 mm in, a light keyline
 * 8.8 mm in, a line of security microtext between them on all four sides, and a square tile at each
 * corner.
 *
 * LATIN ONLY, deliberately. The microtext is fitted with `textLength`, which spaces the letters out to
 * the side's length — on Arabic that would break the joins between letters, so an Arabic phrase is
 * never passed here.
 *
 * 🔴 NO `transform` ANYWHERE IN THE FRAME. The frame is `position: fixed` in print, which is how Chrome
 * repeats it on every page — and Chrome paints a fixed element's TRANSFORMED children on the first
 * page only. With the side runs rotated and the corner pips turned 45°, page two of every multi-page
 * paper printed with empty side channels and hollow corner tiles (measured 2026-10-12 on
 * pages 2 and 3 of a three-page paper). So the side runs are laid on `<textPath>`s, which need no rotation, and
 * each pip is drawn as a four-point polygon rather than a turned square.
 */
export function premiumFrameSvg(
  phrase: string = PREMIUM_FRAME_PHRASE,
  orientation: PremiumOrientation = "portrait",
): string {
  const W = pageOf(orientation).width;
  const H = pageOf(orientation).height;
  const o = 6;
  const i = 8.8;
  const mid = (o + i) / 2;
  const tile = 5.2;
  const fs = 1.12;
  const half = fs * 0.36;
  const start = mid + tile / 2 + 1.6;
  const unit = `${phrase.trim()} · `;
  const run = (len: number) => {
    const reps = Math.max(1, Math.round((0.86 * len) / (unit.length * 0.6 * fs)));
    return escapeHtml(unit.repeat(reps).replace(/ · $/, ""));
  };
  const text = (len: number, attrs: string) =>
    `<text ${attrs} textLength="${n(len)}" lengthAdjust="spacing">${run(len)}</text>`;
  const sideText = (len: number, pathId: string) =>
    `<text textLength="${n(len)}" lengthAdjust="spacing"><textPath href="#${pathId}">${run(len)}</textPath></text>`;
  const across = W - 2 * start;
  const down = H - 2 * start;
  const corner = (cx: number, cy: number) => {
    const a = tile / 2;
    const b = a - 1.15;
    // The pip: a 1.1 mm square turned 45°, drawn by its four points (half-diagonal 0.55·√2).
    const r = 0.55 * Math.SQRT2;
    return `<rect x="${n(cx - a)}" y="${n(cy - a)}" width="${tile}" height="${tile}" fill="#fff" stroke="${HOUSE_COLORS.deep}" stroke-width="0.25"/>`
      + `<rect x="${n(cx - b)}" y="${n(cy - b)}" width="${n(2 * b)}" height="${n(2 * b)}" fill="none" stroke="${HOUSE_COLORS.light}" stroke-width="0.1"/>`
      + `<polygon points="${n(cx)},${n(cy - r)} ${n(cx + r)},${n(cy)} ${n(cx)},${n(cy + r)} ${n(cx - r)},${n(cy)}" fill="${HOUSE_COLORS.deep}"/>`;
  };
  // The side runs' baselines: the left reads UP the sheet, the right reads DOWN it, each glyph's top
  // toward the sheet's edge — exactly where the old rotated runs stood.
  const left = n(mid + half);
  const right = n(W - mid - half);
  return `<svg class="pm-frame" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" aria-hidden="true">`
    + `<defs><path id="pm-frame-left" d="M ${left} ${n(H - start)} L ${left} ${n(start)}"/>`
    + `<path id="pm-frame-right" d="M ${right} ${n(start)} L ${right} ${n(H - start)}"/></defs>`
    + `<rect x="${o}" y="${o}" width="${W - 2 * o}" height="${H - 2 * o}" fill="none" stroke="${HOUSE_COLORS.deep}" stroke-width="0.26"/>`
    + `<rect x="${i}" y="${i}" width="${n(W - 2 * i)}" height="${n(H - 2 * i)}" fill="none" stroke="${HOUSE_COLORS.light}" stroke-width="0.09"/>`
    // `direction="ltr"` IS LOAD-BEARING: SVG text inherits the page's direction, and on an Arabic
    // paper (`dir="rtl"`) every run anchored its END at x — so the microtext ran off the sheet
    // leftwards and the frame printed with empty channels (measured 2026-10-12 on the NDA).
    + `<g direction="ltr" fill="${HOUSE_COLORS.blue}" font-family="Segoe UI, Noto Sans, Arial, sans-serif" font-weight="600" font-size="${fs}">`
    + text(across, `x="${n(start)}" y="${n(mid + half)}"`)
    + text(across, `x="${n(start)}" y="${n(H - mid + half)}"`)
    + sideText(down, "pm-frame-left")
    + sideText(down, "pm-frame-right")
    + `</g>`
    + corner(mid, mid) + corner(W - mid, mid) + corner(mid, H - mid) + corner(W - mid, H - mid)
    + `</svg>`;
}

export interface PremiumMastheadInput {
  /**
   * The company's registered name in Arabic. Kept as text: it is the employer named on the paper.
   * EMPTY for a paper that carries no Arabic name (the English job offer): the Arabic run and the
   * diamond that joins it to the Latin name are then both left out, so no stray diamond leads the line.
   */
  legalNameAr: string;
  /** The same name in Latin script. */
  legalNameEn?: string | null;
  /** The paper's own title, exactly as the paper names itself. */
  title: string;
  /** "ar" for an Arabic title (never letter-spaced), "en" for an English-facing paper. */
  titleLang: "ar" | "en";
  /** An English-facing paper's Arabic name, printed under its English title. */
  titleAr?: string | null;
  /** The line(s) under the title — what the paper is for, or the law it rests on. */
  subtitles?: ReadonlyArray<{ text: string; lang: "ar" | "en" }>;
  /**
   * A smaller masthead, same parts, tighter: for papers that must hold one sheet.
   */
  compact?: boolean;
  /**
   * SLIM: one step tighter than compact — no diamond rule, a smaller title — for a masthead that is
   * repeated on every page of a long document (the field-activity report's day pages).
   */
  slim?: boolean;
  /** "landscape" for a sheet turned on its side: the band runs the wider column. Default portrait. */
  orientation?: PremiumOrientation;
  /**
   * The text slots — names, title, subtitles — arrive ALREADY ESCAPED and are written as given. For a
   * paper whose words are filled by a token pass that escapes once and keeps the designer's own
   * entities (the job offer: `fillOfferTokens`), escaping a second time would print `&amp;middot;` on
   * the letter. Default false: every other paper hands over plain text.
   */
  escaped?: boolean;
}

/**
 * The premium masthead: the Latin mark LEFT, the title block CENTRED, the right column EMPTY, and the
 * engine-turned band under them.
 *
 * NO ARABIC MARK HERE (owner, 2026-10-12: the Arabic logo goes in the watermark and the footer only).
 * The third grid column is empty and as wide as the Latin mark's, so the title is centred on the page.
 * The gaps closed by exactly what the right column grew: 32 + 1 + 1 + 32 = 32 + 5 + 5 + 24 = 66 mm of
 * fixed width either way, so the title column keeps the room it had, wraps on the same words, and the
 * masthead can only get shorter, never taller. `tests/hr-premium-identity.test.ts` holds that sum.
 *
 * PINNED LEFT-TO-RIGHT like the house letterhead, so the marks sit on the same sides of an Arabic
 * paper and an English one; each line inside keeps its own direction.
 *
 * The employer's legal name is the masthead's first line, both scripts side by side with a diamond
 * between them — two separate runs, never one mixed run, so neither script is turned around.
 *
 * `pm-mast__ref` is where `stampPaperReference()` writes the paper's reference number: at the END OF
 * THE NAME LINE, after a diamond, never on a line of its own. A line of its own cost 3.2 mm, and some
 * papers are set to their last millimetre: numbered, the employee clearance ran to a second sheet, and
 * the contract — while it was being tried in this dress — to a fourth (measured 2026-10-12). The name
 * line is the same on every paper and has room to spare, so the number costs no height anywhere.
 * Empty, the slot and its diamond take no space at all. It is right-to-left on every paper because
 * the line it receives is Arabic ("رقم المرجع:" and the number), and in a left-to-right block the
 * colon would land on the wrong side.
 */
export function premiumMasthead(input: PremiumMastheadInput): string {
  const esc = input.escaped ? (text: string) => text : escapeHtml;
  const hasNameAr = input.legalNameAr.trim() !== "";
  const nameAr = hasNameAr
    ? `<span class="pm-mast__name" dir="rtl" lang="ar">${esc(input.legalNameAr)}</span>`
    : "";
  const nameEn = input.legalNameEn?.trim()
    ? `${hasNameAr ? '<b class="pm-dia" aria-hidden="true"></b>' : ""}<span class="pm-mast__name pm-mast__name--en" dir="ltr" lang="en">${esc(input.legalNameEn.trim())}</span>`
    : "";
  const title = input.titleLang === "en"
    ? `<h1 class="pm-mast__t pm-mast__t--en" dir="ltr" lang="en">${esc(input.title)}</h1>`
    : `<h1 class="pm-mast__t" dir="rtl" lang="ar">${esc(input.title)}</h1>`;
  const titleAr = input.titleAr?.trim()
    ? `<p class="pm-mast__tar" dir="rtl" lang="ar">${esc(input.titleAr.trim())}</p>`
    : "";
  const subtitles = (input.subtitles ?? [])
    .filter((line) => line.text.trim())
    .map((line) =>
      `<p class="pm-mast__s" dir="${line.lang === "ar" ? "rtl" : "ltr"}" lang="${line.lang}">${esc(line.text.trim())}</p>`)
    .join("");

  const band = input.orientation === "landscape"
    ? premiumBandSvg(HOUSE_COLORS.deep, PREMIUM_LANDSCAPE_COLUMN_MM)
    : premiumBandSvg();
  const modifiers = (input.compact || input.slim ? " pm-mast--compact" : "") + (input.slim ? " pm-mast--slim" : "");
  return `<header class="pm-mast${modifiers}">
      <img class="pm-mast__latin" src="${HOUSE_MARK_SRC}" alt="Sato Pharma" width="401" height="158">
      <div class="pm-mast__mid">
        <div class="pm-mast__names">${nameAr}${nameEn}<span class="pm-mast__ref" dir="rtl"></span></div>
        ${title}${titleAr}
        <div class="pm-rule" aria-hidden="true"><i></i><b></b><i></i></div>
        ${subtitles}
      </div>
    </header>
    ${band}`;
}

/**
 * The premium version of `houseLetterhead()`, for the papers that open with it: the same input, the
 * same words, the premium masthead in place of the house one.
 *
 * `houseLetterhead()` ITSELF IS NOT TOUCHED — `tests/payslip-document.test.ts` pins its bytes, and the
 * payslip and the other company papers that call it keep their dress until the owner says otherwise.
 *
 * The purpose band ("who keeps this copy") keeps its class and its three shapes exactly as the house
 * letterhead writes them, so the line under the masthead reads the same and only its rules change.
 */
export function premiumLetterhead(
  input: HouseLetterheadInput,
  options: { compact?: boolean; slim?: boolean; orientation?: PremiumOrientation } = {},
): string {
  const titleEn = input.titleEn?.trim() ?? "";
  const subtitles: Array<{ text: string; lang: "ar" | "en" }> = [];
  if (input.subtitleAr?.trim()) subtitles.push({ text: input.subtitleAr.trim(), lang: "ar" });
  if (input.subtitleEn?.trim()) subtitles.push({ text: input.subtitleEn.trim(), lang: "en" });

  const masthead = premiumMasthead({
    legalNameAr: input.legalNameAr,
    legalNameEn: input.legalNameEn,
    title: titleEn || input.titleAr,
    titleLang: titleEn ? "en" : "ar",
    titleAr: titleEn ? input.titleAr : null,
    subtitles,
    compact: options.compact,
    slim: options.slim,
    orientation: options.orientation,
  });

  const purposeAr = input.purposeAr?.trim() ?? "";
  const purposeEn = input.purposeEn?.trim() ?? "";
  let purpose = "";
  if (purposeAr && !purposeEn) {
    purpose = `<p class="lh__purpose">${escapeHtml(purposeAr)}</p>`;
  } else if (purposeEn && !purposeAr) {
    purpose = `<p class="lh__purpose" dir="ltr">${escapeHtml(purposeEn)}</p>`;
  } else if (purposeAr && purposeEn) {
    purpose = `<div class="lh__purpose"><p>${escapeHtml(purposeAr)}</p>`
      + `<p dir="ltr">${escapeHtml(purposeEn)}</p></div>`;
  }
  return `${masthead}
    ${purpose}`;
}

export interface PremiumChromeInput {
  /** The department that issues the paper, as the foot names it. */
  department?: string;
  /** The frame's microtext phrase; Latin only. Defaults to the phrase that matches `brand`. */
  phrase?: string;
  /** Whose name the foot carries — see `PremiumFootBrand`. Default `"phoenix"`, the approved specimen. */
  brand?: PremiumFootBrand;
  /** "landscape" for a sheet turned on its side. Default portrait. */
  orientation?: PremiumOrientation;
}

/**
 * The parts of the page that are the SAME on every sheet: the watermark, the frame and the running
 * foot. Append it as the LAST child of each copy.
 *
 * LAST, AND THAT IS LOAD-BEARING. Hand-placed stamps and signatures are anchored by a positional path
 * (`td:nth-of-type(2)` and so on) measured inside the copy; an element added in front of them would
 * shift every stored path and move the owner's marks. Appended last, it shifts nothing.
 *
 * On SCREEN it sits on the copy's first sheet. In PRINT it is `position: fixed`, which Chrome repeats
 * on every printed page — and only the first copy's is shown, so a three-copy run does not stack three
 * frames on each sheet. `premiumSheetCss()` writes both halves.
 */
export function premiumPageChrome(input: PremiumChromeInput = {}): string {
  const department = input.department ?? "Human Resources";
  const sato = input.brand === "sato";
  const landscape = input.orientation === "landscape";
  // The portrait, Phoenix-footed chrome is byte-for-byte what it was before these options existed.
  const phrase = input.phrase ?? (sato ? PREMIUM_FRAME_PHRASE_SATO : undefined);
  const frame = landscape ? premiumFrameSvg(phrase, "landscape") : premiumFrameSvg(phrase);
  const left = sato
    ? `<div class="pm-foot__ph"></div>`
    : `<div class="pm-foot__ph"><img src="${PREMIUM_PHOENIX_EMBLEM_SRC}" alt="" width="384" height="384"><span>Phoenix Workforce</span></div>`;
  return `<div class="pm-chrome${landscape ? " pm-chrome--landscape" : ""}" aria-hidden="true">
      <img class="pm-watermark" src="${PREMIUM_ARABIC_MARK_SRC}" alt="" width="1100" height="813">
      ${frame}
      <div class="pm-foot">
        ${left}
        <div class="pm-foot__code" dir="ltr">Sato Pharma · ${escapeHtml(department)} · ${PREMIUM_IDENTITY_CODE}</div>
        <div class="pm-foot__end"><i class="pm-foot__dia"></i><b class="pm-foot__page"></b></div>
      </div>
    </div>`;
}

/**
 * Where a filed PDF writes "N / M": the right end of the running foot, centred on the foot's row, in
 * the foot's own deep ink and page-number size. `paper-pdf.ts` reads it rather than re-measuring.
 */
export const PREMIUM_PAGE_NUMBER_SLOT = {
  rightMm: PREMIUM_PAGE_MM.side,
  centreFromBottomMm: FOOT_BOTTOM_MM + FOOT_EMBLEM_MM / 2,
  sizePt: 8.5,
  color: HOUSE_COLORS.deep,
} as const;

/** The watermark's height at its printed width, so it can be placed from the top on screen. */
const WATERMARK_WIDTH_MM = 112;
const WATERMARK_HEIGHT_MM = n((WATERMARK_WIDTH_MM * ARABIC_MARK_PX.height) / ARABIC_MARK_PX.width);

/**
 * The page geometry for a paper whose copies are `sheet` elements (`.copy`, or `.cert`).
 *
 * `@page { margin: 0 }`, because a `position: fixed` frame is clipped to the page area: with the old
 * 10 mm margins the frame and the foot simply did not reach the edges (measured in Chrome 2026-10-12).
 * The space a margin used to give is the sheet's own padding instead, and `box-decoration-break:
 * clone` repeats that padding on EVERY printed page of a copy that runs over, so page two of a
 * custody receipt keeps its top inset and clears the foot exactly as page one does.
 */
export function premiumSheetCss(sheet: string, orientation: PremiumOrientation = "portrait"): string {
  const p = PREMIUM_PAGE_MM;
  return `
  @page { size: ${orientation === "landscape" ? "A4 landscape" : "A4"}; margin: 0; }
  ${sheet} {
    position: relative;
    padding: ${p.top}mm ${p.side}mm ${p.bottom}mm;
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  @media print {
    ${sheet} { padding: ${p.top}mm ${p.side}mm ${p.bottom}mm; }
    .pm-chrome .pm-frame { position: fixed; top: 0; left: 0; }
    .pm-chrome .pm-watermark { position: fixed; top: auto; right: 11mm; bottom: 21mm; }
    .pm-chrome .pm-foot { position: fixed; top: auto; left: ${p.side}mm; right: ${p.side}mm; bottom: ${FOOT_BOTTOM_MM}mm; }
    ${sheet} ~ ${sheet} .pm-chrome { display: none; }
  }`;
}

/**
 * The premium stylesheet: the chrome, the masthead and the type the chrome is set in.
 *
 * NO FILLED AREA, exactly as `HOUSE_IDENTITY_CSS`: rules and type only. The corner tiles' white is a
 * knock-out behind the frame, not ink, and the watermark is an image at 5%.
 *
 * SQUARE BY ABSENCE: nothing here sets a radius, and no reset is written either — the papers' own
 * tests assert that the word does not appear in their stylesheets at all.
 *
 * NO BACKTICKS IN THE CSS BELOW — it is a template literal, and one would close it.
 */
export const PREMIUM_IDENTITY_CSS = `
  :root, html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .pm-chrome { pointer-events: none; }
  .pm-chrome img, .pm-chrome svg { pointer-events: none; user-select: none; }
  .pm-frame { position: absolute; top: 0; left: 0; width: ${PREMIUM_PAGE_MM.width}mm; height: ${PREMIUM_PAGE_MM.height}mm; z-index: 2; direction: ltr; unicode-bidi: isolate; }
  .pm-watermark {
    position: absolute; right: 11mm; top: ${n(PREMIUM_PAGE_MM.height - 21 - WATERMARK_HEIGHT_MM)}mm;
    width: ${WATERMARK_WIDTH_MM}mm; height: auto; opacity: .05;
  }

  .pm-foot {
    position: absolute; left: ${PREMIUM_PAGE_MM.side}mm; right: ${PREMIUM_PAGE_MM.side}mm;
    top: ${n(PREMIUM_PAGE_MM.height - FOOT_BOTTOM_MM - FOOT_EMBLEM_MM - 2)}mm;
    display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
    padding-top: 2mm; border-top: .5pt solid ${HOUSE_COLORS.hair};
    direction: ltr; color: ${HOUSE_COLORS.muted};
    font-family: ${PREMIUM_LATIN_FONT_STACK}; font-size: 6.6pt; line-height: 1.2;
  }
  /* A landscape sheet: the frame, the watermark and the foot keep their distance from the edges. */
  .pm-chrome--landscape .pm-frame { width: ${PREMIUM_LANDSCAPE_MM.width}mm; height: ${PREMIUM_LANDSCAPE_MM.height}mm; }
  .pm-chrome--landscape .pm-watermark { top: ${n(PREMIUM_LANDSCAPE_MM.height - 21 - WATERMARK_HEIGHT_MM)}mm; }
  .pm-chrome--landscape .pm-foot { top: ${n(PREMIUM_LANDSCAPE_MM.height - FOOT_BOTTOM_MM - FOOT_EMBLEM_MM - 2)}mm; }
  .pm-foot__ph { display: flex; align-items: center; gap: 1.8mm; }
  .pm-foot__ph img { width: ${FOOT_EMBLEM_MM}mm; height: ${FOOT_EMBLEM_MM}mm; }
  .pm-foot__ph span { letter-spacing: 1pt; text-transform: uppercase; font-weight: 700; color: ${HOUSE_COLORS.deep}; font-size: 6.2pt; }
  /* The code line also carries dir="ltr" in its markup: "2026-01" is a dashed number, and one that
     only a stylesheet holds left-to-right is one a reader without it prints backwards. */
  .pm-foot__code { text-align: center; letter-spacing: .5pt; }
  .pm-foot__end { justify-self: end; display: flex; align-items: center; gap: 2mm; }
  .pm-foot__dia { display: block; width: 1.5mm; height: 1.5mm; border: .6pt solid ${HOUSE_COLORS.deep}; transform: rotate(45deg); }
  .pm-foot__page { min-width: 0; color: ${HOUSE_COLORS.deep}; font-size: 8.5pt; letter-spacing: 1pt; }
  /* The filed PDF stamps "N / M" into the foot after Chrome has counted the pages; the diamond
     steps aside for it. paper-pdf.ts sets the attribute. */
  html[data-pm-numbered] .pm-foot__dia { visibility: hidden; }

  /* ---------- the masthead ---------- */
  .pm-mast {
    display: grid; grid-template-columns: 32mm 1fr 32mm; align-items: center; column-gap: 1mm;
    direction: ltr;
  }
  .pm-mast__latin { display: block; width: 32mm; height: auto; }
  .pm-mast__mid { text-align: center; min-width: 0; }
  .pm-mast__names {
    display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: .4mm 2mm;
    color: ${HOUSE_COLORS.blue}; font-size: 7pt; font-weight: 700; line-height: 1.35;
  }
  .pm-mast__name--en {
    font-family: ${PREMIUM_LATIN_FONT_STACK}; font-size: 6.4pt; letter-spacing: 1.4pt; text-transform: uppercase;
  }
  .pm-dia { display: block; width: 1.1mm; height: 1.1mm; border: .5pt solid ${HOUSE_COLORS.light}; transform: rotate(45deg); }
  .pm-mast__t { margin: 1.2mm 0 0; color: ${HOUSE_COLORS.deep}; font-size: 14pt; font-weight: 700; line-height: 1.25; }
  .pm-mast__t--en {
    font-family: ${PREMIUM_LATIN_FONT_STACK}; font-size: 15pt; letter-spacing: -.2pt;
  }
  .pm-mast__tar { margin: .6mm 0 0; color: ${HOUSE_COLORS.blue}; font-size: 10pt; font-weight: 600; line-height: 1.3; }
  .pm-rule { display: flex; justify-content: center; align-items: center; gap: 1.6mm; margin: 1.4mm 0 1.2mm; }
  .pm-rule i { display: block; width: 9mm; border-top: .4pt solid ${HOUSE_COLORS.hair}; }
  .pm-rule b { display: block; width: 1.3mm; height: 1.3mm; border: .5pt solid ${HOUSE_COLORS.light}; transform: rotate(45deg); }
  .pm-mast__s { margin: 0; color: ${HOUSE_COLORS.muted}; font-size: 7.6pt; font-weight: 600; line-height: 1.4; }
  .pm-mast__s[lang="en"] { font-family: ${PREMIUM_LATIN_FONT_STACK}; font-size: 7pt; letter-spacing: .6pt; }
  .pm-mast__ref:empty { display: none; }
  /* The number joins the name line: its own diamond on its LEFT (row-reverse, because the slot is
     right-to-left), the same gap as the names, and no margin of its own, so the line keeps its height. */
  .pm-mast__ref { display: flex; flex-direction: row-reverse; align-items: center; gap: 2mm; }
  .pm-mast__ref::before {
    content: ""; display: block; box-sizing: border-box; width: 1.1mm; height: 1.1mm;
    border: .5pt solid ${HOUSE_COLORS.light}; transform: rotate(45deg);
  }
  .pm-mast__ref .hp-ref { margin: 0; color: ${HOUSE_COLORS.muted}; font-size: 6.5pt; line-height: 1.35; }
  .pm-band { display: block; width: 100%; height: ${HOUSE_BAND_HEIGHT_MM}mm; margin-top: 2.6mm; overflow: hidden; }

  .pm-mast--compact { grid-template-columns: 28mm 1fr 28mm; }
  .pm-mast--compact .pm-mast__latin { width: 28mm; }
  .pm-mast--compact .pm-mast__t { margin-top: .2mm; font-size: 12.5pt; }
  .pm-mast--compact .pm-rule { margin: .5mm 0 .3mm; }
  .pm-mast--compact + .pm-band { margin-top: 1.4mm; }
  .pm-mast--slim .pm-mast__t { margin-top: 0; font-size: 11.5pt; }
  .pm-mast--slim .pm-rule { display: none; }
  .pm-mast--slim .pm-mast__names { line-height: 1.2; }
  .pm-mast--slim .pm-mast__s { line-height: 1.25; }
  .pm-mast--slim + .pm-band { margin-top: 1mm; }

  /* The purpose band of a letterhead paper, under the band: a deep rule over it, a hair rule under. */
  .pm-band + .lh__purpose { margin-top: 2.4mm; }
  .pm-band ~ .lh__purpose {
    padding: 1.3mm 0;
    border-top: .7pt solid ${HOUSE_COLORS.deep}; border-bottom: .4pt solid ${HOUSE_COLORS.hair};
  }

  /* ---------- the section voice: a heading with a hairline running to the column edge ---------- */
  .pm-shead { display: flex; align-items: center; gap: 3mm; }
  .pm-shead::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${HOUSE_COLORS.hair}; }
`;

/**
 * The premium voice for the `doc-*` vocabulary the premium papers share — written once here so their
 * renderers cannot drift apart. The contract and its renewal papers draw the same vocabulary but keep
 * the corporate dress (the owner, 2026-10-12), so they never load this.
 *
 * It restyles what those papers already draw: a section heading gains the hairline to the column
 * edge, a table gains the 0.7 pt deep rule over its top and hair rules inside, the binding line
 * becomes a callout with a blue rule down its leading edge. Rules, weights and inks only — no paper
 * gains or loses a word, a field or a cell, and the 6% zebra stays exactly where it was.
 *
 * A rule for a class a paper does not use is simply idle there.
 */
export const PREMIUM_DOCUMENT_CSS = `
  .doc-purpose {
    margin: 2.4mm 0 2.6mm; padding: 1.3mm 0;
    border-top: .7pt solid ${HOUSE_COLORS.deep}; border-bottom: .4pt solid ${HOUSE_COLORS.hair};
  }
  .doc-head {
    display: flex; align-items: center; gap: 3mm;
    padding-bottom: 0; border-bottom: 0;
  }
  .doc-head::after { content: ""; flex: 1 1 auto; border-top: .5pt solid ${HOUSE_COLORS.hair}; }
  .doc-binding {
    padding: 1.2mm 0; padding-inline-start: 3mm;
    border: 0; border-inline-start: 1.2pt solid ${HOUSE_COLORS.blue};
    text-align: start;
  }
  .doc-ident, .doc-list, .doc-sig { border-top: .7pt solid ${HOUSE_COLORS.deep}; }
  .doc-ident th, .doc-ident td, .doc-list th, .doc-list td, .doc-sig th, .doc-sig td { border-color: ${HOUSE_COLORS.hair}; }
  .doc-witness__cell, .doc-witness__cell:nth-child(-n + 2) { border-color: ${HOUSE_COLORS.hair}; }
  .doc-open__line { border-bottom-color: ${HOUSE_COLORS.hair}; }
  .doc-operative { border-top: .7pt solid ${HOUSE_COLORS.deep}; }
  .doc-art { border-top-color: ${HOUSE_COLORS.hair}; }
  .doc-art__title { color: ${HOUSE_COLORS.blue}; }
  .doc-foot { border-top: .5pt solid ${HOUSE_COLORS.hair}; font-size: 7.5pt; }
  .doc-foot__row { color: ${HOUSE_COLORS.muted}; }
`;

/**
 * Everything a `doc-*` paper appends to its own stylesheet to wear the premium identity: the sheet
 * geometry for its copies, the chrome and masthead, and the document voice above.
 */
export function premiumDocumentStylesheet(sheet: string, orientation: PremiumOrientation = "portrait"): string {
  return `${premiumSheetCss(sheet, orientation)}\n${PREMIUM_IDENTITY_CSS}\n${PREMIUM_DOCUMENT_CSS}`;
}
