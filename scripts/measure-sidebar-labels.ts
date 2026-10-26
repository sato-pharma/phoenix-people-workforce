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
 * From a worktree, where pnpm is refused, run the same line through node (MEASURE_SIDEBAR_LABELS_WORKTREE_COMMAND
 * in src/config/sidebar-metrics.ts). `node scripts/check-contracts.mjs` says before the push when it is due.
 */
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

import {
  BOTTOM_BAR_LABEL_FONT_CSS,
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

writeFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`-> ${SIDEBAR_LABEL_SNAPSHOT_PATH}`);
