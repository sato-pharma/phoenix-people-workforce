import assert from "node:assert/strict";

import { spotlightDocumentHtml } from "../src/lib/spotlight/pdf.ts";
import type { SpotlightResult, SpotlightRow } from "../src/lib/spotlight/types.ts";

// Spotlight — the sheet that leaves the building.
//
// This pins the two classes of defect that a PDF does not report. Neither throws, neither shows up
// in a unit test of the arithmetic, and both were live:
//
//   1. A NAME OFF THE PAGE. `.sheet` clips at A4 and the ranking used to print on one sheet however
//      long it was, so a 40-name leaderboard exported 18 names, no footer, and a row sliced in
//      half. The export succeeded. Every assertion below that counts ranks exists for that.
//
//   2. A PAGE-SIZED RASTER PER RULE. Chromium rasterises a CSS gradient or a repeating background
//      into its own full-page layer when printing — measured once at 6.88 MB for a 6-page sheet
//      whose text is a few kilobytes. The ornament is drawn as polylines and the mark is embedded
//      once as a data URI for that reason, and both are easy to "improve" back into a raster.
//
// Plus the house identity rules this document must obey: square edges everywhere, and no filled
// areas beyond the zebra row.

function row(overrides: Partial<SpotlightRow> & { title: string }): SpotlightRow {
  const actualValue = overrides.actualValue ?? 2_000_000;
  const targetValue = overrides.targetValue === undefined ? 1_800_000 : overrides.targetValue;
  return {
    key: overrides.title,
    titleAr: null,
    roleLabel: "Medical Representative",
    territory: "Helwan-Maadi",
    lineName: "CNS",
    hrId: "B-136",
    isVacant: false,
    actualValue,
    // The ordinary case: every active month carried a target, so the numerator IS the actual. A
    // fixture that wants the other shape overrides gradedValue and targetedPeriods together.
    gradedValue: overrides.gradedValue ?? actualValue,
    targetValue,
    achievement: targetValue === null ? null : (actualValue / targetValue) * 100,
    varianceValue: targetValue === null ? null : actualValue - targetValue,
    targetedPeriods: targetValue === null ? [] : ["2026-06", "2026-07", "2026-08"],
    targetedMonths: targetValue === null ? 0 : 3,
    activeMonths: 3,
    ...overrides,
  };
}

function result(rows: SpotlightRow[], layout: "leaderboard" | "heroes" | "both" = "leaderboard"): SpotlightResult {
  const actual = rows.reduce((sum, r) => sum + r.actualValue, 0);
  const target = rows.reduce((sum, r) => sum + (r.targetValue ?? 0), 0);
  return {
    selection: {
      window: { kind: "quarter", key: "2026-Q3" },
      subject: "rep",
      filters: {},
      rankBy: "value",
      direction: "top",
      limit: rows.length,
      layout,
    },
    periods: ["2026-06", "2026-07", "2026-08"],
    windowLabel: "Q3 2026",
    headline: "Top Medical Representatives",
    subheadline: "CNS, Pedia and Anti Infective",
    rows,
    totalSubjects: 111,
    shortlistActualValue: actual,
    shortlistTargetValue: target,
    shortlistAchievement: target === 0 ? null : (actual / target) * 100,
    untargetedSubjects: 0,
    generatedAtCairo: "12 September 2026, 03:40",
  };
}

const people = (count: number) =>
  Array.from({ length: count }, (_, i) => row({ title: `Subject Number ${i + 1}`, actualValue: 3_000_000 - i * 10_000 }));

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

/** Rows per sheet, in order, read back out of the rendered markup. */
function rowsPerSheet(html: string): number[] {
  return html
    .split('class="sheet')
    .slice(1)
    .map((sheet) => countOf(sheet, 'class="lb-rank"'));
}

export function runSpotlightSheetDesignTests() {
  // ── A long ranking paginates, and nobody falls off it ──────────────────────────────────────
  const long = spotlightDocumentHtml(result(people(40)));
  const sheets = countOf(long, 'class="sheet');
  assert.ok(sheets > 1, "40 names cannot fit one A4 sheet — the ranking must paginate, not clip");
  for (let rank = 1; rank <= 40; rank += 1) {
    assert.ok(
      long.includes(`class="lb-rank">${String(rank).padStart(2, "0")}<`),
      `rank ${rank} is missing from the document — a clipped sheet loses names with no error at all`,
    );
  }
  for (let i = 1; i <= 40; i += 1) {
    assert.ok(long.includes(`Subject Number ${i}<`), `Subject Number ${i} was dropped from the ranking`);
  }

  // Ranks are continuous and in order across the page break: a continuation sheet restarting at 01
  // would read as a second, smaller ranking.
  const orderedRanks = [...long.matchAll(/class="lb-rank">(\d+)</g)].map((m) => Number(m[1]));
  assert.deepEqual(orderedRanks, Array.from({ length: 40 }, (_, i) => i + 1), "ranks must run 1..40 in order");

  // ── Every sheet says which sheet it is, and whose it is ────────────────────────────────────
  assert.equal(
    countOf(long, 'class="foot__cap">Sheet<'),
    sheets,
    "every sheet carries its own number — these go out as a stapled pack",
  );
  assert.equal(countOf(long, `<span> of ${sheets}</span>`), sheets, "the total on each sheet is the real page count");
  assert.equal(countOf(long, 'class="crest"'), sheets, "the crest band is the issuer's name and belongs on every sheet");
  assert.equal(countOf(long, 'class="plinth"'), sheets, "and the plinth closes every sheet, not just the first");

  // ── Pages are balanced, not filled-then-remainder ──────────────────────────────────────────
  const spread = rowsPerSheet(spotlightDocumentHtml(result(people(14))));
  assert.ok(spread.length > 1, "14 uniform names take more than one sheet");
  assert.ok(
    Math.max(...spread) - Math.min(...spread) <= 1,
    `pages must be balanced so the last sheet is not a stub — got ${spread.join("/")}`,
  );
  assert.equal(spread.reduce((a, b) => a + b, 0), 14, "balancing must not add or lose a row");

  // ── Layout switches still produce the pages they promise ───────────────────────────────────
  const both = spotlightDocumentHtml(result(people(3), "both"));
  assert.equal(countOf(both, 'class="sheet'), 4, "both = one leaderboard sheet plus one hero sheet per subject");
  const heroes = spotlightDocumentHtml(result(people(3), "heroes"));
  assert.equal(countOf(heroes, 'class="sheet'), 3, "heroes alone is one sheet per subject, with no leaderboard");
  const alone = spotlightDocumentHtml(result(people(1), "both"));
  assert.equal(countOf(alone, 'class="sheet'), 1, "a single subject needs no leaderboard of one");
  const nobody = spotlightDocumentHtml(result([], "both"));
  assert.equal(countOf(nobody, 'class="sheet'), 1, "an empty selection still prints a sheet that says so");
  assert.ok(nobody.includes("Nobody matched this selection"), "and says it in words, rather than exporting a blank page");

  // ── A target is set for a MONTH, and the sheet may not invent a quarterly one ──────────────
  // The owner, 2026-09-12: "no its monthly target not q3". The window a sheet covers is not the
  // period a target was set for. Over a three-month window the figure is sales over the SUM of
  // three monthly targets — so naming it "the Q3 2026 target" tells the person the sheet is about
  // that they were measured against a number nobody in the business ever set.
  const quarterHero = spotlightDocumentHtml(result(people(1), "heroes"));
  assert.ok(
    quarterHero.includes("of the monthly targets for June · July · August 2026"),
    "a multi-month window is measured against the monthly targets in it, named month by month",
  );
  assert.ok(!quarterHero.includes("Q3 2026 target"), "there is no such thing as a quarterly target here");

  // A one-month window is the case where naming the window IS naming the target.
  const oneMonthRow = row({ title: "Ali Hassan", targetedPeriods: ["2026-07"], targetedMonths: 1 });
  const oneMonth = { ...result([oneMonthRow], "heroes"), periods: ["2026-07"], windowLabel: "July 2026" };
  assert.ok(
    spotlightDocumentHtml(oneMonth).includes("of the July 2026 target"),
    "a single-month window keeps the shorter sentence, because there the window is the target",
  );

  // ── The caption names the months that CARRIED a target, never the window's own ──────────────
  // This is the half the first wording got wrong: it replaced a fabricated quarterly target with
  // three fabricated monthly ones. Mar-Jun 2026 carry sales and no target on the three tracked
  // lines, so a subject targeted in one month of a quarter is the ordinary shape of this data.
  const partial = row({
    title: "Ali Hassan",
    actualValue: 3_000_000,   // every pound, across the whole quarter
    gradedValue: 2_000_000,   // the two-thirds of it earned in the month that carried a target
    targetValue: 2_000_000,
    targetedPeriods: ["2026-07"],
    targetedMonths: 1,
  });
  const partialHtml = spotlightDocumentHtml(result([partial], "heroes"));
  assert.ok(
    partialHtml.includes("of the July 2026 target"),
    "the caption names the month that carried a target, not the three the window covers",
  );
  assert.ok(
    !partialHtml.includes("of the monthly targets for June · July · August 2026"),
    "a target is never asserted for a month nobody set one in — the sheet's own stat band says 1 of 3",
  );

  // ── The figure beside the target DIVIDES into the percentage above it ───────────────────────
  // A reader who sees a number next to a target divides the two. Printing every pound there against
  // a denominator that excludes an untargeted month makes that division disagree with the headline
  // percentage, on the same page, with no way to tell which is wrong.
  assert.ok(
    partialHtml.includes("Delivered in the month that carried a target, against 2,000,000"),
    "the numerator is labelled as the targeted months' money, so the pair can be divided",
  );
  assert.ok(
    !partialHtml.includes("Delivered against 2,000,000 in monthly targets"),
    "which is the label that invited the wrong division",
  );
  assert.ok(
    partialHtml.includes("Delivered in total, including 2 months with no target"),
    "and every pound is still on the sheet, under its own name",
  );

  // The ordinary case keeps the short label, because there the two figures ARE the same.
  assert.ok(
    quarterHero.includes("Delivered against 1,800,000 in monthly targets"),
    "where every active month was targeted, the total IS the numerator and the label stays plain",
  );

  // ── A subject with no target says so, rather than naming a denominator it does not have ─────
  const noTarget = spotlightDocumentHtml(result([row({ title: "Ali Hassan", targetValue: null })], "heroes"));
  assert.ok(
    noTarget.includes("No target was set for this window, so there is no achievement to draw."),
    "an untargeted subject states it outright, in one full sentence",
  );
  assert.ok(
    !noTarget.includes("of the monthly targets for"),
    "it must not print a caption claiming targets behind a dash",
  );
  assert.ok(
    !noTarget.includes('<p class="figure__cap">'),
    "and it says it once — a caption repeating the gauge's sentence is the sheet stating twice that it has nothing to state",
  );
  // A dash is not a percentage, so it does not wear a percent sign.
  assert.ok(!/—<span>%<\/span>/.test(noTarget), "no achievement means no per-cent sign beside the dash");
  assert.ok(
    quarterHero.includes("<span>%</span>"),
    "while a real achievement keeps it — this assertion must fail if the sign is dropped for everyone",
  );

  // ── The hero number steps down rather than running off the sheet ───────────────────────────
  // An achievement is actual over target, so a small target prints four or five digits before the
  // decimal. Measured in Chromium under print media: at the full size a seven-character number is
  // 174.2mm of glyph against the 174mm of page inside the margins, and .sheet clips at A4 without
  // an error — the same silent failure that once printed 18 names of 40. It is set smaller
  // instead; it is never shortened.
  const vast = spotlightDocumentHtml(result([row({ title: "Ali Hassan", actualValue: 4_812_400, targetValue: 34_070 })], "heroes"));
  assert.ok(
    vast.includes('class="figure__pct figure__pct--vlong"'),
    "a seven-character achievement must step down, not be clipped by the sheet",
  );
  const wide = spotlightDocumentHtml(result([row({ title: "Ali Hassan", actualValue: 4_812_400, targetValue: 340_600 })], "heroes"));
  assert.ok(wide.includes('class="figure__pct figure__pct--long"'), "and a six-character one takes the middle step");
  const ordinary = spotlightDocumentHtml(result([row({ title: "Ali Hassan" })], "heroes"));
  assert.ok(ordinary.includes('class="figure__pct"'), "an ordinary achievement keeps the full size");
  assert.ok(
    !ordinary.includes('class="figure__pct figure__pct--'),
    "the step-down is for the exception — these assertions must read the element, never the stylesheet every sheet carries",
  );

  // ── The NAME steps down too, and a character count cannot decide when ──────────────────────
  // The name stands ON a rule, which is the certificate device that separates a name that has been
  // awarded something from a name in a list — and it reads as one only while the name above it is
  // one line. At 29pt "Mohamed Ahmed Abdel Rahman", an unremarkable name here, broke as a full line
  // and the orphan "Rahman".
  //
  // 🔴 THE DECISION IS THE NAME'S WIDTH IN THE REAL FACE, WHICH IS WHY THE TABLE EXISTS. The pair
  // below is the whole argument: a 23-character name that sets 151.9mm overruns the 150mm measure,
  // and a LONGER 25-character one that sets 133.5mm does not. Any rule that counts letters gets one
  // of those two wrong, and the one it gets wrong wraps a name that had no need to wrap. Measured in
  // Chromium under print media, in the face production actually has.
  const nameHtml = (title: string) => spotlightDocumentHtml(result([row({ title })], "heroes"));
  assert.ok(
    nameHtml("Mohamed Mohamed Mohamed").includes('class="name name--long"'),
    "a 23-character name that sets 151.9mm steps down — a character count would have left it at full "
      + "size and wrapped it",
  );
  assert.ok(
    nameHtml("Youssef Kamal El Sharkawy").includes('class="name"'),
    "while a LONGER 25-character name that sets 133.5mm keeps the full size — the same count would "
      + "have shrunk this one for nothing",
  );
  assert.ok(
    nameHtml("Mohamed Ahmed Abdel Rahman").includes('class="name name--long"'),
    "the name that started this steps down, so it stands whole on its rule",
  );
  assert.ok(nameHtml("Heba Ali Shahin").includes('class="name"'), "and a short name is left alone");

  const nameRule = /\.name \{([^}]*)\}/.exec(ordinary)?.[1] ?? "";
  const nameSize = Number(/font-size:\s*([\d.]+)pt/.exec(nameRule)?.[1]);
  const longSize = Number(/\.name--long\s*\{[^}]*font-size:\s*([\d.]+)pt/.exec(ordinary)?.[1]);
  assert.ok(
    Number.isFinite(nameSize) && Number.isFinite(longSize),
    "both name sizes were read off the emitted stylesheet — a pattern that matches nothing leaves NaN "
      + "on both sides, and NaN < NaN is false, so the next assertion would fail for the wrong reason",
  );
  assert.ok(longSize < nameSize, "the step is DOWN — a bigger --long would wrap the names it exists to save");

  // 🔴 AND WHAT NO SIZE CAN SAVE WRAPS EVENLY, rather than leaving one word stranded underneath.
  assert.ok(
    /\.name \{[^}]*text-wrap:\s*balance/.test(ordinary),
    "a name of five parts wraps at any size worth setting it in, so it wraps into even lines",
  );
  assert.ok(
    /\.figure__cap \{[^}]*text-wrap:\s*balance/.test(ordinary),
    "and so does the caption, which names MONTHS — a six-month window set sixty-nine letterspaced "
      + "characters on one line and \"June 2026\" alone on the next",
  );
  assert.ok(
    !/\u2026/.test(long) && !/\.\.\./.test(long),
    "nothing anywhere on the sheet is shortened with an ellipsis — it is set smaller or it wraps",
  );

  // ── ONE rule closes the figure panel, where two used to stand 6.1mm apart ──────────────────
  // The panel had a hairline along its bottom edge AND the stat band's own 1.6pt rule 6.1mm under
  // it: a pale line, a gap, then a heavy line, two rules doing one job at the busiest edge of the
  // sheet. The heavy one is the panel's bottom edge now.
  // Anchored on the line start: ".inner > .figure { ... }" sits higher up the same stylesheet and
  // matches a bare pattern — a rule with no border in it at all, which is green for the wrong reason.
  const figureRule = /\n  \.figure \{([^}]*)\}/.exec(ordinary)?.[1] ?? "";
  assert.ok(/border-top:/.test(figureRule), "the panel still opens on a hairline, against the 1.6pt below it");
  assert.ok(
    !/border-bottom:/.test(figureRule),
    "and does not close on a second rule 6.1mm above the stat band's — that pair was the redundancy",
  );
  assert.ok(
    /\.figure \+ \.stats \{[^}]*margin-top:\s*0/.test(ordinary),
    "the band is pulled flush instead, so the heavy rule IS the panel's bottom edge",
  );
  assert.ok(
    /\n  \.stats \{[^}]*margin-top:\s*calc/.test(ordinary),
    "and ONLY there — the ranking's band follows a paragraph, not a panel, and keeps its own space",
  );
  assert.ok(
    /\.figure__core \{[^}]*justify-content:\s*space-evenly/.test(ordinary),
    "the panel's surplus is shared over its four parts — centred as a block it banked 25.4mm of white "
      + "between the scale and the heavy rule, which reads as the panel having run out",
  );

  // ── Nothing on the page may rasterise ──────────────────────────────────────────────────────
  assert.ok(!/gradient\(/.test(long), "a CSS gradient costs Chromium a page-sized raster layer per rule when printing");
  assert.ok(!/repeating-/.test(long), "a repeating background rasterises the same way — the ornament stays vector");
  assert.ok(
    long.includes('src="data:image/svg+xml;base64,'),
    "the mark is embedded ONCE as a base64 data URI; inlining its paths repeats them on every page",
  );
  assert.ok(!/<img[^>]*src="\/(?!\/)/.test(long), "setContent has no base URL — an /absolute src renders nothing at all");
  assert.ok(long.includes("<polyline"), "the braid and the corner bosses are polylines, not images");

  // ── The Arabic mark signs the FOOT, and replaced the Source block outright ───────────────
  // Four placements came out before this one — a wash behind the figure, a bleed off the right edge,
  // a seal under the gauge, a pale watermark over the figure's left shoulder — and all four put the
  // mark where the page was already saying something. The owner, 2026-09-12: "you will put in the
  // left corner the logo ... the Arabic one", striking the Source block in the same breath.
  const heroHtml = spotlightDocumentHtml(result([row({ title: "Ali Hassan" })], "heroes"));
  assert.ok(
    heroHtml.includes('<div class="foot__block foot__block--mark"><img alt="" src="data:image/png;base64,'),
    "the Arabic logotype is embedded as one base64 data URI — setContent has no base URL, so an "
      + "/absolute src renders a hole in the sheet and reports nothing",
  );
  assert.equal(
    countOf(long, 'class="foot__block foot__block--mark"'),
    sheets,
    "on EVERY sheet including the ranking — a logo in the corner of the foot is not a wash behind a "
      + "table of names, which is what made the earlier placement hero-only",
  );

  // 🔴 THE SOURCE BLOCK IS GONE, BY HIS DECISION, AND THE OTHER TWO ARE NOT.
  assert.ok(!heroHtml.includes("foot__block--src"), "the Source block it replaced is not still being emitted");
  assert.ok(!heroHtml.includes("Sales vs Target"), "nor its wording somewhere else on the sheet");
  assert.ok(heroHtml.includes("SATO-DIS-2026-01 v1.0"), "the document identity stays — it is a standing house rule");
  assert.ok(heroHtml.includes('class="foot__cap">Sheet<'), "and so does the sheet numbering, which pins a stapled pack");

  // 🔴 NO ISSUE STAMP. The owner had it off on 2026-09-12. A time of day on a recognition sheet
  // dates it to the minute somebody happened to press a button, which is a fact about the export and
  // not about the person holding the paper — and it makes two prints of one achievement disagree.
  assert.ok(!heroHtml.includes("Issued"), "the sheet carries no issue stamp");
  assert.ok(
    !heroHtml.includes("12 September 2026, 03:40") && !heroHtml.includes("Africa/Cairo"),
    "nor the generated-at time under another name — the fixture sets one, so this fails if it reaches the page",
  );

  // 🔴 THE SHEET NUMBER SITS ON THE CENTRE LINE, AND EQUAL FLANKS ARE THE ONLY THING PUTTING IT
  // THERE. It is a fixed 20mm column between two flexible ones; the moment those two differ it slides
  // off centre, which is what a 1.7-to-1 split did while the Source block was there. MEASURED on the
  // rendered sheet: its centre is 105.00mm across a 210mm page.
  const markFlex = Number(/\.foot__block--mark\s*\{[^}]*flex:\s*([\d.]+)/.exec(heroHtml)?.[1]);
  const recFlex = Number(/\.foot__block--rec\s*\{[^}]*flex:\s*([\d.]+)/.exec(heroHtml)?.[1]);
  assert.ok(
    Number.isFinite(markFlex) && Number.isFinite(recFlex),
    "both flank widths were read off the stylesheet — assert.equal(NaN, NaN) PASSES, so a pattern that "
      + "matches nothing would make the next assertion green while testing nothing",
  );
  assert.equal(
    markFlex, recFlex,
    "the blocks either side of the sheet number are the same width, which is what puts the number on the "
      + "centre line of the paper — widen one and the number moves with it, silently",
  );
  assert.ok(
    /\.foot__block--no\s*\{[^}]*flex:\s*0 0 \d/.test(heroHtml),
    "and the number's own column is fixed, so it cannot drift with its content either",
  );

  assert.equal(
    countOf(long, "<img"),
    sheets * 3,
    "three <img> per sheet and no more — the crest mark, the Arabic mark in the foot and the same "
      + "Arabic mark as the watermark, each embedded once and referenced by every page",
  );

  // ── AND A 5% WATERMARK, LOW ON THE RIGHT, ON EVERY SHEET (owner, 2026-10-12) ──────────────
  // "watermark and footer only": the Arabic logo is never a masthead, and this sheet keeps its foot
  // mark AND carries the watermark. Contained, so the whole name shows; before the content, so the
  // text paints over it; and none of the four placements struck on 2026-09-12 — not a wash behind
  // the figure, not bled off the edge, not under the gauge, not over the figure's left shoulder.
  assert.equal(
    countOf(long, '<div class="arabic-wm"><img alt="" src="data:image/png;base64,'),
    sheets,
    "one watermark on EVERY sheet, the Arabic mark's own data URI",
  );
  for (const sheet of long.split('<div class="sheet').slice(1)) {
    assert.ok(
      sheet.indexOf('class="arabic-wm"') > 0 && sheet.indexOf('class="arabic-wm"') < sheet.indexOf('<div class="inner">'),
      "the watermark sits before the content on each sheet, so the text paints over it",
    );
  }
  const wmRule = /\.arabic-wm\s*\{([^}]*)\}/.exec(heroHtml)?.[1] ?? "";
  assert.match(wmRule, /opacity:\s*\.05/, "at 5%, the strength the HR papers carry it at");
  assert.match(wmRule, /right:\s*\d/, "anchored on the RIGHT, where the HR papers carry it");
  assert.match(wmRule, /bottom:\s*\d/, "and LOW, above the foot — never centred behind the figure");
  assert.ok(
    !/(top|right|bottom|left):\s*-/.test(wmRule),
    "never bled off an edge — Arabic starts on the right, so a bleed cuts the company name's first word",
  );

  const markRule = /\.foot__block--mark img\s*\{([^}]*)\}/.exec(heroHtml)?.[1] ?? "";

  // 🔴 THE FOOT MAY NOT GROW. ROW_AREA_FIRST and ROW_AREA_LATER are measured constants that
  // already pay for a footer of the old height; a foot taller than that is pushed off the bottom of
  // the paper and slices the last row in half, with no error anywhere. The Source block stood 17mm.
  const markHeight = Number(/height:\s*([\d.]+)mm/.exec(markRule)?.[1]);
  assert.ok(
    markHeight > 0 && markHeight <= 15,
    `the mark is capped below the 17mm block it replaced, so the foot cannot outgrow the page — found ${markHeight}mm`,
  );

  // 🔴 NOTHING OF THE NAME MAY BE CUT OR SQUEEZED. The first build ran the mark off the right
  // edge, copying the certificate exactly — and Arabic reads right to left, so A4 ate the first half
  // of the name and left the second by itself. The owner: "no you croped sato the company name".
  // Height with width auto is what keeps the calligraphy at its own proportion whatever the column
  // does; a width in millimetres here would stretch or crush it instead.
  assert.ok(
    /width:\s*auto/.test(markRule),
    "width is auto, so the name keeps its own proportion and is never squeezed to fit the column",
  );
  assert.ok(
    !/(top|right|bottom|left):\s*-/.test(markRule),
    "no negative offset — .sheet clips at A4 with overflow:hidden and reports nothing, so one does not "
      + "bleed off the edge, it deletes what it pushes past it",
  );

  assert.ok(
    !/\.foot__block--mark[^}]*(background-image|filter:)/.test(heroHtml),
    "tinting or masking at render time costs a composited layer per page — the file is already the house blue",
  );


  // ── House identity ─────────────────────────────────────────────────────────────────────────
  assert.ok(long.includes("border-radius: 0"), "square edges everywhere — the house rule has no exception on this sheet");
  const radii = [...long.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(radii)], ["0"], `no rounded corner may appear on a company document — found ${radii.join(", ")}`);
  assert.ok(long.includes("SATO-DIS-2026-01 v1.0"), "the document identity is Sato Pharma's, on every sheet");

  // ── The face the production renderer actually has ──────────────────────────────────────────
  // This PDF is built by the Chromium inside the production image, and that image installs exactly
  // three font packages: font-noto, font-noto-arabic and ttf-freefont. A stack led by Aptos, Segoe
  // UI, Calibri or Arial — none of which are in the image — fell through to whatever fontconfig
  // chose, so the sheet employees received was set in a different face from every preview anybody
  // had looked at, and nothing in the render reports it.
  assert.ok(/--display:\s*"Noto Serif"/.test(long), "the display face must be one the production image installs");
  assert.ok(/--text:\s*"Noto Sans"/.test(long), "so must the text face — Segoe UI and Calibri are not in that image");
  assert.ok(
    /--arabic:\s*"Noto Naskh Arabic"/.test(long),
    "and the Arabic face: ttf-freefont carries the codepoints but does not SHAPE them, which prints a name as separate letters",
  );

  // ── Colour keeps its meaning ───────────────────────────────────────────────────────────────
  // Green means at-or-above target and red means below, and nothing else on the page is either.
  // A tint WASHED ACROSS THE ROW is what took that meaning away: seven of ten rows filled green
  // reads as decoration. The key is a rule on the rank cell; the zebra is the only fill in the TABLE.
  //
  // 🔒 AND IT IS THE ONLY ONE THE TABLE HAS — NOT THE ONLY ONE THE SHEET HAS. The crest band,
  // the plinth and the stat band are filled too, and on 2026-09-12 the owner was asked about them in
  // writing and ruled that they STAY: approved exemptions from `SATO-DIS-2026-01`'s ink rule, not an
  // oversight and not a debt. Do not "bring them into line", and do not read this assertion as
  // licence to. AGENTS.md section 4 carries the ruling.
  assert.ok(long.includes("tr.zebra td { background: var(--tint); }"),
    "the zebra is the one fill the RANKING TABLE carries — the panel's three bands are the owner's own exemption");
  assert.ok(!/tr\.beat td\s*{\s*background/.test(long), "an over-target row is keyed by a rule, never filled with green");
  assert.ok(long.includes("tr.beat td:first-child { border-left-color: var(--green); }"), "over target is keyed green");
  assert.ok(long.includes("tr.miss td:first-child { border-left-color: var(--red); }"), "under target is keyed red");

  // ── Text from the database is escaped ──────────────────────────────────────────────────────
  const injected = spotlightDocumentHtml(result([row({ title: "<b>Ali</b> & Co", territory: "Giza <5>" })]));
  assert.ok(injected.includes("&lt;b&gt;Ali&lt;/b&gt; &amp; Co"), "a name is text, never markup");
  assert.ok(!injected.includes("<b>Ali</b>"), "an unescaped tag from a name would restyle or break the sheet");
}

// ── NO SALES VALUE (owner, 2026-11-04) ────────────────────────────────────────────────────────────
// "Rank by achievement without showing the sales value." A sheet that prints a target beside a
// percentage gives the sales away, so the option hides EVERY EGP figure, sales and target alike.
export async function runSpotlightHideValueTests() {
  const { parseSelection } = await import("../src/lib/spotlight/request.ts");
  const { normaliseSelection } = await import("../src/lib/spotlight/service.ts");

  const base = {
    window: { kind: "month", key: "2026-10" },
    subject: "rep",
    filters: {},
    rankBy: "value",
    direction: "top",
    limit: 5,
    layout: "both",
  };

  // The request: only an explicit false hides the money, so every existing caller keeps its sheet.
  assert.equal(parseSelection(base).showValue, undefined, "absent means shown");
  assert.equal(parseSelection({ ...base, showValue: true }).showValue, undefined, "true means shown");
  assert.equal(parseSelection({ ...base, showValue: "no" }).showValue, undefined, "only a boolean false hides");
  assert.equal(parseSelection({ ...base, showValue: false }).showValue, false, "false hides the money");

  // The service: no value means no ranking by it, whatever the caller asked for.
  const forced = normaliseSelection({ ...parseSelection({ ...base, showValue: false }), rankBy: "value" });
  assert.equal(forced.rankBy, "achievement", "a sheet with no sales value must be ranked by achievement");
  assert.equal(
    normaliseSelection(parseSelection(base)).rankBy,
    "value",
    "a sheet that shows the value keeps the ranking it was asked for",
  );

  // The sheet: leaderboard AND hero pages print no money at all.
  const rows = people(3);
  const shown = spotlightDocumentHtml(result(rows, "both"));
  const hiddenResult = result(rows, "both");
  hiddenResult.selection = { ...hiddenResult.selection, rankBy: "achievement", showValue: false };
  const hidden = spotlightDocumentHtml(hiddenResult);

  assert.ok(shown.includes("EGP") && shown.includes('class="lb-value"'), "the default sheet still prints sales");
  assert.ok(!hidden.includes("EGP"), "a sheet with no sales value prints no EGP figure anywhere, sales or target");
  assert.ok(!hidden.includes('class="lb-value"'), "the leaderboard drops its Sales column");
  assert.ok(!/>Sales</.test(hidden), "no Sales heading is left over an empty column");
  assert.ok(!hidden.includes("Rank by sales value") && !hidden.includes("by sales value"), "the sheet never says it ranked by value");
  for (let i = 1; i <= 3; i += 1) {
    assert.ok(hidden.includes(`Subject Number ${i}<`), `Subject Number ${i} is still on the sheet`);
  }
}
