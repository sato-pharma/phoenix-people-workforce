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

import { withChromiumPage, type ChromiumPage } from "@/lib/pdf/chromium";

import {
  MILESTONE_CARD_LAYOUT_SCRIPT,
  milestoneCardHtml,
  milestoneCardPageSizeMm,
  type MilestoneCardInput,
  type MilestoneCardVariant,
} from "./card";

export type MilestoneCardLayout = { nameSize: number; nameWidth: number; citationLines: number };

export type MilestoneCardRender = {
  pdf: Buffer;
  /** What the browser settled on — the proof the layout pass ran. Logged, and asserted in tests. */
  layout: MilestoneCardLayout;
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
async function layOutCard(page: ChromiumPage, html: string): Promise<MilestoneCardLayout> {
  await page.setContent(html, { waitUntil: "networkidle0" });

  const report = (await page.evaluate(MILESTONE_CARD_LAYOUT_SCRIPT)) as {
    nameSize?: number;
    nameWidth?: number;
    citationLines?: number;
  } | null;

  if (!report || typeof report.nameSize !== "number" || typeof report.citationLines !== "number") {
    throw new Error("The milestone card's layout pass did not report back — refusing to print it.");
  }

  await page.emulateMediaType("print");
  return {
    nameSize: report.nameSize,
    nameWidth: report.nameWidth ?? 0,
    citationLines: report.citationLines,
  };
}

export async function renderMilestoneCard(
  input: MilestoneCardInput,
  variant: MilestoneCardVariant = "trim",
): Promise<MilestoneCardRender> {
  const html = milestoneCardHtml(input, { variant });
  const size = milestoneCardPageSizeMm(variant);

  return withChromiumPage(async (page) => {
    const layout = await layOutCard(page, html);
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
    const layout = await layOutCard(page, html);
    const bytes = await page.screenshot({ type: "png", fullPage: true, omitBackground: false });

    return {
      png: Buffer.from(bytes),
      pixels: { width: width * IMAGE_SCALE, height: height * IMAGE_SCALE },
      layout,
    };
  });
}
