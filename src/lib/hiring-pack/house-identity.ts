// The house document identity — SATO-DIS-2026-01 v1.0, approved by the owner 2026-09-05.
//
// Every document Sato Pharma issues wears this: the hiring pack, the leavers pack, offer letters,
// and any letter or certificate written on company paper. The approved specimen is
// `xlsx/Sato-Pharma-Document-Identity-Standard.pdf`.
//
// WHY THIS MODULE EXISTS. Four renderers — the contract, both clearances, both custody receipts and
// the worker data form — each carried their own private copy of a navy masthead. They had already
// drifted apart (16 pt here, 15 pt there; a 30 mm mark in one file and 32 mm in another), and the
// job-offer letters were on a different blue entirely. A house identity that lives in five places is
// not a house identity; it is five identities that happen to agree today.
//
// 🔒 THE INK RULE IS LIFTED — owner, 2026-09-08: "now make the documents premium polish too", taken
// after being shown what it costs. It stood from 2026-09-05 and its reasoning was real and measured:
// these print in volume on office machines — a contract in three copies, a clearance in two, a
// custody receipt for every device issued — and carrying the identity in LINES AND TYPE alone took
// page coverage from 9.97% to 3.18%, roughly a 69% toner saving for exactly the same information.
//
// He was shown that figure and chose the ink. So filled areas are allowed again, and the identity is
// carried by BAND AND TYPE: a deep band across the letterhead, a tinted title panel, a filled
// purpose band, and the 6% zebra rows that were always permitted. Expect page coverage back around
// 10%. A session that finds the 3.18% figure in git history or an old doc is reading a SUPERSEDED
// rule — the measurement is still true, it is simply no longer the instruction.
//
// 🔴 GOVERNMENT FORMS REMAIN EXEMPT, AND THAT IS NOT A STYLE PREFERENCE — see the note below. It is
// the one part of this file the premium ruling does not reach, because the cost of getting it wrong
// is a filing the insurance office refuses, not an ugly page.
//
// GOVERNMENT FORMS ARE EXEMPT, PERMANENTLY. Social-insurance Form 1, Form 6 and the labour exit form
// are facsimiles of what the Authority itself issues; they print exactly as the Authority lays them
// out. Do not import this module into `render-form1.ts`, `render-form6.ts` or `render-labour-exit.ts`
// — restyling one of those makes it a form the insurance office can refuse.

import { escapeHtml } from "@/lib/hiring-pack/render-shared";

/**
 * The palette, sampled pixel-by-pixel from the company mark rather than chosen.
 *
 * The three blues are the three strokes of the wave and the ink is the SATO wordmark, so a document
 * drawn in these cannot drift away from the logo sitting above it. THE NAVY #0B2A4A THESE DOCUMENTS
 * USED BEFORE APPEARS NOWHERE IN THE LOGO — it came from the old Word originals, and replacing it is
 * the single reason the letterhead and the mark now read as one family.
 *
 * Sampling, if these ever need re-deriving: `sharp(logo).raw()`, count opaque pixels by RGB, and the
 * three dominant non-black values are Deep, Blue and Light in ascending lightness.
 */
export const HOUSE_COLORS = {
  /** The SATO wordmark. Body text on legal instruments, and every signature rule. */
  ink: "#000000",
  /** The wave's darkest stroke. Titles, headings, table headers. */
  deep: "#0A527D",
  /** The PHARMA wordmark itself. The brand rule and section rules. */
  blue: "#0A6BA6",
  /** The wave's lightest stroke. Callout edges. */
  light: "#1482C2",
  /** Brand Blue at 6% on white — zebra rows, and the tinted title panel. */
  tint: "#F2F6FA",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
} as const;

/**
 * The mark, as a path under `public/`.
 *
 * TWO FILES, AND THE BAND DECIDES WHICH. The stock mark sets "SATO" in WHITE for use on dark
 * grounds; the on-light file is the one that survives on white paper. Until 2026-09-08 the house
 * format had no dark grounds at all, so the on-light file was the only correct answer and picking
 * the stock one printed a letterhead reading "PHARMA" — which reached printed output once.
 *
 * The premium letterhead restored that dark ground, so the WHITE-wordmark file is now the right one
 * THERE and only there: `HOUSE_MARK_SRC` stays the on-light file for every other placement, and
 * `HOUSE_MARK_ON_DARK_SRC` is what the band uses. Putting the on-light mark on the deep band would
 * reproduce the same failure in reverse — a dark wordmark on a dark field.
 *
 * VECTOR, since 2026-09-05. The raster is 401 x 158 px — exactly 300 dpi at the 34 mm below, with no
 * headroom — so on the 600 dpi machines these papers are printed on it was being upsampled on every
 * document, and it could not be enlarged for a certificate at all. The company has no vector master;
 * this was traced from that raster and is bounded by what it knows, so it is not a substitute for
 * the designer's original if that ever turns up. At 34 mm the two are indistinguishable, and above
 * it the vector is the only one that holds.
 */
export const HOUSE_MARK_SRC = "/brand/sato-pharma-logo-on-light.svg";

/** The stock mark, whose "SATO" is WHITE. Correct ONLY on the deep letterhead band. */
export const HOUSE_MARK_ON_DARK_SRC = "/brand/sato-pharma-logo.svg";

/**
 * The letterhead band, as an INLINE style rather than a class alone.
 *
 * 🔴 THE MARK AND ITS GROUND MUST NOT BE SEPARABLE. `houseLetterhead()` emits the markup, but not
 * every consumer ships this module's stylesheet — `buildPayslipSheet` writes its own CSS and reuses
 * only the markup, so it renders `.lh` with no rule behind the class at all. When the band lived
 * solely in the stylesheet, that payslip took the WHITE-wordmark mark with no dark ground under it
 * and printed a letterhead reading "PHARMA" — the exact failure the on-light file exists to prevent,
 * reintroduced by the premium pass on 2026-09-08 and caught by `tests/payslip-document.test.ts`
 * before it shipped.
 *
 * Inlining it makes the pairing structural: any consumer that emits the markup gets the ground,
 * whatever CSS it does or does not load. The class stays for padding and layout.
 */
export const HOUSE_LETTERHEAD_BAND_STYLE =
  `background:linear-gradient(100deg,${HOUSE_COLORS.deep} 0%,${HOUSE_COLORS.blue} 62%,${HOUSE_COLORS.deep} 100%);`
  + "padding:4.5mm 6mm 4mm;";

/** Standard width of the mark on a letterhead. Below 24 mm the PHARMA counters fill in. */
export const HOUSE_MARK_WIDTH_MM = 34;

/**
 * The house typeface — WORKBOOKS ONLY, and the "only" is the whole point of this note.
 *
 * WHY IT IS RECORDED HERE. Eighteen export modules named "Aptos" in string literals before this
 * constant existed, and the standard named no typeface at all — it specifies sizes, weights and
 * colours and stops. That made the face an assumption inherited from whoever wrote the first
 * workbook rather than a decision anyone had taken, and an assumption that load-bearing belongs
 * where the rest of the identity lives. `house-xlsx-palette.ts` derives from this the same way it
 * derives every colour from `HOUSE_COLORS`, so there is one name and not nineteen.
 *
 * WHY IT IS NOT IN `HOUSE_IDENTITY_CSS` BELOW, which is the part that would look obvious.
 *
 * That stylesheet renders the employment contract, the clearance, the custody receipts, the renewal
 * and the worker-data form — every one of them BILINGUAL, and each already sets `ARABIC_FONT_STACK`
 * (Tahoma first, through Noto Naskh, ending at sans-serif) because Arabic is what decides a face
 * there. Aptos is a Latin family. Declaring it on the shared sheet would either be overridden by
 * that stack, which makes it decoration, or beat it, which puts Arabic legal paperwork on a font
 * chosen for a spreadsheet. Neither is worth having, and `paper-pdf.ts` records what happens when a
 * quoted font stack is interpolated somewhere it was not designed for: it closed a style attribute
 * and deleted a page footer.
 *
 * The government forms are untouched either way — Form 1 renders as an Authority overlay through
 * `field-layout.ts` and never reads this file. That is checked, not assumed.
 *
 * WHERE IT COMES FROM. Aptos ships with Microsoft 365, which is what the field runs, and is the
 * default face of current Excel — so a workbook that names it renders as written rather than as
 * substituted. On a machine without it Excel falls back silently, which is the one failure this
 * constant cannot prevent and the reason the choice is worth writing down rather than repeating.
 */
export const HOUSE_TYPE = {
  /** Body, headers, totals — everything that is read rather than announced. */
  body: "Aptos",
  /** Titles and mastheads only. The display cut, for type above about 14pt. */
  display: "Aptos Display",
  /**
   * Monospace, for a value the reader is meant to match CHARACTER BY CHARACTER against something
   * else — the literal strings the upload checks for, a code, an id. Proportional type invites the
   * eye to read those as words, which is the one thing they are not.
   *
   * Consolas rather than a house choice, because it ships with Windows itself rather than with
   * Office: the face is present even where Microsoft 365 is not, which is the opposite of the risk
   * `body` carries.
   */
  mono: "Consolas",
} as const;

/**
 * The house stylesheet: the letterhead, the type scale, tables, callouts and the signature block.
 *
 * Written as CSS custom properties so a document's own stylesheet can reach the palette by name
 * (`var(--phx-doc-deep)`) instead of repeating a hex it will later fail to update. The prefix keeps
 * these clear of the app's `--phx-*` design tokens, which are a different system for a different
 * medium — screen, where filled area costs nothing.
 *
 * LOGICAL PROPERTIES THROUGHOUT (`border-inline-start`, not `border-left`). These documents are
 * Arabic and lay out right-to-left; a physical `left` puts every callout rule and every heading tick
 * on the wrong side of the page, which reads as a broken template rather than a mirrored one.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 `print-color-adjust: exact` IS WHY THE COLOUR REACHES PAPER, and without it the identity is
 * lost on the printer and ONLY on the printer.
 *
 * Chrome's print dialog ships with "Background graphics" unticked, and every coloured area on these
 * documents is a CSS background — the 6% zebra bands, and `.lh__rule`, which this file calls the one
 * element on every document. So the owner pressed Print on 2026-09-06 and got a page in black and
 * white while the preview beside it was blue.
 *
 * IT HID BEHIND BOTH OF THE PLACES ANYBODY LOOKS. The screen was right, and the saved PDF was right
 * too, because `paper-pdf.ts` passes `printBackground: true`. The two paths a developer checks both
 * looked correct and only the printer disagreed. `render-contract.ts` and `render-worker-form.ts`
 * already carried their own copy of the declaration; the papers that did not are exactly the ones
 * that lost their colour.
 *
 * The property INHERITS, so declaring it on the root reaches everything, and it belongs here rather
 * than in each document because this module owns the colours in the first place.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 TWO REASONS THE PROSE LIVES HERE AND NOT INSIDE THE TEMPLATE LITERAL BELOW, both learned the
 * hard way while writing that fix:
 *
 *   · A BACKTICK IN A CSS COMMENT CLOSES THE STRING and takes the rest of the stylesheet with it.
 *     Up here, `code quotes` are free.
 *   · A COMMENT INSIDE THE CSS IS SHIPPED TO THE BROWSER and is scanned as CSS. The sentence "is a
 *     CSS background: the 6% zebra bands" turned `tests/payslip-document.test.ts` red, because its
 *     ink-rule sweep matches `background:` up to the next semicolon and read the prose as a third
 *     painted colour. Explanation belongs in TypeScript; the stylesheet carries a pointer to it.
 */
export const HOUSE_IDENTITY_CSS = `
  :root {
    --phx-doc-ink:   ${HOUSE_COLORS.ink};
    --phx-doc-deep:  ${HOUSE_COLORS.deep};
    --phx-doc-blue:  ${HOUSE_COLORS.blue};
    --phx-doc-light: ${HOUSE_COLORS.light};
    --phx-doc-tint:  ${HOUSE_COLORS.tint};
    --phx-doc-hair:  ${HOUSE_COLORS.hair};
    --phx-doc-muted: ${HOUSE_COLORS.muted};
    --phx-doc-body:  ${HOUSE_COLORS.body};
  }

  /* Keep the house colour when a BROWSER prints — see the note above the constant. */
  :root, html, body {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* ---------- the letterhead — filled again, 2026-09-08 ---------- */
  /* THE ROW IS PINNED LEFT-TO-RIGHT, and the direction is the whole point. These documents lay out
     right-to-left, so a direction-following row puts the mark on the RIGHT — which is not what the
     approved sheet shows, and not where the contract has always carried it. The mark belongs
     physically LEFT on every document, Arabic or English, so the two never disagree. The text inside
     each half keeps its own direction; only the order of the two halves is fixed here. */
  .lh {
    display: flex; direction: ltr;
    align-items: flex-end; justify-content: space-between; gap: 8mm;
    /* THE BAND. Deep on the outer edges through Brand Blue in the middle, so the sheet reads as one
       object rather than as a strip laid on top of it. Padded in millimetres because these are
       physical pages: the mark keeps its 34 mm and gains air around it rather than growing. */
    background: linear-gradient(100deg, var(--phx-doc-deep) 0%, var(--phx-doc-blue) 62%, var(--phx-doc-deep) 100%);
    padding: 4.5mm 6mm 4mm;
  }
  .lh__mark img { display: block; width: ${HOUSE_MARK_WIDTH_MM}mm; height: auto; }
  /* On the band every value inverts. The muted grey that reads as secondary on white is illegible
     on deep blue, so the secondary line is white at 78% rather than a different hue. */
  .lh__id { text-align: right; color: rgba(255,255,255,.78); font-size: 6.5pt; line-height: 1.5; }
  .lh__id strong { display: block; color: #FFFFFF; font-size: 8pt; font-weight: 700; }

  /* Now the seat of the band rather than a substitute for it: a light rule directly under the deep
     block, which stops the band floating and gives the eye somewhere to land. No top margin — it
     must touch the band, or the two read as separate objects. */
  .lh__rule { height: .7mm; background: var(--phx-doc-light); margin-top: 0; }

  /* The title sits in its own tinted panel, edged in Brand Blue on the side the page starts from. */
  .lh__title {
    text-align: center; padding: 3.3mm 3mm 2.6mm;
    background: var(--phx-doc-tint);
    border-bottom: .4pt solid var(--phx-doc-hair);
  }
  .lh__title h1 { margin: 0; color: var(--phx-doc-deep); font-size: 17pt; font-weight: 700; line-height: 1.2; }
  .lh__title p { margin: 1.2mm 0 0; color: var(--phx-doc-muted); font-size: 8pt; font-weight: 600; }

  /* The Arabic name of an ENGLISH-facing paper, sitting under its English title. Brand Blue and a
     size between the two, so it reads as the same title said again rather than as a subtitle. */
  .lh__title .lh__ar {
    margin-top: .8mm; color: var(--phx-doc-blue); font-size: 11pt; font-weight: 600; line-height: 1.3;
  }
  .lh__hair { border-top: .5pt solid var(--phx-doc-hair); }

  /* Who keeps this copy. FILLED since 2026-09-08 — it is the one line that stops the employee's copy
     and the company's copy being confused, so it is the line that most deserves the ink. Deep on
     white type: at 8.5pt bold this is the highest-contrast element on the page after the band. */
  .lh__purpose {
    margin: 0; padding: 1.7mm 0;
    background: var(--phx-doc-deep);
    color: #FFFFFF !important;
    border-top: none;
    border-bottom: none;
    color: var(--phx-doc-deep); font-size: 8.5pt; font-weight: 700; text-align: center;
  }
  /* The band holds two lines when the paper states its purpose in both scripts. */
  .lh__purpose p { margin: 0; }

  /* ---------- the invisible half: costs no ink, only care ---------- */
  p, li { orphans: 3; widows: 3; }
  .lh__title, .lh__purpose { break-after: avoid; page-break-after: avoid; }
`;

/**
 * Hairlines never thinner than 0.5 pt.
 *
 * Below that a rule is thinner than a 600 dpi printer can resolve, so it drops out on some machines
 * and survives on others — which reads as a defective document rather than a thin line.
 */
export const HOUSE_HAIRLINE_PT = 0.5;

/**
 * The papers Phoenix writes, and which may therefore carry the house page number.
 *
 * A SET OF THE ONES THAT DO, never a list of the ones that do not. A document added later is then
 * excluded until somebody decides otherwise, instead of inheriting a footer from a blocklist nobody
 * remembered to update — and an altered official form is discovered at the insurance window, not
 * here. Form 1, Form 6, the resignation request and the mutual termination agreement are the
 * Authority's own artwork on `@page { margin: 0 }`: there is no margin for a footer to sit in, and
 * printing our numbering onto one is the alteration that gets it refused.
 */
const HOUSE_NUMBERED_DOCUMENTS: ReadonlySet<string> = new Set([
  "contract",
  "workerDataForm",
  "custodyLaptop",
  "custodyMobile",
  "contractRenewal",
  "contractNonRenewal",
  "nda",
  "appointmentDocsReceipt",
  "socialStatusSheet",
  "absenceWarning",
  "deemedResignation",
  "appointmentDocsReturn",
  "experienceCertificate",
  "experienceCertificateEn",
  "clearanceEmployee",
  "clearanceCompany",
]);

/**
 * Whether this paper may carry "صفحة N من M".
 *
 * Takes a plain string so an uploaded company template — which arrives as `custom:<uuid>` — answers
 * false without this module needing to know that shape. Somebody's own artwork is theirs.
 */
export function documentCarriesHousePageNumbers(document: string): boolean {
  return HOUSE_NUMBERED_DOCUMENTS.has(document);
}

export interface HouseLetterheadInput {
  /** The document's own title, in Arabic. Printed 17 pt bold in Brand Deep. */
  titleAr: string;
  /** The line under it — the law it is written against, or what the paper is for. */
  subtitleAr?: string | null;
  /**
   * Who keeps this copy. Optional: a letter has no such line, a two-copy instrument always does.
   */
  purposeAr?: string | null;
  /** The company as a legal person — its registered name. */
  legalNameAr: string;
  /** The same name in Latin script, under it. Omitted on forms that are Arabic-only. */
  legalNameEn?: string | null;

  // ── THE ENGLISH-FACING MODE, added 2026-09-05 for the payslip ────────────────────────────────
  //
  // Not every company paper is an Arabic legal instrument. A payslip answers one question — what am
  // I paid this month — and every field on it (Base Salary, Total Deductions, First Part) is already
  // named in English by the payroll sheet the figures come from. Leading in Arabic would mean
  // translating a vocabulary the owner reads in English in both the app and the workbook.
  //
  // So such a paper leads in English and carries its Arabic name under it. TWO LINES, NEVER ONE
  // MIXED LINE: direction resolves per line, and a single run holding both scripts renders the
  // English half backwards — the mirror of the bug a block-level `dir="auto"` causes.
  //
  // PURELY ADDITIVE. With none of these set this function emits byte-for-byte what it emitted
  // before, which is what keeps the contract, both clearances and the worker data form out of this
  // change. `tests/payslip-document.test.ts` pins that byte-identity rather than trusting it.

  /** The English title. When present it becomes the h1 and `titleAr` moves under it. */
  titleEn?: string | null;
  /** The English line under the title — what the paper is, or the period it covers. */
  subtitleEn?: string | null;
  /** Who keeps this copy, in English. Shares the band with `purposeAr` when both are given. */
  purposeEn?: string | null;
}

/**
 * The letterhead every document opens with.
 *
 * Deliberately does NOT carry the commercial-register recital. Each instrument states the company's
 * registration in its own words and its own order — the contract's recital is part of the contract's
 * text and is quoted back in disputes — so folding it in here would put this layout's punctuation
 * inside language that belongs to the document. The mark and the name are the identity; the registry
 * detail stays where the document's author put it.
 */
export function houseLetterhead(input: HouseLetterheadInput): string {
  // Each line carries its OWN direction, and the Arabic line is left exactly as it always was — no
  // `dir` attribute — so an Arabic-only caller's bytes do not move. The English line states `ltr`
  // because on an Arabic paragraph a trailing "." or a leading "£" would otherwise be painted at
  // the wrong end of the run.
  const subtitle = [
    input.subtitleAr?.trim() ? `<p>${escapeHtml(input.subtitleAr.trim())}</p>` : "",
    input.subtitleEn?.trim() ? `<p dir="ltr">${escapeHtml(input.subtitleEn.trim())}</p>` : "",
  ].join("");

  // PINNED LEFT-TO-RIGHT, and this is not decoration. These documents lay out right-to-left, and
  // the full stop that ends "Sato Pharma L.L.C." is a NEUTRAL character: with nothing to hold it,
  // the bidirectional algorithm resolves it to the paragraph direction and paints it at the LEFT
  // end of the run, so the letterhead reads ".Sato Pharma L.L.C" — measured in a browser, on this
  // very letterhead, before this line existed. `dir="ltr"` on the element that holds only Latin is
  // the fix; never `dir="auto"` on the block, which reads the first strong character and would turn
  // the Arabic name above it around instead.
  const nameEn = input.legalNameEn?.trim()
    ? `<span dir="ltr">${escapeHtml(input.legalNameEn.trim())}</span>`
    : "";

  const purposeAr = input.purposeAr?.trim() ?? "";
  const purposeEn = input.purposeEn?.trim() ?? "";
  // Three shapes, and the Arabic-only one is deliberately the ORIGINAL string rather than a special
  // case of the general form. Every existing caller passes Arabic only, and reusing their exact
  // markup is what makes "additive" a fact instead of an intention.
  let purpose = "";
  if (purposeAr && !purposeEn) {
    purpose = `<p class="lh__purpose">${escapeHtml(purposeAr)}</p>`;
  } else if (purposeEn && !purposeAr) {
    purpose = `<p class="lh__purpose" dir="ltr">${escapeHtml(purposeEn)}</p>`;
  } else if (purposeAr && purposeEn) {
    purpose = `<div class="lh__purpose"><p>${escapeHtml(purposeAr)}</p>`
      + `<p dir="ltr">${escapeHtml(purposeEn)}</p></div>`;
  }

  // The English title takes the h1 and the Arabic moves under it. Otherwise the Arabic keeps the h1
  // and emits precisely what it always did.
  const titleEn = input.titleEn?.trim() ?? "";
  const title = titleEn
    ? `<h1 dir="ltr">${escapeHtml(titleEn)}</h1>`
      + `<p class="lh__ar" dir="rtl" lang="ar">${escapeHtml(input.titleAr)}</p>`
    : `<h1>${escapeHtml(input.titleAr)}</h1>`;

  return `<header class="lh" style="${HOUSE_LETTERHEAD_BAND_STYLE}">
      <div class="lh__mark"><img src="${HOUSE_MARK_ON_DARK_SRC}" alt="" width="401" height="158"></div>
      <div class="lh__id" style="color:rgba(255,255,255,.78)"><strong style="color:#FFFFFF">${escapeHtml(input.legalNameAr)}</strong>${nameEn}</div>
    </header>
    <div class="lh__rule"></div>
    <div class="lh__title">
      ${title}
      ${subtitle}
    </div>
    <div class="lh__hair"></div>
    ${purpose}`;
}
