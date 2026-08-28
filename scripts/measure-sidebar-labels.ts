/**
 * Measures every sidebar nav label at its rail's real typography and writes the snapshot that
 * tests/sidebar-label-width.test.ts asserts against.
 *
 * Why a script and not a pure test: label width depends on the actual font (this app resolves to
 * Aptos — `--font-dm-sans` is referenced in globals.css but never defined), and a per-character
 * advance model was measured at up to 9px error on strings like "Weekly / Monthly Plans", which is
 * more than the 5px of real slack the tightest label has. So widths are MEASURED here in headless
 * Chromium and committed; the test then needs no browser and stays fast.
 *
 * Measured PER SHELL since #2353's follow-up. The admin rail renders labels at 13px/600/-0.01em and
 * the employee portal at 12px/700 — a label that appears in both (e.g. "Territory Management") is
 * genuinely two different widths, and one number could only ever be right for one of them.
 *
 * Run after adding or renaming any sidebar label:
 *   pnpm run ui:measure-sidebar-labels
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

import { labelFontCss, SIDEBAR_LABEL_SNAPSHOT_PATH, type SidebarShell } from "@/config/sidebar-metrics";
import {
  adminNavigationSections,
  employeePortalNavigationSections,
  hrNavigationSections,
  type NavigationSection,
} from "@/config/system-navigation";

// Canonical label AND every `labelByRole` override — the sidebar test resolves per-role labels
// through getSections before measuring, so an override that never appears here would always read
// as missing (getSections would hand back a label this script never probed).
function labelsOf(sections: readonly NavigationSection[]): string[] {
  return [
    ...new Set(
      sections.flatMap((section) =>
        section.items.flatMap((navItem) => [navItem.label, ...Object.values(navItem.labelByRole ?? {})]),
      ),
    ),
  ].sort();
}

// The /hr namespace renders in the SAME rail component at the same type scale (usesAdminChrome
// is true for it), so its labels are measured as "admin" rather than in a shell of their own — one
// snapshot map, because they are genuinely the same pixels.
const shells: { labels: string[]; shell: SidebarShell }[] = [
  { labels: labelsOf([...adminNavigationSections, ...hrNavigationSections]), shell: "admin" },
  { labels: labelsOf(employeePortalNavigationSections), shell: "portal" },
];

const browser = await chromium.launch();
const page = await browser.newPage();
const snapshot: Record<string, Record<string, number>> = {};

for (const { labels, shell } of shells) {
  // The font CSS carries double-quoted family names, so it must live in a <style> block — inlining
  // it into a style="" attribute silently terminates the attribute and the probe falls back to a
  // serif, which measures narrower and would certify labels that clip.
  await page.setContent(`<style>
  body{margin:0}
  #probe{position:absolute;white-space:nowrap;width:auto;${labelFontCss(shell)}}
</style><span id="probe"></span>`);

  snapshot[shell] = await page.evaluate((list: string[]) => {
    const probe = document.getElementById("probe") as HTMLElement;
    const out: Record<string, number> = {};
    for (const label of list) {
      probe.textContent = label;
      // Round UP: a fractional pixel still clips, and the budget comparison must be conservative.
      out[label] = Math.ceil(probe.getBoundingClientRect().width);
    }
    return out;
  }, labels);

  const resolved = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("probe")!);
    return `${cs.fontSize} / ${cs.fontWeight} / ${cs.fontFamily}`;
  });
  const widest = Object.entries(snapshot[shell]).sort((a, b) => b[1] - a[1])[0];
  console.log(`${shell}: ${labels.length} labels at ${resolved}`);
  console.log(`${shell}: widest "${widest[0]}" at ${widest[1]}px`);
}

await browser.close();

writeFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`-> ${SIDEBAR_LABEL_SNAPSHOT_PATH}`);
