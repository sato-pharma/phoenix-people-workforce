// Spotlight — the sheet.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2026-09-12 — THE CERTIFICATE IS THE REFERENCE. The owner sent the Future Talents certificate
// (`ftp2026-certificate-aya-mohamed-elsawy.pdf`) and asked for this sheet to be built off it. What
// was taken, device by device, and why each one is doing work here:
//
//   · THE CREST BAND. A dark band across the head of every sheet with the mark reversed out of it,
//     large, and a brand rule under it. It is the first thing on the page, which on a document the
//     company is putting its name to is what the issuer should be. It also gives the sheet a top
//     edge — the old masthead floated in white and the page began nowhere.
//
//   · THE NAME ON A RULE. The subject's name set large in near-black over a rule that runs under it.
//     That rule is the whole certificate device: it is what separates a name that has been AWARDED
//     something from a name in a list.
//
//   · A SENTENCE ASSEMBLED FROM COUNTS. "Ranked first of 111 …, for June · July · August 2026."
//     Every clause restates a figure held elsewhere on the sheet. Nothing here is an opinion about
//     anybody, and no number appears that the query did not return.
//
//   · THE STAT BAND, CLOSED. Three figures on a tint, between a heavy rule above and below. On the
//     reference this is what stops the page from drifting; here it does the same job under the
//     ranking and under the figure.
//
//   · BRACKET CORNERS instead of the guilloche bosses, and the braided bands are gone. The engine
//     turning was the old identity's answer to "make it look premium" and it read as fussy at print
//     size next to a name. The corners are four right angles and nothing else.
//
//   · THE ARABIC MARK, IN THE FOOT, WHERE THE SOURCE LINE USED TO BE. Sato Pharma's name in
//     Arabic calligraphy, set in the bottom-left corner as the third member of the record foot,
//     beside the sheet number and the document identity. The owner put it there on 2026-09-12 --
//     "you will put in the left corner the logo ... the Arabic one" -- and struck the Source block
//     in the same breath as irrelevant. Four earlier placements came out, and each is worth keeping:
//
//     🔴 NOT A CENTRED WASH BEHIND THE FIGURE. On a sheet whose payload is one enormous
//     number, a second large thing in the same space reads as a printing fault, not a watermark.
//
//     🔴 AND NOT BLED OFF THE RIGHT EDGE, however exactly that copies the certificate the
//     owner handed over. ARABIC READS RIGHT TO LEFT, so the paper ate the FIRST half of the name and
//     left the second standing alone -- the company name gone from the company's own document, with
//     no error anywhere. His words: "no you croped sato the company name".
//
//     🔴 AND NOT LOW AND CENTRED UNDER THE GAUGE, which spread it behind the gauge and its
//     labels: a third thing in the reading path rather than a decoration beside it.
//
//     🔴 AND NOT A PALE WATERMARK OVER THE LEFT SHOULDER OF THE FIGURE. Every one of these
//     is the same mistake -- putting the mark where the page is already saying something.
//
//     In the foot it is not a watermark at all. It is the issuer signing the bottom of the page, at
//     full ink, in the corner a reader reaches last, on EVERY sheet including the ranking: a corner
//     logo does not make a table of names harder to read, which a wash behind one did.
//
//     🔴 IT IS SIZED BY HEIGHT, AND THAT HEIGHT MAY NOT GROW THE FOOT. ROW_AREA_FIRST and
//     ROW_AREA_LATER are MEASURED constants that already pay for a footer of the old height, and an
//     overrun does not error -- it pushes the foot off the bottom of the paper and slices the last
//     row in half. The Source block it replaced stood 17mm; this one is capped below that.
//
//   · AND, SINCE 2026-10-12, A 5% WATERMARK AS WELL. The owner ruled that the Arabic logo belongs in
//     the watermark and the footer only, never a masthead ("watermark and footer only"), and for this
//     sheet chose to keep the foot mark AND add the watermark. It sits LOW ON THE RIGHT, inside the
//     content column, above the foot: contained, so the whole name shows (never bled off the right
//     edge), at 5%, and in the same corner the HR papers carry it. It is one more reference to the
//     same data URI, so it adds no image object. The rep's own sheet keeps its centred watermark
//     instead of a second one (`repSpotlightDocumentHtml`).
//
// 🔴 THIS TAKES THE SHEET OUT OF THE HOUSE INK RULE, DELIBERATELY. SATO-DIS-2026-01 allows no filled
// areas except the 6% zebra row, and the crest band, the plinth and the stat band are all fills. The
// reference the owner handed over is built on them; the premium closing already holds the same
// exemption. Everything else about the house identity is unchanged — the logo palette, square edges
// everywhere, the on-light mark wherever the ground is white, the 0.5 pt hairline floor, the
// document identity on every sheet, and no truncation anywhere.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MUST NOT REGRESS, whatever the sheet looks like next:
//
//   1. THE RANKING PAGINATES. `.sheet` clips at A4 and the limit reaches into the hundreds, so an
//      unpaginated table printed 18 of 40 names, no footer, and a row sliced through the middle,
//      with no error anywhere. Rows are packed by measured height and balanced across the sheets
//      they need, and the footer numbers them.
//
//   2. NOTHING RASTERISES. Chromium turns a CSS gradient or a repeating background into its own
//      page-sized layer when printing — measured at 6.88 MB for a 6-page sheet whose text is a few
//      kilobytes. Ornament is inline SVG polylines, fills are flat colours, and the mark is one
//      base64 data URI referenced by every page.
//
//   3. COLOUR MEANS SOMETHING. Green is at-or-above target, red is below, and nothing else on the
//      page may be either colour. A tint washed across every over-target row is what took that
//      meaning away once already: the fill is the zebra, the key is a rule on the rank cell.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeHtml } from "@/lib/hiring-pack/render-shared";
import { withChromiumPage } from "@/lib/pdf/chromium";

import type { SpotlightResult, SpotlightRow } from "./types";

// ── Palette ───────────────────────────────────────────────────────────────────────────────────
const C = {
  deep: "#0A527D",
  blue: "#0A6BA6",
  light: "#1482C2",
  tint: "#F3F7FA",
  hair: "#B9C7D4",
  muted: "#5A6B7C",
  body: "#1A1A1A",
  green: "#0F7A47",
  red: "#B4231C",
  // The crest band and the plinth. Near-black rather than the logo's deepest blue: on the reference
  // the band is a ground for the mark, and a blue ground under a blue mark flattens it.
  crest: "#0E1720",
  // The name, and anything else that has to out-weigh the blue. Blue everywhere is what made the
  // old sheet read as a template with the fields filled in.
  ink: "#111820",
  // A tint that survives being laid under 9 pt text on an office printer.
  wash: "#EEF3F7",
} as const;

const HAIR = "0.5pt";

// ── The mark ──────────────────────────────────────────────────────────────────────────────────
// Read once and inlined. `setContent` gives Chromium no base URL, so an `<img src="/brand/…">`
// would silently render nothing — the failure mode is a letterhead with a hole in it, which no
// error reports.
//
// 🔴 WHICH FILE DEPENDS ON THE GROUND, AND GETTING IT WRONG PRINTS HALF A LOGO. The stock mark sets
// "SATO" in white for dark grounds; the on-light file sets it in black. The crest band is dark, so
// the band takes the stock file — and anywhere the ground is white it must be the on-light one, or
// the letterhead reads "PHARMA".
const markCache = new Map<string, string>();
function houseMark(onDark: boolean): string {
  const file = onDark ? "sato-pharma-logo.svg" : "sato-pharma-logo-on-light.svg";
  const cached = markCache.get(file);
  if (cached !== undefined) return cached;
  const svg = readFileSync(join(process.cwd(), "public", "brand", file), "utf8");
  // 🔴 AN <img> WITH A BASE64 DATA URI, NOT INLINE MARKUP. Inlining the SVG puts the mark's paths
  // into the PDF once PER PAGE: measured on a 6-page sheet at 6.88 MB, and 34.69 MB at 31 pages,
  // which is ~1.15 MB a page of nothing but a repeated logo. As an image resource Chromium embeds it
  // once and every page references the same object. Base64 rather than percent-encoding because the
  // encoded form is going inside an attribute, and a raw SVG's own quotes would end that attribute
  // early — the defect that has blanked bands and a footer in this repository.
  const html = `<img alt="" src="data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}">`;
  markCache.set(file, html);
  return html;
}

/**
 * The Arabic logotype, painted and flattened ahead of time.
 *
 * The file is a PNG whose only colour IS the house deep blue and whose whiteness was turned into
 * transparency when it was built, so the sheet sets no colour at all and the PDF gets one image
 * object. A CSS `filter` or a `mask-image` would have done the same tinting at render time and cost
 * a composited layer per page, which is the trap at the head of this file. Transparency rather than
 * white is what lets it sit over the foot's hairline without a box around it.
 *
 * 🔴 IT IS A HAND-EDITED FILE, NOT A BUILD OUTPUT. Four diamond dots sat under the baseline of
 * the calligraphy and the owner had them taken off on 2026-09-12 ("you will find 2 point under the
 * seen and another 2 under the alif remove them") -- 5,461 pixels, two connected components, nothing
 * else touched. The file it came from still has them, and the recipe that produced this one puts
 * every one of them straight back, silently. If this artwork is ever rebuilt, remove the dots again:
 * `tests/phoenix-official-logo.test.ts` reads the four spots in the pixels and goes red if they
 * return, which is the only thing standing between a regenerated asset and the dots coming with it.
 *
 * 🔴 AN <img>, FOR THE SAME REASON THE MARK IS ONE. At 16 KB it encodes to about 22 KB of base64 --
 * lighter than the logo already repeated on every page -- and Chromium embeds one copy of the
 * decoded image however many pages reference the same URI.
 */
const arabicCache = { html: "" };
export function arabicMark(): string {
  if (arabicCache.html === "") {
    const png = readFileSync(join(process.cwd(), "public", "brand", "sato-pharma-arabic-on-light.png"));
    arabicCache.html = `<img alt="" src="data:image/png;base64,${png.toString("base64")}">`;
  }
  return arabicCache.html;
}

// ── Ornament ──────────────────────────────────────────────────────────────────────────────────
/**
 * The bracket corner: two strokes meeting at a right angle, drawn as polylines.
 *
 * It replaces the guilloche boss. The rosette was three rose curves inside 11 mm, which is a lot of
 * craft to spend on something that prints as a smudge beside a 30 pt name — and the reference
 * answers the same corner with a bracket, which reads at any size and does not compete.
 *
 * 🔴 VECTOR, NOT A BACKGROUND IMAGE. Every ornament on this sheet is an inline polyline for the
 * raster reason at the head of this file. If this ever becomes a `background-image`, the PDF gains a
 * page-sized layer per page and nothing warns.
 */
const BRACKET_SVG = `<svg viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="0,40 0,0 40,0" fill="none" stroke="${C.ink}" stroke-width="3.2"/>
  <polyline points="7.5,40 7.5,7.5 40,7.5" fill="none" stroke="${C.light}" stroke-width="1"/>
</svg>`;

/** The short heavy rule that sits under an eyebrow. The reference's one piece of punctuation. */
const TICK = `<div class="tick"></div>`;

// ── Formatting ────────────────────────────────────────────────────────────────────────────────
const egp = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n));
const millions = (n: number) => (n / 1_000_000).toFixed(2);
const pct = (n: number | null) => (n === null ? "—" : n.toFixed(1));

/**
 * How wide the hero number is allowed to be drawn, from how many characters it has.
 *
 * Keyed on the FORMATTED string rather than on the number, because the format is what occupies the
 * page: pct() is a plain toFixed(1) with no thousands separator, so 141.1 is five characters and
 * 1412.5 is six.
 */
function pctSizeClass(shown: string): string {
  if (shown.length >= 7) return " figure__pct--vlong";
  if (shown.length === 6) return " figure__pct--long";
  return "";
}

/**
 * How wide a name SETS, in millimetres, at the name's full 29pt.
 *
 * 🔴 A CHARACTER COUNT CANNOT ANSWER THIS, and that is why the table exists. "Mohamed Mohamed
 * Mohamed" is 23 characters and sets 151.9mm -- over the measure. "Youssef Kamal El Sharkawy" is 25
 * and sets 133.5mm -- comfortably under. Any rule counting letters gets one of those two wrong, and
 * the one it gets wrong wraps a name that had no need to.
 *
 * The advances below were MEASURED off the real face, in this renderer, under print media: each
 * glyph repeated twenty-one times, minus one, over twenty, which sheds the side bearings and
 * returns the advance rather than the inked width. Summing them reproduces the rendered width of
 * twenty-one real Egyptian names to within 1.32%, and every error is an OVER-estimate -- so the
 * worst this can do is set a name one step smaller than it strictly had to, never run it off the
 * page. An unknown character is priced as the widest glyph in the face, for the same reason.
 *
 * 🔴 IT IS TIED TO --display AND TO .name's LETTER-SPACING. The numbers are Noto Serif at 29pt
 * with the -.004em tracking the sheet sets. Change either and they are quietly wrong -- nothing
 * errors, a name simply stops stepping down when it should. tests/spotlight-sheet-design.test.ts
 * pins the two names this table exists to tell apart.
 */
const NAME_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -'";
const NAME_ADVANCES_MM = [
  7.170, 6.649, 6.239, 7.396, 6.332, 5.994, 7.262, 8.070, 3.713, 3.611, 7.119, 6.332, 9.554,
  7.764, 7.549, 6.137, 7.549, 6.669, 5.523, 6.229, 7.293, 6.863, 10.669, 6.710, 6.352, 6.015,
  5.718, 6.239, 4.992, 6.239, 5.432, 3.734, 5.462, 6.454, 3.232, 3.028, 5.943, 3.130, 9.625,
  6.557, 5.861, 6.239, 6.239, 4.777, 4.572, 3.559, 6.454, 5.882, 8.776, 5.871, 5.738, 5.186,
  2.619, 3.130, 2.209,
];
const NAME_ADVANCE = new Map([...NAME_GLYPHS].map((ch, i) => [ch, NAME_ADVANCES_MM[i]]));
const NAME_WIDEST_MM = Math.max(...NAME_ADVANCES_MM);

/** The measure .name is set to. A name wider than this wraps; the point is to stop it wrapping. */
const NAME_MEASURE_MM = 150;

function nameWidthMm(name: string): number {
  let mm = 0;
  for (const ch of name) mm += NAME_ADVANCE.get(ch) ?? NAME_WIDEST_MM;
  return mm;
}

/**
 * One step down, so an ordinary long name stands on ONE line over its rule.
 *
 * That rule is the certificate device -- a name ON a rule rather than a name in a list -- and it
 * reads as one only while the name above it is one line. At 29pt "Mohamed Ahmed Abdel Rahman",
 * which is an unremarkable name here, broke as "Mohamed Ahmed Abdel / Rahman": a full line and an
 * orphan. At 25pt it sets 138.5mm and stands whole.
 *
 * There is exactly one step, deliberately. A name too long even for 25pt -- five parts and up -- is
 * going to wrap whatever size it is set at, and shrinking it further buys nothing but a smaller
 * name; it wraps at 25pt instead, balanced by the stylesheet into even lines. The owner's rule is
 * that nothing is ever shortened, so no path here abbreviates anything.
 */
function nameSizeClass(name: string): string {
  return nameWidthMm(name) > NAME_MEASURE_MM ? " name--long" : "";
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ORDINALS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
];

/** "first" … "tenth", and past that the figure — "18th", which is the honest way to write it. */
function ordinal(n: number): string {
  if (n >= 1 && n <= ORDINALS.length) return ORDINALS[n - 1];
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${n % 10 <= 3 ? suffix : "th"}`;
}

/**
 * The months a window actually covers, written out — "June · July · August 2026".
 *
 * "Q3 2026" is a label the reader has to decode, and the hero sheet is the one that goes to the
 * person it names. Purely a restatement of `result.periods`: no month is named that the numbers were
 * not taken from, and a window spanning two years prints both years rather than quietly assuming one.
 */
function monthsLabel(periods: string[]): string {
  if (periods.length === 0) return "";
  const parts = periods.map((period) => {
    const [year, month] = period.split("-");
    const index = Number(month) - 1;
    return { year, name: MONTH_NAMES[index] ?? period };
  });
  const oneYear = parts.every((part) => part.year === parts[0].year);
  if (oneYear) return `${parts.map((part) => part.name).join(" · ")} ${parts[0].year}`;
  return parts.map((part) => `${part.name} ${part.year}`).join(" · ");
}

/**
 * What the achievement is measured AGAINST, said in full.
 *
 * 🔴 A TARGET IN THIS COMPANY IS SET FOR A MONTH. The owner, 2026-09-12: "no its monthly target not
 * q3". The quarter is only the window this sheet happens to cover; the figure is the window's sales
 * over the SUM of that window's monthly targets, and it is summed, never averaged. The caption used
 * to read "of the Q3 2026 target", which names a quarterly target that does not exist anywhere in
 * the business — and on a sheet handed to the person it is about, that reads as the company having
 * measured them against something nobody ever set.
 *
 * 🔴 AND IT NAMES THE MONTHS THAT CARRIED ONE — `row.targetedPeriods`, NEVER `result.periods`. The
 * first wording of this caption replaced a wrong quarter with three wrong months: a rep targeted in
 * July alone, inside a Q3 window, read "of the monthly targets for June · July · August 2026" while
 * the stat band below said "1 of 3 months carried a target". Only months Mar–Jun 2026 on the three
 * tracked lines carry sales with no target at all, so this is the ordinary shape of the data, not an
 * edge case. A window with no target anywhere says so outright rather than naming a denominator the
 * figure above it does not have.
 *
 * One targeted month is the case where naming the month IS naming the target, so it keeps the
 * shorter sentence.
 */
function targetCaption(row: SpotlightRow): string {
  // Nothing. The gauge below prints the whole sentence for this case, and a caption above it
  // saying the same thing in fewer words is the sheet stating twice that it has nothing to state.
  if (row.targetValue === null || row.targetedPeriods.length === 0) return "";
  const months = monthsLabel(row.targetedPeriods);
  if (!months) return "of target";
  return row.targetedPeriods.length === 1
    ? `of the ${escapeHtml(months)} target`
    : `of the monthly targets for ${escapeHtml(months)}`;
}

/** "1 month" / "2 months" — said in words, because "2 mo." on a certificate is an abbreviation. */
function monthCount(n: number): string {
  return `${n} month${n === 1 ? "" : "s"}`;
}

/**
 * How many months of the window this subject was NOT targeted in.
 *
 * Counted against the WINDOW, because that is what the sheet's own heading claims to cover. It is
 * what separates "this figure is the whole story" from "this figure is part of it".
 */
function untargetedMonthsInWindow(result: SpotlightResult, row: SpotlightRow): number {
  return Math.max(0, result.periods.length - row.targetedMonths);
}

/**
 * The label under the achievement's numerator.
 *
 * Three cases, and the third is the one that used to lie: when an untargeted month sits in the
 * window the figure beside it is NOT everything the subject delivered, and the label has to say so
 * in the same breath — otherwise the sheet shows a smaller number than the person's own sales and
 * offers no reason for it.
 */
function targetedAgainstLabel(row: SpotlightRow): string {
  if (row.targetValue === null) return "Delivered — no target was set";
  const against = egp(row.targetValue);
  if (row.gradedValue === row.actualValue) {
    return row.targetedMonths === 1
      ? `Delivered against ${against} targeted`
      : `Delivered against ${against} in monthly targets`;
  }
  return row.targetedMonths === 1
    ? `Delivered in the month that carried a target, against ${against}`
    : `Delivered in the ${row.targetedMonths} months that carried a target, against ${against}`;
}

/** The gauge scale. 112 leaves an overshoot room to read AS an overshoot rather than as the end. */
const GAUGE_MAX = 112;

/**
 * A gauge for one achievement.
 *
 * Above 112% the bar is pinned full and the tick moves instead, so a 210% rep does not render a
 * bar eight times the width of the page. The number beside it is always the true one.
 */
function gauge(achievement: number | null, caption: string): string {
  if (achievement === null) {
    return `<div class="gauge"><p class="gauge__none">No target was set for this window, so there is no achievement to draw.</p></div>`;
  }
  const scale = Math.max(GAUGE_MAX, achievement * 1.06);
  const base = (Math.min(100, achievement) / scale) * 100;
  const over = achievement > 100 ? ((achievement - 100) / scale) * 100 : 0;
  const under = achievement < 100 ? ((100 - achievement) / scale) * 100 : 0;
  const tick = (100 / scale) * 100;

  return `<div class="gauge">
    ${caption ? `<p class="gauge__win ${achievement >= 100 ? "is-up" : "is-down"}"><i>${achievement >= 100 ? "&#9650;" : "&#9660;"}</i>${escapeHtml(caption)}</p>` : ""}
    <div class="gauge__track">
      <div class="gauge__base" style="width:${base.toFixed(3)}%"></div>
      ${over > 0 ? `<div class="gauge__over" style="left:${base.toFixed(3)}%;width:${over.toFixed(3)}%"></div>` : ""}
      ${under > 0 ? `<div class="gauge__under" style="left:${base.toFixed(3)}%;width:${under.toFixed(3)}%"></div>` : ""}
      <div class="gauge__tick" style="left:${tick.toFixed(3)}%"></div>
    </div>
    <div class="gauge__labels"><span class="gauge__t" style="left:${tick.toFixed(3)}%">Target 100%</span></div>
  </div>`;
}

// ── Chrome shared by every page ───────────────────────────────────────────────────────────────
/**
 * Every sheet is this: the crest band, the bracketed field, the body, the record foot, the plinth.
 *
 * THE SHEET NUMBER IS NOT DECORATION. These go out as a stapled pack — a ranking, then a hero sheet
 * per person — and until the numbering went in, nothing on a loose page said whether anything was
 * missing from it.
 */
function pageShell(
  result: SpotlightResult,
  body: string,
  page: number,
  total: number,
  options: SheetShellOptions = {},
): string {
  return sheetShell(`Sato Pharma &middot; Sales Performance Spotlight &middot; ${escapeHtml(result.windowLabel)}`, body, page, total, options);
}

export interface SheetShellOptions {
  /**
   * The Arabic mark as the sheet's 5% watermark (owner, 2026-10-12). On by default; off only for a
   * sheet whose body already carries its own watermark, so no page shows two.
   */
  watermark?: boolean;
}

/**
 * The sheet's frame with the plinth line given — shared with the Phoenix Ranks certificate
 * (src/lib/rep-ranks/certificate.ts), so a rep's two recognition sheets are one design and cannot
 * drift apart. `plinth` is already-escaped HTML.
 */
export function sheetShell(plinth: string, body: string, page: number, total: number, options: SheetShellOptions = {}): string {
  return `<div class="sheet${page === total ? "" : " sheet--break"}">
    <header class="crest">
      <div class="crest__mark">${houseMark(true)}</div>
    </header>
    <div class="crest__rule"></div>

    <div class="page">
      <div class="field"></div>
      <div class="bracket bracket--tl">${BRACKET_SVG}</div>
      <div class="bracket bracket--tr">${BRACKET_SVG}</div>
      <div class="bracket bracket--bl">${BRACKET_SVG}</div>
      <div class="bracket bracket--br">${BRACKET_SVG}</div>
      ${options.watermark === false ? "" : `<div class="arabic-wm">${arabicMark()}</div>`}

      <div class="inner">
        ${body}
        <footer class="foot">
          <div class="foot__block foot__block--mark">${arabicMark()}</div>
          <div class="foot__block foot__block--no">
            <p class="foot__cap">Sheet</p>
            <p class="foot__no">${page}<span> of ${total}</span></p>
          </div>
          <div class="foot__block foot__block--rec">
            <p class="foot__cap">Record</p>
            <p class="foot__line"><strong>SATO-DIS-2026-01 v1.0</strong></p>
          </div>
        </footer>
      </div>
    </div>

    <div class="plinth"><span>${plinth}</span></div>
  </div>`;
}

/** The eyebrow-over-a-rule that opens every sheet. */
export function opener(text: string): string {
  return `<p class="eyebrow">${escapeHtml(text)}</p>${TICK}`;
}

// ── The leaderboard ───────────────────────────────────────────────────────────────────────────
/**
 * The pagination, in millimetres rather than in rows.
 *
 * A fixed rows-per-page number is wrong the moment one name wraps: sixteen ordinary rows fit a
 * continuation page and sixteen long ones overrun it by 37 mm, which does not error — it pushes the
 * footer off the bottom of the paper and cuts the last row in half. So a page is filled by ADDING
 * UP what its rows actually cost, and closed when the next row would not fit.
 */
const MIN_PAD_MM = 1.35;
const MAX_PAD_MM = 4.2;

/**
 * Vertical measure, in mm, a page has for rows once its head, note and footer are paid for, and
 * what one row costs before any padding is added to it.
 *
 * MEASURED, not estimated — and re-measured after the crest band and plinth went in, which together
 * take about 34 mm off the page that the old masthead did not. An arithmetic guess put 18 rows on a
 * continuation page once and the sheet overran by 13 mm, which does not error: it pushes the footer
 * off the bottom of the paper. Both numbers are set BELOW what actually fits, so that a long name
 * wrapping to two lines still has somewhere to go.
 */
const ROW_AREA_FIRST = 119;
const ROW_AREA_LATER = 150;
const ROW_CONTENT_MM = 7.8;

/**
 * What one row costs before padding — its own height in millimetres.
 *
 * The name column is about 70 mm of usable measure at 9.2 pt and the territory column about 40 mm
 * at 8 pt, so the character counts below are where each wraps. They are estimates and they are
 * deliberately PESSIMISTIC (a shorter line than the font really fits), because over-estimating a
 * row costs a little white space and under-estimating it walks a name off the page.
 */
function rowHeightMm(row: SpotlightRow): number {
  const nameChars = row.title.length + (row.isVacant ? 12 : 0);
  const nameLines = Math.max(1, Math.ceil(nameChars / 40));
  const whereLines = Math.max(1, Math.ceil(row.territory.length / 25));
  return ROW_CONTENT_MM + (nameLines - 1) * 3.3 + (whereLines - 1) * 2.6;
}

/** How many of these rows fit on a page of this measure, at the tightest padding allowed. */
function fitCount(rows: SpotlightRow[], areaMm: number): number {
  let used = 0;
  let count = 0;
  for (const row of rows) {
    const cost = rowHeightMm(row) + MIN_PAD_MM * 2;
    if (count > 0 && used + cost > areaMm) break;
    count += 1;
    used += cost;
  }
  return count;
}

/**
 * Split the ranking into pages — and then BALANCE them.
 *
 * Filling each page to the brim leaves the last one holding whatever is left, which is how a
 * two-page ranking ends with a sheet carrying two names and 150 mm of white under them. So the page
 * COUNT is worked out by filling greedily, and the rows are then spread evenly over that many
 * pages: ten names over two sheets print five and five, not eight and two.
 */
function paginateRows(rows: SpotlightRow[], areaFirst: number, areaLater: number): SpotlightRow[][] {
  let rest = rows;
  let pages = 0;
  while (rest.length > 0) {
    rest = rest.slice(fitCount(rest, pages === 0 ? areaFirst : areaLater));
    pages += 1;
  }

  const chunks: SpotlightRow[][] = [];
  rest = rows;
  let pagesLeft = pages;
  while (rest.length > 0) {
    const area = chunks.length === 0 ? areaFirst : areaLater;
    const fits = fitCount(rest, area);
    const even = pagesLeft > 0 ? Math.ceil(rest.length / pagesLeft) : fits;
    const take = Math.max(1, Math.min(fits, even));
    chunks.push(rest.slice(0, take));
    rest = rest.slice(take);
    pagesLeft -= 1;
  }
  return chunks;
}

/**
 * Cell padding chosen so THIS page's rows fill THIS page.
 *
 * A ten-name sheet and a sixteen-name sheet are both ordinary, and one fixed row height serves
 * exactly one of them: the other either overflows or leaves 40 mm of white under the last name,
 * which is precisely what "the export looks weak" was. The clamp is the whole safety — never
 * tighter than legible, never so airy that a three-name list prints like a menu.
 */
function rowPaddingMm(rows: SpotlightRow[], areaMm: number): number {
  if (rows.length === 0) return 2.4;
  const content = rows.reduce((sum, row) => sum + rowHeightMm(row), 0);
  return Math.min(MAX_PAD_MM, Math.max(MIN_PAD_MM, (areaMm - content) / (rows.length * 2)));
}

/**
 * Whether this sheet prints sales and target money. The picker's "Show sales value" switch (owner,
 * 2026-11-04) turns it off for a sheet ranked by achievement alone; absent means shown, so every
 * sheet built before the switch existed, and the rep's own sheet, print exactly as they did.
 */
function valueShown(result: SpotlightResult): boolean {
  return result.selection.showValue !== false;
}

function leaderboardRows(rows: SpotlightRow[], offset: number, showValue: boolean): string {
  return rows.map((row, index) => {
    const rank = offset + index + 1;
    const beat = row.achievement !== null && row.achievement >= 100;
    const key = row.achievement === null ? "" : beat ? "beat" : "miss";
    const zebra = rank % 2 === 0 ? "zebra" : "";
    const arrow = row.achievement === null ? "" : beat ? "&#9650;" : "&#9660;";
    const tone = row.achievement === null ? "flat" : beat ? "up" : "down";
    return `<tr class="${[key, zebra].filter(Boolean).join(" ")}">
      <td class="lb-rank">${String(rank).padStart(2, "0")}</td>
      <td class="lb-name">${escapeHtml(row.title)}${row.isVacant ? '<span class="lb-vacant">vacant seat</span>' : ""}</td>
      <td class="lb-where">${escapeHtml(row.territory)}${row.lineName ? `<span class="lb-line">${escapeHtml(row.lineName)}</span>` : ""}</td>
      ${showValue ? `<td class="lb-value">${millions(row.actualValue)}<span class="lb-unit">M</span></td>` : ""}
      <td class="lb-ach ${tone}"><span class="lb-arrow">${arrow}</span>${pct(row.achievement)}${row.achievement === null ? "" : '<span class="lb-pc">%</span>'}</td>
    </tr>`;
  }).join("");
}

const LB_COLS = `<colgroup><col style="width:12mm"><col><col style="width:43mm"><col style="width:22mm"><col style="width:25mm"></colgroup>`;
const LB_HEAD = `<thead><tr>
  <th></th><th>Name</th><th>Territory</th><th class="r">Sales</th><th class="r">Achievement</th>
</tr></thead>`;
// The same table with the Sales column gone: its width goes to the territory, so a long one wraps less.
const LB_COLS_NO_VALUE = `<colgroup><col style="width:12mm"><col><col style="width:65mm"><col style="width:25mm"></colgroup>`;
const LB_HEAD_NO_VALUE = `<thead><tr>
  <th></th><th>Name</th><th>Territory</th><th class="r">Achievement</th>
</tr></thead>`;

/** The three figures on a tint, closed top and bottom — the reference's band, doing the same job. */
export function statBand(cells: { value: string; label: string; tone?: string }[]): string {
  return `<section class="stats">
    ${cells.map((cell) => `<div class="stat">
      <p class="stat__v ${cell.tone ?? ""}">${cell.value}</p>
      <p class="stat__l">${cell.label}</p>
    </div>`).join("")}
  </section>`;
}

function leaderboardPage(
  result: SpotlightResult,
  rows: SpotlightRow[],
  offset: number,
  part: number,
  parts: number,
  page: number,
  total: number,
): string {
  const first = part === 1;
  const last = part === parts;
  const pad = rowPaddingMm(rows, first ? ROW_AREA_FIRST : ROW_AREA_LATER);
  const totals = result.shortlistAchievement;
  const months = monthsLabel(result.periods);
  const showValue = valueShown(result);

  const head = first
    ? `${opener(`Spotlight · ${result.windowLabel}`)}
    <h1 class="title">${escapeHtml(result.headline)}</h1>
    <div class="ruleunder"></div>
    <p class="lede">${escapeHtml(result.subheadline)}${months ? `, over ${escapeHtml(months)}` : ""}.</p>
    ${statBand([
      showValue
        ? {
            value: `${egp(result.shortlistActualValue)}<small> EGP</small>`,
            label: "Delivered by everyone on this sheet",
          }
        : {
            value: `${result.periods.length}<small> month${result.periods.length === 1 ? "" : "s"}</small>`,
            label: "Measured, against each subject's own target",
          },
      {
        value: `${pct(totals)}<small>%</small>`,
        label: "Their joint achievement, summed and not averaged",
        tone: totals !== null && totals >= 100 ? "is-up" : totals !== null ? "is-down" : "",
      },
      {
        value: `${result.rows.length}<small> of ${result.totalSubjects}</small>`,
        label: "Spotlighted out of everyone who qualified",
      },
    ])}`
    : `${opener(`Spotlight · ${result.windowLabel}`)}
    <h1 class="title title--cont">${escapeHtml(result.headline)}</h1>
    <div class="ruleunder"></div>
    <p class="lede">Continued &mdash; ranks ${offset + 1} to ${offset + rows.length} of ${result.rows.length}.</p>`;

  const body = `${head}
    <section class="lb" style="--pad:${pad.toFixed(2)}mm">
      <table>
        ${showValue ? LB_COLS : LB_COLS_NO_VALUE}
        ${showValue ? LB_HEAD : LB_HEAD_NO_VALUE}
        <tbody>${leaderboardRows(rows, offset, showValue)}</tbody>
      </table>
      ${last
        ? `<p class="lb-note">
        ${showValue
          ? `Sales in millions of EGP over ${escapeHtml(result.windowLabel)}. Achievement`
          : `Achievement over ${escapeHtml(result.windowLabel)}`} is measured against each
        subject's own target, summed across the window and never averaged.
        ${result.untargetedSubjects > 0
          ? `${result.untargetedSubjects} carried no target in this window and cannot be ranked by achievement.`
          : ""}
      </p>`
        : `<p class="lb-note">The ranking continues on sheet ${page + 1}.</p>`}
    </section>
    <div class="gap"></div>`;
  return pageShell(result, body, page, total);
}

// ── One hero sheet ────────────────────────────────────────────────────────────────────────────
/**
 * The sentence, built from counts and nothing else.
 *
 * Every clause restates a figure that is on the sheet anyway: the rank out of the field, the role,
 * the line, the territory, the months. It makes no claim about the person — a certificate that says
 * somebody is excellent is an opinion with a logo on it, and this document's whole licence is that
 * everything on it was counted.
 */
function heroSentence(result: SpotlightResult, row: SpotlightRow, rank: number): string {
  const months = monthsLabel(result.periods);
  const ranked = result.rows.length > 1
    ? `ranked ${ordinal(rank)} of ${result.totalSubjects}`
    : `spotlighted out of ${result.totalSubjects}`;
  const role = row.roleLabel.toLowerCase();
  const line = row.lineName ? ` on the ${escapeHtml(row.lineName)} line` : "";
  return `${ranked} ${escapeHtml(role)}s${line} by ${valueShown(result) ? "sales value" : "achievement"} in ${escapeHtml(row.territory)}`
    + `${months ? `, over ${escapeHtml(months)}` : ""}.`;
}

function heroPage(result: SpotlightResult, row: SpotlightRow, rank: number, page: number, total: number): string {
  const variance = row.varianceValue;
  const shownPct = pct(row.achievement);
  const showValue = valueShown(result);
  // The over-or-under caption is money, so a sheet that hides the sales value hides it too.
  const caption = variance === null || !showValue
    ? ""
    : `${egp(Math.abs(variance))} EGP ${variance >= 0 ? "over" : "under"} target`;

  const monthsCell = {
    value: `${row.targetedMonths}<small> of ${result.periods.length}</small>`,
    label: "Months in this window that carried a target",
  };
  const rankCell = {
    value: `${rank}<small> of ${result.totalSubjects}</small>`,
    label: `Rank by ${result.selection.rankBy === "achievement" ? "achievement" : "sales value"} across the company`,
  };

  // THE FIGURE PANEL TAKES THE SLACK. A single `margin-top: auto` used to shove the figure downward
  // and leave every millimetre of leftover page in ONE place, under the stats, where it reads as the
  // sheet having run out rather than having been laid out. The panel GROWS to whatever the page has
  // spare, with the number centred inside it: the open space is the composition, not the remainder.
  const body = `
    ${opener(`${result.headline} · ${result.windowLabel}`)}
    <p class="lead-in">This sheet recognises</p>

    <h1 class="name${nameSizeClass(row.title)}">${escapeHtml(row.title)}</h1>
    <div class="signrule"></div>
    ${row.titleAr ? `<p class="name-ar" dir="rtl" lang="ar">${escapeHtml(row.titleAr)}</p>` : ""}
    <p class="sentence">${heroSentence(result, row, rank)}</p>
    ${result.rows.length > 1 ? `<p class="claim">No. ${rank} of ${result.totalSubjects}</p>` : ""}

    <section class="figure">
      <div class="figure__core">
        <p class="figure__label">Achievement</p>
        <p class="figure__pct${pctSizeClass(shownPct)}">${shownPct}${row.achievement === null ? "" : "<span>%</span>"}</p>
        ${targetCaption(row) ? `<p class="figure__cap">${targetCaption(row)}</p>` : ""}
        ${gauge(row.achievement, caption)}
      </div>
    </section>

    ${statBand(showValue
      ? [
          // 🔴 THE FIGURE HERE IS THE ACHIEVEMENT'S OWN NUMERATOR, not every pound delivered. A sheet
          // that prints a number beside a target is read by dividing the two, and a reader who does that
          // has to land on the percentage above. Where the window holds an untargeted month the two
          // differ, so the all-months total moves to its own cell and says what it is.
          {
            value: `${egp(row.targetValue !== null ? row.gradedValue : row.actualValue)}<small> EGP</small>`,
            label: targetedAgainstLabel(row),
          },
          untargetedMonthsInWindow(result, row) > 0 && row.targetValue !== null
            ? {
                value: `${egp(row.actualValue)}<small> EGP</small>`,
                label: `Delivered in total, including ${monthCount(untargetedMonthsInWindow(result, row))} with no target`,
              }
            : monthsCell,
          rankCell,
        ]
      // No sales value: the months that carried a target and the rank, which print no money.
      : [monthsCell, rankCell])}`;
  return pageShell(result, body, page, total);
}

// ── Stylesheet ────────────────────────────────────────────────────────────────────────────────
const CSS = `
  @page { size: A4 portrait; margin: 0; }
  :root {
    --deep: ${C.deep}; --blue: ${C.blue}; --light: ${C.light}; --tint: ${C.tint};
    --hair: ${C.hair}; --muted: ${C.muted}; --body: ${C.body};
    --green: ${C.green}; --red: ${C.red};
    --crest: ${C.crest}; --ink: ${C.ink}; --wash: ${C.wash};
    /* NAME A FACE THE RENDERER ACTUALLY HAS. This PDF is built by the Chromium inside the
       production image, and that image installs font-noto, font-noto-arabic and ttf-freefont --
       nothing else. Aptos, Segoe UI and Calibri are not there, and Arial is not there, so the old
       stack fell through to whatever fontconfig chose, and the sheet employees received was set in
       a different face from every preview anyone had looked at. Nothing reports that. Noto is
       installed on BOTH sides, so what renders here is what renders in production.
       A SERIF ON THE DISPLAY LINE is the polish: the name, the titles and the figure are the
       certificate, and a grotesque set them like a dashboard. Running text stays sans. */
    --display: "Noto Serif", "Times New Roman", Georgia, serif;
    --text: "Noto Sans", "Segoe UI", Calibri, Helvetica, Arial, sans-serif;
    --arabic: "Noto Naskh Arabic", "Noto Sans Arabic", "Segoe UI", Tahoma, Arial, sans-serif;
    --hair-w: ${HAIR};
    --rule: #D7DFE7;
    --u: 3.4mm;
    --pad: 2.4mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; border-radius: 0; }
  body { font-family: var(--text); color: var(--body); background: #FFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; font-kerning: normal; }

  .sheet { position: relative; width: 210mm; height: 297mm; overflow: hidden;
    display: flex; flex-direction: column; }
  .sheet--break { page-break-after: always; break-after: page; }

  /* ── The crest band ──────────────────────────────────────────────────────────────────────── */
  .crest { flex: 0 0 auto; height: 26mm; background: var(--crest);
    display: flex; align-items: center; justify-content: center; }
  .crest__mark { width: 41mm; }
  .crest__mark img { display: block; width: 100%; height: auto; }
  /* A printed double rule, not one bar: the brand blue over a deeper hairline. It is the oldest
     device on a letterhead and it costs one border. */
  .crest__rule { flex: 0 0 auto; height: 1.7mm; background: var(--light);
    border-bottom: .5mm solid var(--deep); }

  /* ── The bracketed field ─────────────────────────────────────────────────────────────────── */
  /* The padding clears the brackets. They stand 9 mm tall from a 6 mm inset, so anything inside a
     13 mm top or a 15 mm bottom runs THROUGH one of them — which is how the source line at the foot
     came out with a blue rule struck across it. */
  .page { position: relative; flex: 1 1 auto; min-height: 0; padding: 13mm 18mm 15mm; }
  .field { position: absolute; inset: 6mm 12mm; border: var(--hair-w) solid var(--hair); }
  .field::after { content: ""; position: absolute; inset: 1.7mm;
    border: var(--hair-w) solid var(--light); }
  .bracket { position: absolute; width: 9mm; height: 9mm; }
  .bracket svg { display: block; width: 100%; height: 100%; }
  .bracket--tl { top: 6mm; left: 12mm; }
  .bracket--tr { top: 6mm; right: 12mm; transform: scaleX(-1); }
  .bracket--bl { bottom: 6mm; left: 12mm; transform: scaleY(-1); }
  .bracket--br { bottom: 6mm; right: 12mm; transform: scale(-1,-1); }
  /* The Arabic mark at 5%, low on the right of the content column and clear of the foot (owner,
     2026-10-12). Before .inner in the markup, so the text paints over it with no z-index. */
  .arabic-wm { position: absolute; right: 18mm; bottom: 34mm; width: 112mm; opacity: .05; pointer-events: none; }
  .arabic-wm img { display: block; width: 100%; height: auto; }

  .inner { position: relative; height: 100%; display: flex; flex-direction: column; }
  /* Pinned against shrinking: a column flex container whose content is even slightly taller than
     the box shrinks its items to fit, smallest first — which silently reduces a 1.5 mm rule to
     height 0 and leaves a page that looks deliberate. Everything is rigid EXCEPT the spacers and
     the figure panel, whose whole job is to absorb whatever is left over. */
  .inner > *:not(.gap):not(.figure) { flex: 0 0 auto; }
  .gap { flex: 1 1 0; min-height: 0; }
  .inner > .figure { flex: 1 1 auto; min-height: 0; }

  /* ── The plinth ──────────────────────────────────────────────────────────────────────────── */
  .plinth { flex: 0 0 auto; height: 9mm; background: var(--crest); color: #FFF;
    display: flex; align-items: center; justify-content: center; }
  .plinth span { font-size: 6.2pt; font-weight: 600; letter-spacing: .3em; text-transform: uppercase; }

  /* ── Openers ─────────────────────────────────────────────────────────────────────────────── */
  .eyebrow { text-align: center; font-size: 7.6pt; font-weight: 700; letter-spacing: .42em;
    text-transform: uppercase; color: var(--blue); }
  .tick { width: 16mm; height: 1.5pt; background: var(--ink); margin: calc(var(--u) * .75) auto 0; }
  .lead-in { margin-top: calc(var(--u) * 1.5); text-align: center; font-size: 6.8pt; font-weight: 600;
    letter-spacing: .34em; text-transform: uppercase; color: var(--muted); }

  /* ── The name, on its rule ───────────────────────────────────────────────────────────────── */
  /* 34 pt, not 40. Egyptian names run long — "Mohamed Ahmed Abdel Rahman" is ordinary here — and at
     40 pt the common ones wrapped to a two-line block with a short orphan under a full line. Names
     that still wrap are WRAPPED, never shortened: the owner's rule is no ellipsis anywhere. */
  /* 29 pt did not finish that job. The same name still broke as a full line and a one-word orphan,
     because at 29 pt it sets 160.6mm against a 150mm measure. nameSizeClass() measures each name and
     drops the ones that overrun to .name--long, where it sets 138.5mm and stands whole. */
  .name { margin-top: calc(var(--u) * 1.1); margin-left: auto; margin-right: auto; max-width: 150mm;
    text-align: center; font-family: var(--display); font-weight: 400; font-size: 29pt;
    line-height: 1.16; color: var(--ink); letter-spacing: -.004em; text-wrap: balance; }
  /* THE BALANCE ABOVE IS THE OTHER HALF, and it catches the names no size can save. A name of five
     parts wraps at any size worth setting it in; balanced, it wraps into even lines instead of a
     full line with one word stranded under it. Chromium honours this under print media, which is
     the only place this stylesheet is ever read. */
  .name--long { font-size: 25pt; }
  .signrule { width: 118mm; height: 1.1pt; background: var(--ink);
    margin: calc(var(--u) * 1.05) auto 0; position: relative; }
  .signrule::after { content: ""; position: absolute; left: 0; right: 0; top: 1.5mm;
    height: var(--hair-w); background: var(--hair); }
  .name-ar { margin-top: calc(var(--u) * .8); text-align: center; font-family: var(--arabic);
    font-size: 12.5pt; font-weight: 600; color: var(--muted); line-height: 1.35; }
  .sentence { margin: calc(var(--u) * 1.1) auto 0; max-width: 132mm; text-align: center;
    font-size: 9.6pt; line-height: 1.62; color: var(--body); }
  /* The rank, engraved between two rules. It was a tinted box with a blue border, which is the
     shape every screen in the building uses for a status chip -- on paper it was the one element
     that looked pasted in from a browser. Two rules and letterspaced caps say the same thing in
     the vocabulary of the rest of the sheet, and spend one less fill against the ink rule. */
  .claim { margin: calc(var(--u) * 1.3) auto 0; padding: 1.6mm 9mm 1.5mm; width: fit-content;
    border-top: var(--hair-w) solid var(--hair); border-bottom: var(--hair-w) solid var(--hair);
    font-size: 8.2pt; font-weight: 700; letter-spacing: .3em;
    text-transform: uppercase; color: var(--blue); }

  /* ── Titles on the ranking sheets ────────────────────────────────────────────────────────── */
  .title { margin-top: calc(var(--u) * 1.4); text-align: center; font-family: var(--display);
    font-weight: 700; font-size: 24pt; line-height: 1.16; color: var(--ink); letter-spacing: -.006em; }
  .title--cont { font-size: 18pt; }
  .ruleunder { width: 118mm; height: var(--hair-w); background: var(--ink);
    margin: calc(var(--u) * 1) auto 0; }
  .lede { margin: calc(var(--u) * .95) auto 0; max-width: 140mm; text-align: center; font-size: 9pt;
    line-height: 1.6; color: var(--muted); }

  /* ── The figure panel ────────────────────────────────────────────────────────────────────── */
  /* MATTED. The panel takes whatever the page has spare, so on a short name it opened a hand-sized
     hole between the rank and the number and the sheet read as unfinished. The space is the same;
     enclosing it is what makes it read as mounting rather than as leftover.
     🔴 IT CLOSES ON THE STAT BAND, AND THE HAIRLINE THAT USED TO CLOSE IT IS GONE. There was a
     border-bottom here AND the stat band's own 1.6pt rule 6.1mm under it -- a pale line, a gap, then
     a heavy line: two rules doing one job at the busiest edge of the sheet. The heavy one is the
     panel's bottom edge now, pulled flush by the .figure + .stats rule further down, which is scoped
     to the hero sheet because the ranking's band follows a paragraph and not a panel. The top stays
     a hairline, against the 1.6pt below, so the hierarchy still reads. */
  .figure { text-align: center; display: flex; flex-direction: column;
    margin-top: calc(var(--u) * 1.5);
    border-top: var(--hair-w) solid var(--hair); }
  /* THE PANEL'S SLACK IS SHARED BETWEEN ITS FOUR PARTS, not banked at the two ends. The panel takes
     whatever the page has spare, and with the parts centred as a block that surplus piled up above
     the label and below the gauge: on an ordinary sheet 25.4mm of white sat between the scale and
     the stat band's heavy rule, which reads as the panel having run out rather than as matting.
     Spread, the same surplus opens the four intervals instead and the edges come back to 11-15mm.
     It also steadies the sheet: under centring the edge gap swung 15.7mm to 29.2mm with the length
     of the name, and it now moves between 11.4mm and 15.1mm, so two hero sheets in one pack look
     like the same document. 🔴 EVENLY, NOT space-between: that one pins the label to the top
     edge and the scale to the bottom, and hands the whole surplus to the middle. */
  .figure__core { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
    justify-content: space-evenly; padding: calc(var(--u) * 1.6) 0; }
  .figure__label { font-size: 7.4pt; font-weight: 700; letter-spacing: .42em; text-transform: uppercase;
    color: var(--muted); margin-bottom: calc(var(--u) * 1.1); }
  /* MEASURED, NOT GUESSED. At 92pt the number stood 32.5mm tall inside a 95.6mm panel and left
     14.2mm of blank above it and 14.2mm below -- the panel read as a frame around nothing, which is
     what the watermark had been covering up before it came out. The figure is the payload of the
     sheet, so it is the figure that fills the space, not something printed behind it. */
  .figure__pct { font-family: var(--display); font-weight: 700; color: var(--ink); font-size: 122pt;
    line-height: 1; letter-spacing: -.028em; margin: 0;
    font-variant-numeric: lining-nums tabular-nums; }
  .figure__pct span { font-size: 52pt; vertical-align: 20pt; margin-left: 2.2mm; letter-spacing: 0;
    color: var(--light); }
  /* 🔴 IT STEPS DOWN RATHER THAN RUNNING OFF THE SHEET. An achievement is actual over target, so a
     tiny target prints four digits before the decimal. At the full size that is wider than the
     174mm of page inside the margins, and .sheet clips at A4 in total silence -- the same failure
     that once printed 18 names of 40. The number is NEVER abbreviated: it is set smaller. */
  .figure__pct--long { font-size: 94pt; letter-spacing: -.024em; }
  .figure__pct--long span { font-size: 42pt; vertical-align: 16pt; }
  .figure__pct--vlong { font-size: 72pt; letter-spacing: -.02em; }
  .figure__pct--vlong span { font-size: 33pt; vertical-align: 12pt; }
  /* BALANCED, because this line names MONTHS and a long window makes it long. A six-month window
     printed "OF THE MONTHLY TARGETS FOR JANUARY, FEBRUARY, MARCH, APRIL, MAY," and then "JUNE 2026"
     alone underneath -- sixty-nine letterspaced characters over two, which on a certificate reads
     as a line that ran out rather than a line that was set. */
  .figure__cap { margin: calc(var(--u) * 1.1) 0 0; font-size: 9.2pt; font-weight: 600;
    letter-spacing: .19em; text-transform: uppercase; color: var(--muted); text-wrap: balance; }

  .gauge { width: 128mm; margin: calc(var(--u) * 1.7) auto 0; }
  .gauge__win { text-align: right; margin-bottom: calc(var(--u) * .5); font-size: 7pt; font-weight: 700;
    letter-spacing: .13em; text-transform: uppercase; }
  .gauge__win.is-up { color: var(--green); }
  .gauge__win.is-down { color: var(--red); }
  .gauge__win i { font-style: normal; font-size: 5.8pt; margin-right: 1.2mm; vertical-align: 1pt; }
  /* THE SCALE IS ENGRAVED, NOT FILLED. It was a grey slab with a blue bar inside it and a green
     one on the end, which is a progress bar -- the one device on the sheet that belonged to a
     screen rather than to a printed page, and the first thing the eye caught after the figure.
     The same three facts are now rules standing on a hairline: how far, where the target is, and
     how far past it. Solid colours only, for the raster reason at the head of this file.
     The shortfall keeps a lighter red so it reads as the part that is MISSING rather than as
     achievement printed in red -- opacity would hand Chromium a compositing layer for nothing. */
  .gauge__track { position: relative; height: 3mm; }
  .gauge__track::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0;
    height: var(--hair-w); background: var(--hair); }
  /* 2.4 pt, not 1.5. At a hairline-and-a-half the achieved run read as part of the baseline rather
     than as a measurement drawn on top of it, and the sheet lost the one thing the scale is for. */
  .gauge__base { position: absolute; left: 0; bottom: 0; height: 2.4pt; background: var(--deep); }
  .gauge__over { position: absolute; bottom: 0; height: 2.4pt; background: var(--green); }
  .gauge__under { position: absolute; bottom: 0; height: 2.4pt; background: #E0B9B6; }
  .gauge__tick { position: absolute; bottom: -1.3mm; height: 5.2mm; width: 1.4pt;
    background: var(--ink); }
  .gauge__labels { position: relative; margin-top: calc(var(--u) * .6); height: 3.2mm; font-size: 6.2pt;
    font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
  .gauge__t { position: absolute; transform: translateX(-50%); color: var(--ink); white-space: nowrap; }
  .gauge__none { font-size: 7.4pt; color: var(--muted); text-align: center; }

  /* ── The stat band ───────────────────────────────────────────────────────────────────────── */
  .stats { display: flex; margin-top: calc(var(--u) * 1.8); background: var(--wash);
    border-top: 1.6pt solid var(--ink); border-bottom: 1.6pt solid var(--ink);
    padding: calc(var(--u) * 1.1) 0; }
  /* FLUSH UNDER THE FIGURE PANEL, AND ONLY THERE. On the hero sheet this rule IS the panel's bottom
     edge, so the 6.1mm that used to sit between two rules belongs inside the panel instead, where
     the figure is centred and it is shared evenly above and below. The ranking's band follows a
     paragraph and keeps its own space -- do not lift this onto a bare .stats. */
  .figure + .stats { margin-top: 0; }
  .stat { flex: 1 1 0; text-align: center; padding: 0 5mm; }
  .stat + .stat { border-left: var(--hair-w) solid var(--hair); }
  .stat__v { font-family: var(--display); font-weight: 700; font-size: 17.5pt; color: var(--ink);
    line-height: 1.16; font-variant-numeric: lining-nums tabular-nums; letter-spacing: -.006em; }
  .stat__v.is-up { color: var(--green); }
  .stat__v.is-down { color: var(--red); }
  .stat__v small { font-size: 9.5pt; font-weight: 600; color: var(--muted); letter-spacing: .03em; }
  .stat__l { margin-top: calc(var(--u) * .5); font-size: 6.4pt; font-weight: 600; letter-spacing: .16em;
    text-transform: uppercase; color: var(--muted); line-height: 1.6; }

  /* ── The ranking ─────────────────────────────────────────────────────────────────────────── */
  .lb { margin-top: calc(var(--u) * 1.7); }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  thead th { padding: 0 1.7mm calc(var(--u) * .66); font-size: 6.4pt; font-weight: 700; letter-spacing: .22em;
    text-transform: uppercase; color: var(--blue); text-align: left; border-bottom: 1.2pt solid var(--ink); }
  thead th.r { text-align: right; }
  td { padding: var(--pad) 1.7mm; vertical-align: baseline; border-bottom: var(--hair-w) solid var(--rule); }
  /* THE ONLY FILL INSIDE THE RANKING is the 6% zebra. The over/under key is a RULE on the rank cell,
     not a wash across the row — see the note at the head of this file. */
  tr.zebra td { background: var(--tint); }
  td:first-child { border-left: 1.3pt solid transparent; }
  tr.beat td:first-child { border-left-color: var(--green); }
  tr.miss td:first-child { border-left-color: var(--red); }
  tbody tr:last-child td { border-bottom: 1.2pt solid var(--ink); }

  .lb-rank { font-family: var(--display); font-size: 9pt; color: var(--light); font-weight: 700;
    font-variant-numeric: lining-nums tabular-nums; padding-left: 2.8mm; }
  .lb-name { font-size: 9.2pt; font-weight: 600; color: var(--body); }
  .lb-vacant { margin-left: 2.2mm; font-size: 6.2pt; font-weight: 600; letter-spacing: .1em;
    text-transform: uppercase; color: var(--muted); }
  .lb-where { font-size: 8pt; color: var(--muted); font-weight: 600; }
  .lb-line { display: block; font-size: 6.4pt; letter-spacing: .1em; text-transform: uppercase; color: var(--light); }
  .lb-value { text-align: right; font-family: var(--display); font-size: 10.5pt; font-weight: 700;
    color: var(--ink); font-variant-numeric: lining-nums tabular-nums; }
  .lb-unit { font-size: 7pt; color: var(--muted); margin-left: .7mm; font-weight: 600; }
  .lb-ach { text-align: right; font-family: var(--display); font-size: 10pt; font-weight: 700;
    font-variant-numeric: lining-nums tabular-nums; }
  .lb-ach.up { color: var(--green); }
  .lb-ach.down { color: var(--red); }
  .lb-ach.flat { color: var(--muted); }
  .lb-arrow { font-size: 6.4pt; margin-right: 1.6mm; vertical-align: 1.2pt; }
  .lb-pc { font-size: 7pt; font-weight: 600; margin-left: .4mm; }
  .lb-note { margin-top: calc(var(--u) * .9); font-size: 6.4pt; color: var(--muted); line-height: 1.62; }

  /* ── The record foot ─────────────────────────────────────────────────────────────────────── */
  /* An AUTO margin, never a fixed one. (No backticks in this stylesheet: it is a template literal,
     and one of them ends it early — which is a TypeScript syntax error 200 lines further down.)
     A fixed margin is charged to the page whether or not the page has it to give: a ten-name sheet
     came out 1.06 mm over A4 because the last 5.4 mm of separation was spent after the column had
     already been filled, and an overflowing sheet does not error — it hides the foot under the
     plinth. Auto takes what is left over, and nothing when there is nothing left. */
  .foot { margin-top: auto; padding-top: calc(var(--u) * .5); display: flex; align-items: flex-start; gap: 8mm; }
  .foot__block { padding-top: calc(var(--u) * .6); border-top: var(--hair-w) solid var(--hair); }
  /* EQUAL FLANKS, WHICH IS THE WHOLE MECHANISM. The sheet number is a fixed 20mm column between
     these two, so it lands on the centre line of the paper only while they are the same width; the
     mark used to take 1.7 of the row and pushed the number well right of centre. Do not widen one
     of them to give the calligraphy more room -- the number moves with it, silently. */
  .foot__block--mark { flex: 1 1 0; }
  /* SIZED BY HEIGHT, AND CAPPED BELOW WHAT IT REPLACED. The Source block that stood here was 17mm
     tall; this is 13mm of image over the same hairline, so the foot cannot grow. That matters
     because the ranking sheets are filled against measured constants that already pay for a footer
     of the old height, and a foot that outgrows them is pushed off the paper with no error at all.
     Width is auto, so the calligraphy keeps its own proportion and can never be squeezed. Full ink:
     in the foot this is the issuer signing the page, not a wash behind it. (No backticks in this
     stylesheet -- one of them ends the template literal, 200 lines from where the error is read.) */
  .foot__block--mark img { display: block; height: 13mm; width: auto; }
  .foot__block--no { flex: 0 0 20mm; text-align: center; }
  .foot__block--rec { flex: 1 1 0; text-align: right; }
  .foot__cap { font-size: 5.8pt; font-weight: 700; letter-spacing: .3em; text-transform: uppercase;
    color: var(--muted); }
  .foot__line { margin-top: calc(var(--u) * .35); font-size: 7pt; color: var(--body); }
  .foot__line strong { color: var(--ink); font-weight: 700; }
  .foot__sub { margin-top: calc(var(--u) * .2); font-size: 6.2pt; color: var(--muted); line-height: 1.55; }
  .foot__no { margin-top: calc(var(--u) * .3); font-family: var(--display); font-size: 12pt;
    font-weight: 700; color: var(--ink); line-height: 1.1; }
  .foot__no span { display: block; font-size: 6pt; font-weight: 600; color: var(--muted);
    letter-spacing: .14em; text-transform: uppercase; }
`;

/** The sheet's stylesheet, for the Phoenix Ranks certificate, which wears the same design. */
export const SHEET_CSS = CSS;

/** The whole document, as HTML. Exported so a test can assert on the markup without Chromium. */
export function spotlightDocumentHtml(result: SpotlightResult): string {
  const layout = result.selection.layout;

  const wantsLeaderboard = layout === "leaderboard" || layout === "both";
  const wantsHeroes = layout === "heroes" || layout === "both";

  // A single subject needs no leaderboard of one — the hero sheet already IS the leaderboard.
  const showLeaderboard = wantsLeaderboard && (result.rows.length > 1 || !wantsHeroes);
  const heroRows = wantsHeroes ? result.rows : [];

  // The leaderboard's pages are worked out BEFORE anything is rendered, because the footer on the
  // first sheet has to know how many sheets there are in all.
  const chunks: SpotlightRow[][] = [];
  if (showLeaderboard) {
    chunks.push(...paginateRows(result.rows, ROW_AREA_FIRST, ROW_AREA_LATER));
    if (chunks.length === 0) chunks.push([]);
  }

  const total = chunks.length + heroRows.length;
  const pages: string[] = [];
  let emitted = 0;
  let offset = 0;

  chunks.forEach((chunk, index) => {
    emitted += 1;
    pages.push(leaderboardPage(result, chunk, offset, index + 1, chunks.length, emitted, total));
    offset += chunk.length;
  });
  heroRows.forEach((row, index) => {
    emitted += 1;
    pages.push(heroPage(result, row, index + 1, emitted, total));
  });

  // A selection that matched nobody still produces a sheet that SAYS so. An empty PDF, or a
  // silently successful download of one blank page, reads as the export being broken.
  if (pages.length === 0) {
    pages.push(pageShell(result, `
      ${opener(`Spotlight · ${result.windowLabel}`)}
      <h1 class="title">${escapeHtml(result.headline)}</h1>
      <div class="ruleunder"></div>
      <p class="lede">Nobody matched this selection.</p>
      <section class="lb"><p class="lb-note">No subject survived these filters for ${escapeHtml(result.windowLabel)}.
        Widen the lines, regions or areas, or check that the window carries sales.</p></section>
      <div class="gap"></div>`, 1, 1));
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(result.headline)}</title><style>${CSS}</style></head>
<body>${pages.join("\n")}</body></html>`;
}

/** Render the document. Throws `ChromiumUnavailableError` when the runtime cannot produce a PDF. */
export async function renderSpotlightPdf(result: SpotlightResult): Promise<Uint8Array> {
  const html = spotlightDocumentHtml(result);
  return withChromiumPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");
    return page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}

// ── The medical rep's own sheet ─────────────────────────────────────────────────────────────────
/**
 * One hero page for a rep looking at himself — the same crest, name-on-a-rule, figure panel, gauge
 * and stat band as the admin hero (heroPage), with two differences the self case requires:
 *
 *   · NO COMPANY RANK. A rep's own recognition sheet does not place him against his peers — the whole
 *     surface exists at his request and only at 90%+, so there is no "Nth of M" to state, and the
 *     stat band's third cell carries his own total instead.
 *
 *   · A SENTENCE WITHOUT A RANKING CLAUSE. `heroSentence` opens "ranked/spotlighted out of N …",
 *     which is meaningless for a party of one; this states his role, line, territory and the months.
 *
 * Everything visual is the shared, locked design (pageShell, opener, gauge, statBand, the figure
 * panel) so the rep's sheet cannot drift from the one the owner signed off.
 */
function repHeroSentence(result: SpotlightResult, row: SpotlightRow): string {
  const months = monthsLabel(result.periods);
  const role = escapeHtml(row.roleLabel.toLowerCase());
  const line = row.lineName ? ` on the ${escapeHtml(row.lineName)} line` : "";
  const where = row.territory ? ` in ${escapeHtml(row.territory)}` : "";
  return `A ${role}${line}${where}${months ? `, over ${escapeHtml(months)}` : ""}.`;
}

export function repSpotlightDocumentHtml(result: SpotlightResult): string {
  const row = result.rows[0];
  if (!row) {
    const body = `
      ${opener(`Spotlight · ${escapeHtml(result.windowLabel)}`)}
      <h1 class="title">${escapeHtml(result.headline)}</h1>
      <div class="ruleunder"></div>
      <p class="lede">There is nothing to spotlight for this period yet.</p>
      <div class="gap"></div>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(result.headline)}</title><style>${CSS}</style></head>
<body style="margin:0">${pageShell(result, body, 1, 1)}</body></html>`;
  }

  const variance = row.varianceValue;
  const shownPct = pct(row.achievement);
  const caption = variance === null
    ? ""
    : `${egp(Math.abs(variance))} EGP ${variance >= 0 ? "over" : "under"} target`;
  const untargeted = untargetedMonthsInWindow(result, row);

  const body = `
    ${opener(`${escapeHtml(result.headline)} · ${escapeHtml(result.windowLabel)}`)}
    <p class="lead-in">This sheet recognises</p>

    <h1 class="name${nameSizeClass(row.title)}">${escapeHtml(row.title)}</h1>
    <div class="signrule"></div>
    ${row.titleAr ? `<p class="name-ar" dir="rtl" lang="ar">${escapeHtml(row.titleAr)}</p>` : ""}
    <p class="sentence">${repHeroSentence(result, row)}</p>

    <section class="figure">
      <div class="figure__core">
        <p class="figure__label">Achievement</p>
        <p class="figure__pct${pctSizeClass(shownPct)}">${shownPct}${row.achievement === null ? "" : "<span>%</span>"}</p>
        ${targetCaption(row) ? `<p class="figure__cap">${targetCaption(row)}</p>` : ""}
        ${gauge(row.achievement, caption)}
      </div>
    </section>

    ${statBand([
      {
        value: `${egp(row.targetValue !== null ? row.gradedValue : row.actualValue)}<small> EGP</small>`,
        label: targetedAgainstLabel(row),
      },
      untargeted > 0 && row.targetValue !== null
        ? {
            value: `${egp(row.actualValue)}<small> EGP</small>`,
            label: `Delivered in total, including ${monthCount(untargeted)} with no target`,
          }
        : {
            value: `${row.targetedMonths}<small> of ${result.periods.length}</small>`,
            label: "Months in this period that carried a target",
          },
      {
        value: `${egp(row.actualValue)}<small> EGP</small>`,
        label: "Delivered in total over this period",
      },
    ])}`;

  // THE ARABIC WORDMARK AS A WATERMARK — owner instruction for the rep's own sheet (2026-09-30).
  //
  // Scoped to THIS sheet only: the admin spotlight keeps the Arabic mark in the foot, and the history
  // in this file's header (the four placements the owner struck on 2026-09-12) is left untouched there.
  // Since 2026-10-12 every other sheet carries the shell's low-right watermark too; this one keeps its
  // own centred one and asks the shell for none, so the rep's page never shows two.
  // What that history teaches is honoured here so the watermark is not the version he rejected:
  //   · CENTRED AND CONTAINED, never bled off the right edge — Arabic reads RTL, so an off-edge mark
  //     eats the first half of the company name. 168mm inside a 210mm page keeps the whole name visible.
  //   · PALE and BEHIND the content, so the figure stays the payload rather than fighting a second mark.
  // One <img> (the same base64 object as the foot), so it adds no per-page raster layer.
  const watermarkStyle = `<style>
    .rep-wm { position: absolute; left: 50%; top: 40%; transform: translate(-50%, -50%);
      width: 168mm; opacity: 0.05; z-index: 0; pointer-events: none; }
    .rep-wm img { display: block; width: 100%; height: auto; }
    .rep-wm-content { position: relative; z-index: 1; }
  </style>`;
  const framed = `<div class="rep-wm">${arabicMark()}</div><div class="rep-wm-content">${body}</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(result.headline)}</title><style>${CSS}</style>${watermarkStyle}</head>
<body style="margin:0">${pageShell(result, framed, 1, 1, { watermark: false })}</body></html>`;
}

/** The rep's sheet, as a PDF. Throws `ChromiumUnavailableError` when the runtime cannot render one. */
export async function renderRepSpotlightPdf(result: SpotlightResult): Promise<Uint8Array> {
  const html = repSpotlightDocumentHtml(result);
  return withChromiumPage(async (page) => {
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("print");
    return page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  });
}

/**
 * The rep's sheet, as a PICTURE — a PNG he can send in a message.
 *
 * A screenshot needs an explicit viewport or Chromium hands back an 800×600 thumbnail of the corner
 * (see the note beside `setViewport` in chromium.ts). A4 at 96dpi is 794×1123, and a
 * `deviceScaleFactor` of 2 doubles the pixels so the number and the name stay crisp when shared. The
 * sheet is one page, so a full-page shot captures exactly the certificate and nothing else.
 */
export async function renderRepSpotlightPng(result: SpotlightResult): Promise<Uint8Array> {
  const html = repSpotlightDocumentHtml(result);
  return withChromiumPage(async (page) => {
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("screen");
    return page.screenshot({ type: "png", fullPage: true });
  });
}
