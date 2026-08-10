/**
 * Measures every sidebar nav label at the rail's real geometry and writes the snapshot that
 * tests/sidebar-label-width.test.ts asserts against.
 *
 * Why a script and not a pure test: label width depends on the actual font (this app resolves to
 * Aptos — `--font-dm-sans` is referenced in globals.css but never defined), and a per-character
 * advance model was measured at up to 9px error on strings like "Weekly / Monthly Plans", which is
 * more than the 5px of real slack the tightest label has. So widths are MEASURED here in headless
 * Chromium and committed; the test then needs no browser and stays fast.
 *
 * Run after adding or renaming any sidebar label:
 *   pnpm run ui:measure-sidebar-labels
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

import { adminNavigationSections, employeePortalNavigationSections } from "@/config/system-navigation";
import { LABEL_FONT_CSS, SIDEBAR_LABEL_SNAPSHOT_PATH } from "@/config/sidebar-metrics";

const labels = [
  ...new Set(
    [...adminNavigationSections, ...employeePortalNavigationSections].flatMap((section) =>
      section.items.map((navItem) => navItem.label),
    ),
  ),
].sort();

// LABEL_FONT_CSS carries double-quoted font names, so it must live in a <style> block — inlining it
// into a style="" attribute silently terminates the attribute and the probe falls back to a serif.
const html = `<style>
  body{margin:0}
  #probe{position:absolute;white-space:nowrap;width:auto;${LABEL_FONT_CSS}}
</style><span id="probe"></span>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
const widths = await page.evaluate((list: string[]) => {
  const probe = document.getElementById("probe") as HTMLElement;
  const out: Record<string, number> = {};
  for (const label of list) {
    probe.textContent = label;
    // Round UP: a fractional pixel still clips, and the budget comparison must be conservative.
    out[label] = Math.ceil(probe.getBoundingClientRect().width);
  }
  return out;
}, labels);
const font = await page.evaluate(() => getComputedStyle(document.getElementById("probe")!).fontFamily);
await browser.close();

writeFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, `${JSON.stringify(widths, null, 2)}\n`, "utf8");
console.log(`font: ${font}`);
console.log(`measured ${Object.keys(widths).length} distinct sidebar labels -> ${SIDEBAR_LABEL_SNAPSHOT_PATH}`);
const widest = Object.entries(widths).sort((a, b) => b[1] - a[1])[0];
console.log(`widest: "${widest[0]}" at ${widest[1]}px`);
