// Milestone card → PDF or picture, through headless Chromium.
//
// Same engine as every other document this app prints (`src/lib/pdf/chromium.ts`). The only thing
// worth saying about it is the ORDER, and it is load-bearing:
//
//   setContent → fonts ready → LAYOUT PASS → print media → pdf
//
// 🔴 THE LAYOUT PASS MUST FINISH BEFORE `page.pdf()`. It is what fits the name to the frame and
// wraps the citation, and it can only run once Pinyon Script has actually loaded — an unloaded
// webfont measures at the fallback's metrics, which are not even close. `page.evaluate` returns
// the pass's own report, so a card that printed WITHOUT it is impossible rather than merely
// unlikely: no report, no PDF.

import { PDFDocument } from "pdf-lib";

import { withChromiumPage, type ChromiumPage } from "@/lib/pdf/chromium";

import {
  MILESTONE_CARD_LAYOUT_SCRIPT,
  milestoneCardHtml,
  milestoneCardPageSizeMm,
  milestoneCardsHtml,
  type MilestoneCardInput,
  type MilestoneCardVariant,
} from "./card";

export type MilestoneCardLayout = {
  nameSize: number;
  nameWidth: number;
  citationLines: number;
  /** The point size the citation settled at after the fit loop — a card near 8.6 was a tight fit. */
  citationSize: number;
};

/**
 * How many cards one Chromium page lays out and prints at a time.
 *
 * 🔴 THE BOUND IS DECODED PORTRAIT MEMORY, NOT BROWSER LAUNCHES. The whole batch runs in ONE
 * `withChromiumPage` — one launch — but every card on a page holds its portrait decoded in memory
 * at once (~15 MB each). Six is the window that stays well inside the container between `setContent`
 * calls; the next chunk replaces the content, so the previous chunk's portraits are freed before the
 * following ones decode. The chunk PDFs are then stitched with pdf-lib into the one file.
 */
export const MILESTONE_RENDER_CHUNK = 6;

/**
 * The most cards one download may carry.
 *
 * 🔴 THIS IS A REQUEST-TIME CEILING, NOT A MEMORY ONE. The render pages internally at
 * `MILESTONE_RENDER_CHUNK`, freeing each chunk's portraits before the next decode, so a large batch
 * is bounded in memory however big it is — a whole window still prints as ONE download, from ONE
 * Chromium launch, against ONE export-rate-limit allowance. Client-side paging into several requests
 * was the obvious-looking way to lift the old 30 and is precisely wrong: the limiter bounds launches,
 * so page two would 429. So the ceiling is raised here instead (30 → 150, owner 2026-09-23, "add
 * paging so a whole large window prints as one download"), high enough that a real month of birthdays
 * and anniversaries across the company clears it, low enough that one request cannot run unbounded.
 */
export const MILESTONE_BATCH_MAX = 150;

export type MilestoneCardRender = {
  pdf: Buffer;
  /** What the browser settled on — the proof the layout pass ran. Logged, and asserted in tests. */
  layout: MilestoneCardLayout;
};

export type MilestoneCardsRender = {
  pdf: Buffer;
  /** One report per card, in order — the proof every card was fitted, not just the first. */
  layouts: MilestoneCardLayout[];
};

export type MilestoneCardImageRender = {
  png: Buffer;
  /** The raster's real size in pixels, so the caller can state it rather than promise it. */
  pixels: { width: number; height: number };
  layout: MilestoneCardLayout;
};

/**
 * How many times the card's own resolution the picture is taken at.
 *
 * 🔴 THIS NUMBER IS THE PICTURE'S QUALITY, AND NOTHING IN THE SCREENSHOT OPTIONS IS. PNG is
 * lossless, so there is no "quality" setting to turn up — there is only how many pixels Chromium
 * was asked to paint, and that comes from the viewport's `deviceScaleFactor`. At 4 the A4 sheet
 * comes out 3176 × 4492, which is 384 DPI on paper: above the 300 DPI a print shop asks for, so
 * the picture can be printed as well as sent. Lower it and the card looks soft the moment anybody
 * prints it; there is no way to tell from the file itself that it was ever going to.
 */
const IMAGE_SCALE = 4;

/** Points → CSS pixels. The card is drawn in points (the PDF user unit); a screen is 96 DPI. */
function cssPixels(mm: number): number {
  return Math.round((mm / 25.4) * 96);
}

/**
 * Lay the card out and hand back the browser's own report.
 *
 * Shared by both outputs on purpose: the picture and the PDF must be the SAME artwork, fitted the
 * same way. Two copies of this sequence would eventually disagree about the one thing that matters
 * — whether the layout pass ran before the output was taken.
 */
type CardReport = {
  nameSize?: number;
  nameWidth?: number;
  citationLines?: number;
  citationSize?: number;
};

/**
 * Lay every card in the document out and hand back one report PER card.
 *
 * 🔴 THE GUARD IS A COUNT, NOT A PRESENCE CHECK. A batch document holds N cards; the pass fits each
 * and returns `cards: [...]`. Checking only that *a* report came back would pass a document where
 * cards 2..N printed unfitted — off the frame — because card 1's report is valid. So this refuses
 * unless there are exactly as many reports as cards asked for, and every one carries real numbers.
 *
 * Shared by both outputs on purpose: the picture and the PDF must be the SAME artwork, fitted the
 * same way. Two copies of this sequence would eventually disagree about whether the pass ran.
 */
async function layOutCards(
  page: ChromiumPage,
  html: string,
  expected: number,
): Promise<MilestoneCardLayout[]> {
  await page.setContent(html, { waitUntil: "networkidle0" });

  const report = (await page.evaluate(MILESTONE_CARD_LAYOUT_SCRIPT)) as { cards?: CardReport[] } | null;
  const cards = report?.cards;

  if (!Array.isArray(cards) || cards.length !== expected) {
    throw new Error("The milestone card's layout pass did not report every card — refusing to print it.");
  }

  const layouts = cards.map((card) => {
    if (!card || typeof card.nameSize !== "number" || typeof card.citationLines !== "number") {
      throw new Error("The milestone card's layout pass did not report back — refusing to print it.");
    }
    return {
      nameSize: card.nameSize,
      nameWidth: card.nameWidth ?? 0,
      citationLines: card.citationLines,
      citationSize: card.citationSize ?? 0,
    };
  });

  await page.emulateMediaType("print");
  return layouts;
}

export async function renderMilestoneCard(
  input: MilestoneCardInput,
  variant: MilestoneCardVariant = "trim",
): Promise<MilestoneCardRender> {
  const html = milestoneCardHtml(input, { variant });
  const size = milestoneCardPageSizeMm(variant);

  return withChromiumPage(async (page) => {
    const [layout] = await layOutCards(page, html, 1);
    const bytes = await page.pdf({
      width: `${size.width}mm`,
      height: `${size.height}mm`,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return { pdf: Buffer.from(bytes), layout };
  });
}

/**
 * A whole window of cards as ONE PDF, one card per page.
 *
 * 🔴 ONE BROWSER LAUNCH FOR THE WHOLE BATCH. The rate limit bounds Chromium launches, and this is
 * one; the number of cards is bounded by `MILESTONE_BATCH_MAX` at the caller, and the memory of
 * rendering them by the chunk. Each chunk lays out and prints inside the single page, and the chunk
 * PDFs are stitched with pdf-lib — a page-tree copy, so no artwork is re-rasterised.
 *
 * No `photoUpload` and no `photoFocus` ever reach this path: a batch prints from the record only,
 * because one person's face on another's card is the one mistake that cannot be taken back.
 */
export async function renderMilestoneCardsPdf(
  inputs: MilestoneCardInput[],
  variant: MilestoneCardVariant = "trim",
): Promise<MilestoneCardsRender> {
  if (inputs.length === 0) {
    throw new Error("A batch needs at least one card.");
  }
  const size = milestoneCardPageSizeMm(variant);

  return withChromiumPage(async (page) => {
    const layouts: MilestoneCardLayout[] = [];
    const chunkPdfs: Buffer[] = [];

    for (let start = 0; start < inputs.length; start += MILESTONE_RENDER_CHUNK) {
      const chunk = inputs.slice(start, start + MILESTONE_RENDER_CHUNK);
      const html = milestoneCardsHtml(chunk, { variant });
      const chunkLayouts = await layOutCards(page, html, chunk.length);
      layouts.push(...chunkLayouts);
      const bytes = await page.pdf({
        width: `${size.width}mm`,
        height: `${size.height}mm`,
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
      chunkPdfs.push(Buffer.from(bytes));
    }

    if (chunkPdfs.length === 1) {
      return { pdf: chunkPdfs[0], layouts };
    }

    const out = await PDFDocument.create();
    for (const chunk of chunkPdfs) {
      const source = await PDFDocument.load(chunk);
      const pages = await out.copyPages(source, source.getPageIndices());
      for (const one of pages) out.addPage(one);
    }
    return { pdf: Buffer.from(await out.save()), layouts };
  });
}

/**
 * The same card as a picture — a PNG at print resolution.
 *
 * 🔴 THE VIEWPORT IS SET TO THE SHEET, NOT LEFT AT CHROMIUM'S DEFAULT. A page opened at 800 × 600
 * lays an A4 card out into a window narrower than the card, and `fullPage` then captures whatever
 * that produced. Sizing the window to the sheet first is what makes the picture the card rather
 * than a photograph of a badly-sized window; `fullPage` afterwards is belt and braces for a
 * rounding pixel at the bottom edge.
 *
 * PNG, never JPEG: the card is flat colour, hairlines and type, which is precisely what JPEG's
 * ringing damages most and what PNG stores exactly.
 */
export async function renderMilestoneCardImage(
  input: MilestoneCardInput,
  variant: MilestoneCardVariant = "trim",
): Promise<MilestoneCardImageRender> {
  const html = milestoneCardHtml(input, { variant });
  const size = milestoneCardPageSizeMm(variant);
  const width = cssPixels(size.width);
  const height = cssPixels(size.height);

  return withChromiumPage(async (page) => {
    await page.setViewport({ width, height, deviceScaleFactor: IMAGE_SCALE });
    const [layout] = await layOutCards(page, html, 1);
    const bytes = await page.screenshot({ type: "png", fullPage: true, omitBackground: false });

    return {
      png: Buffer.from(bytes),
      pixels: { width: width * IMAGE_SCALE, height: height * IMAGE_SCALE },
      layout,
    };
  });
}
