/**
 * Measures every sidebar nav label at its rail's real typography and writes the snapshot that
 * tests/sidebar-label-width.test.ts asserts against.
 *
 * Why a script and not a pure test: label width depends on the actual font, and a per-character
 * advance model was measured at up to 9px error on strings like "Weekly / Monthly Plans", which is
 * more than the 5px of real slack the tightest label has. So widths are MEASURED here in headless
 * Chromium and committed; the test then needs no browser and stays fast.
 *
 * Measured in TWO faces per rail. This browser draws the stack with the first family it can see, which
 * on the Windows laptop is Segoe UI, not Aptos, whatever a computed style prints. So "admin" and
 * "portal" hold THIS machine's face, and "fallback" holds the same labels in Arial, where a machine
 * with none of the earlier families lands. The width test holds the budget against both.
 *
 * Measured PER SHELL since #2353's follow-up. The admin rail renders labels at 13px/600/-0.01em and
 * the employee portal at 12px/700 — a label that appears in both (e.g. "Territory Management") is
 * genuinely two different widths, and one number could only ever be right for one of them.
 *
 * Run after adding or renaming any sidebar label:
 *   pnpm run ui:measure-sidebar-labels
 * From a worktree, where pnpm is refused, run the same line through node (MEASURE_SIDEBAR_LABELS_WORKTREE_COMMAND
 * in src/config/sidebar-metrics.ts). `node scripts/check-contracts.mjs` says before the push when it is due.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

import {
  BOTTOM_BAR_LABEL_FONT_CSS,
  FALLBACK_LABEL_FONT_FAMILY,
  fallbackLabelFontCss,
  labelFontCss,
  SIDEBAR_LABEL_SNAPSHOT_PATH,
  sidebarLabelsOf,
  type SidebarShell,
} from "@/config/sidebar-metrics";
import {
  HOME_ENTRY,
  PORTAL_NAV_REGISTRY,
  PROFILE_ENTRY,
} from "@/components/employee-portal/employee-portal-nav-registry";
import {
  adminNavigationSections,
  employeePortalNavigationSections,
  hrNavigationSections,
  type NavigationSection,
} from "@/config/system-navigation";

// Canonical label AND every `labelByRole` override — the sidebar test resolves per-role labels
// through getSections before measuring, so an override that never appears here would always read
// as missing (getSections would hand back a label this script never probed). The rule is
// `sidebarLabelsOf`, shared with tests/sidebar-label-snapshot.test.ts, the pre-push half of that test.
const labelsOf = (sections: readonly NavigationSection[]): string[] => sidebarLabelsOf(sections);

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
const fallback: Record<string, Record<string, number>> = {};

// A family this browser cannot see falls through and measures as the next one, without a word. So ask
// by width against monospace; a computed style only prints the list back.
await page.setContent(`<style>
  body{margin:0}
  span{position:absolute;white-space:nowrap;font-size:40px}
  #bare{font-family:monospace}
  #face{font-family:"${FALLBACK_LABEL_FONT_FAMILY}",monospace}
</style><span id="bare">Weekly Attendance</span><span id="face">Weekly Attendance</span>`);
const fallbackVisible = await page.evaluate(
  () =>
    document.getElementById("bare")!.getBoundingClientRect().width !==
    document.getElementById("face")!.getBoundingClientRect().width,
);
if (!fallbackVisible) {
  await browser.close();
  throw new Error(
    `${FALLBACK_LABEL_FONT_FAMILY} is not visible to this browser, so its widths would be another face's. Nothing was written.`,
  );
}

async function measureLabels(fontCss: string, labels: string[]): Promise<Record<string, number>> {
  // The font CSS carries double-quoted family names, so it must live in a <style> block — inlining
  // it into a style="" attribute silently terminates the attribute and the probe falls back to a
  // serif, which measures narrower and would certify labels that clip.
  await page.setContent(`<style>
  body{margin:0}
  #probe{position:absolute;white-space:nowrap;width:auto;${fontCss}}
</style><span id="probe"></span>`);

  return page.evaluate((list: string[]) => {
    const probe = document.getElementById("probe") as HTMLElement;
    const out: Record<string, number> = {};
    for (const label of list) {
      probe.textContent = label;
      // Round UP: a fractional pixel still clips, and the budget comparison must be conservative.
      out[label] = Math.ceil(probe.getBoundingClientRect().width);
    }
    return out;
  }, labels);
}

for (const { labels, shell } of shells) {
  fallback[shell] = await measureLabels(fallbackLabelFontCss(shell), labels);
  snapshot[shell] = await measureLabels(labelFontCss(shell), labels);

  const resolved = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("probe")!);
    return `${cs.fontSize} / ${cs.fontWeight} / ${cs.fontFamily}`;
  });
  const widest = Object.entries(snapshot[shell]).sort((a, b) => b[1] - a[1])[0];
  const widestFallback = Object.entries(fallback[shell]).sort((a, b) => b[1] - a[1])[0];
  console.log(`${shell}: ${labels.length} labels at ${resolved}`);
  console.log(`${shell}: widest "${widest[0]}" at ${widest[1]}px`);
  console.log(`${shell}: widest in ${FALLBACK_LABEL_FONT_FAMILY} "${widestFallback[0]}" at ${widestFallback[1]}px`);
}

// ── the mobile bottom bar ────────────────────────────────────────────────────
//
// A third surface, measured differently on purpose. Its labels come from the portal nav REGISTRY,
// not from employeePortalNavigationSections, and what is stored is the width of each label's
// longest WORD rather than the label itself: the span wraps, so that word is the narrowest a tab
// can ever be laid out and therefore the floor the fit test has to add up. Storing the whole label
// would re-import the nowrap assumption the wrap fix removed.
await page.setContent(`<style>
  body{margin:0}
  #probe{position:absolute;white-space:nowrap;width:auto;${BOTTOM_BAR_LABEL_FONT_CSS}}
</style><span id="probe"></span>`);

const barLabels = [...new Set([HOME_ENTRY, PROFILE_ENTRY, ...PORTAL_NAV_REGISTRY].map((e) => e.label))].sort();
snapshot["bottom-bar"] = await page.evaluate((list: string[]) => {
  const probe = document.getElementById("probe") as HTMLElement;
  const out: Record<string, number> = {};
  for (const label of list) {
    out[label] = Math.max(
      ...label.split(" ").filter(Boolean).map((word) => {
        probe.textContent = word;
        return Math.ceil(probe.getBoundingClientRect().width);
      }),
    );
  }
  return out;
}, barLabels);

{
  const resolved = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById("probe")!);
    return `${cs.fontSize} / ${cs.fontWeight} / ${cs.fontFamily}`;
  });
  const widest = Object.entries(snapshot["bottom-bar"]).sort((a, b) => b[1] - a[1])[0];
  console.log(`bottom-bar: ${barLabels.length} labels at ${resolved}`);
  console.log(`bottom-bar: widest word "${widest[0]}" at ${widest[1]}px`);
}

await browser.close();

writeFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, `${JSON.stringify({ ...snapshot, fallback }, null, 2)}\n`, "utf8");
console.log(`-> ${SIDEBAR_LABEL_SNAPSHOT_PATH}`);
