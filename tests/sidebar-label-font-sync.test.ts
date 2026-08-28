import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The sidebar width guard is only as honest as the font it measures.
 *
 * tests/sidebar-label-width.test.ts asserts every nav label fits its rail, using widths measured in
 * headless Chromium by scripts/measure-sidebar-labels.ts. That script renders its probe in whatever
 * src/config/sidebar-metrics.ts names — NOT in whatever the app actually renders. Nothing tied the
 * two together, so they could disagree, and on 2026-08-28 they did.
 *
 * #2541 self-hosted Inter and put it first in --phx-font-ui. sidebar-metrics.ts kept naming Aptos.
 * For the ~80 minutes it was live the app rendered every label in Inter — x-height ~0.73em against
 * Aptos's ~0.50em, plus wider advances — while CI measured Aptos and certified they all fit. The
 * owner saw the shell turn bigger and bolder with labels truncating; the suite stayed green the
 * whole time, because a width guard that measures the wrong typeface cannot fail. It was reverted,
 * and this test is what makes the next attempt visible.
 *
 * Two independent ways they can drift apart, so two assertions:
 *
 *   1. The family LIST must match. A change to --phx-font-ui that skips sidebar-metrics.ts is the
 *      exact shape of what shipped.
 *   2. A UI face may not be webfont-loaded unless the measuring harness loads it too. This is the
 *      subtler half: even with identical stacks, headless Chromium renders a self-hosted face only
 *      if something serves it the file. The harness injects no @font-face at all, so it would fall
 *      back to a system substitute and still measure the wrong thing.
 *
 * If you are shipping a UI webfont: size-match it to Aptos with `size-adjust` first, teach
 * scripts/measure-sidebar-labels.ts to load the file, re-run `pnpm run ui:measure-sidebar-labels`,
 * and update sidebar-metrics.ts in the same change. The type scale in src/styles/tokens.css was
 * calibrated by eye against Aptos across ~4,800 call sites, so swapping the face rescales all of
 * them at once — the sidebar is merely the only place with a hard width budget to make it visible.
 */

const TOKENS = "src/styles/tokens.css";
const METRICS = "src/config/sidebar-metrics.ts";
const LAYOUT = "app/layout.tsx";
const HARNESS = "scripts/measure-sidebar-labels.ts";

/** Split a CSS font-family list into normalised family names, quotes and whitespace removed. */
function families(list: string): string[] {
  return list
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " "))
    .filter(Boolean);
}

export function runSidebarLabelFontSyncTests() {
  const tokens = readFileSync(TOKENS, "utf8");
  const metrics = readFileSync(METRICS, "utf8");
  const layout = readFileSync(LAYOUT, "utf8");
  const harness = readFileSync(HARNESS, "utf8");

  // ── 1. the app's UI stack and the measured stack must be the same list ────────
  const appMatch = tokens.match(/--phx-font-ui:\s*([^;]+);/);
  assert.ok(appMatch, `${TOKENS} must declare --phx-font-ui — the app's UI font stack`);
  const appFamilies = families(appMatch[1]);

  // The stack lives inside a single-quoted JS string whose family names are double-quoted, so read
  // to the closing single quote. A lazy match stops at the first inner quote and captures "Aptos",.
  const metricsMatch = metrics.match(/font-family:([^']*)'/);
  assert.ok(metricsMatch, `${METRICS} must declare a font-family for the label probe`);
  const measuredFamilies = families(metricsMatch[1]);

  assert.deepEqual(
    measuredFamilies,
    appFamilies,
    `The sidebar width guard measures a different typeface than the app renders.\n` +
      `  app (${TOKENS} --phx-font-ui): ${appFamilies.join(", ")}\n` +
      `  measured (${METRICS}):        ${measuredFamilies.join(", ")}\n` +
      `Every label width in tests/fixtures/sidebar-label-widths.json is therefore wrong, and the ` +
      `width test cannot fail no matter how badly labels overflow. Update ${METRICS} to match, then ` +
      `re-run \`pnpm run ui:measure-sidebar-labels\`.`,
  );

  // ── 2. no UI face may be webfont-loaded unless the harness loads it too ───────
  const declared = [...layout.matchAll(/@font-face\{[^}]*font-family:\s*"([^"]+)"/g)].map((m) => m[1]);
  const uiSet = new Set(appFamilies.map((f) => f.toLowerCase()));
  const uiWebfonts = declared.filter((f) => uiSet.has(f.toLowerCase()));

  for (const face of uiWebfonts) {
    assert.ok(
      harness.includes(face),
      `"${face}" is @font-face-loaded in ${LAYOUT} and is part of the app's UI stack, but ` +
        `${HARNESS} never loads it — so the harness measures a system substitute and the width ` +
        `guard silently certifies the wrong typeface. This is exactly how #2541 shipped a visible ` +
        `regression through a green suite. Teach the harness to inject the same @font-face, or ` +
        `drop the webfont.`,
    );
  }
}
