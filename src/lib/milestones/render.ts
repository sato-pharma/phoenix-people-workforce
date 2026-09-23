// Milestone card → PDF, through headless Chromium.
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

import { withChromiumPage } from "@/lib/pdf/chromium";

import {
  MILESTONE_CARD_LAYOUT_SCRIPT,
  milestoneCardHtml,
  milestoneCardPageSizeMm,
  type MilestoneCardInput,
  type MilestoneCardVariant,
} from "./card";

export type MilestoneCardRender = {
  pdf: Buffer;
  /** What the browser settled on — the proof the layout pass ran. Logged, and asserted in tests. */
  layout: { nameSize: number; nameWidth: number; citationLines: number };
};

export async function renderMilestoneCard(
  input: MilestoneCardInput,
  variant: MilestoneCardVariant = "trim",
): Promise<MilestoneCardRender> {
  const html = milestoneCardHtml(input, { variant });
  const size = milestoneCardPageSizeMm(variant);

  return withChromiumPage(async (page) => {
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
    const bytes = await page.pdf({
      width: `${size.width}mm`,
      height: `${size.height}mm`,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    return {
      pdf: Buffer.from(bytes),
      layout: {
        nameSize: report.nameSize,
        nameWidth: report.nameWidth ?? 0,
        citationLines: report.citationLines,
      },
    };
  });
}
