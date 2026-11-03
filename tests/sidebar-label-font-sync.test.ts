import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FALLBACK_LABEL_FONT_FAMILY } from "../src/config/sidebar-metrics.ts";

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
 * Three independent ways they can drift apart, so three assertions:
 *
 *   1. The family LIST must match. A change to --phx-font-ui that skips sidebar-metrics.ts is the
 *      exact shape of what shipped.
 *   2. A UI face may not be webfont-loaded unless the measuring harness loads it too. This is the
 *      subtler half: even with identical stacks, headless Chromium renders a self-hosted face only
 *      if something serves it the file. The harness injects no @font-face at all, so it would fall
 *      back to a system substitute and still measure the wrong thing.
 *   3. The SIZE and WEIGHT must match what each rail's label span renders. The family is only one
 *      of three inputs to a text advance, and this one had already drifted before #2541 ever
 *      landed: sidebar-metrics.ts modelled the admin label at weight 600 from #1999 while
 *      sidebar.tsx has rendered `font-bold` (700) since 2026-06-02 — every admin label measured
 *      1-6px narrower than it ships, for three months, with the width guard green throughout. That
 *      one hid in plain sight because the two numbers live in different files and nothing compared
 *      them; unlike #2541 it never became visible, which is worse, not better.
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
const ADMIN_RAIL = "src/components/layout/sidebar.tsx";
const PORTAL_RAIL = "src/components/employee-portal/employee-portal-layout.tsx";
const BOTTOM_BAR = "src/components/employee-portal/employee-portal-bottom-nav.tsx";

/** Tailwind's named weights. `font-bold` is 700 — the one that was modelled as 600 for three months. */
const WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500,
  semibold: 600, bold: 700, extrabold: 800, black: 900,
};

/** Resolve a `text-phx-<step>` utility to its pixel value via --phx-fs-<step> in tokens.css. */
function stepPx(tokens: string, step: string): number | null {
  const m = tokens.match(new RegExp(`--phx-fs-${step}:\\s*(\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
}

/** The size and weight a class string renders at, resolved through the token ladder. */
function renderedType(classes: string, tokens: string): { size: number | null; weight: number | null } {
  const size = classes.match(/\btext-phx-([a-z0-9]+)\b/);
  const weight = classes.match(/\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/);
  return {
    size: size ? stepPx(tokens, size[1]) : null,
    weight: weight ? WEIGHTS[weight[1]] : null,
  };
}

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

  // The snapshot's second face is only worth measuring while the stack can actually land on it.
  assert.ok(
    appFamilies.includes(FALLBACK_LABEL_FONT_FAMILY),
    `${METRICS} measures every label a second time in ${FALLBACK_LABEL_FONT_FAMILY}, which --phx-font-ui no longer names. ` +
      `Point FALLBACK_LABEL_FONT_FAMILY at the stack's last named family, then re-run \`pnpm run ui:measure-sidebar-labels\`.`,
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

  // ── 3. the modelled size and weight must match what each rail renders ────────
  // The family is only half of it. sidebar-metrics.ts modelled the admin label at weight 600 from
  // #1999 while sidebar.tsx rendered `font-bold` (700) from 2026-06-02 — every admin label measured
  // 1-6px narrower than it ships, for three months, with the width guard green throughout. Pinned by
  // PATTERN rather than a byte window: a fixed slice false-fails the moment the file shifts.
  const rails = [
    {
      shell: "admin",
      file: ADMIN_RAIL,
      // The nav row's label span carries NO size or weight of its own — only tracking. Both come
      // from the enclosing <Link> (`text-phx-md font-semibold`), so the effective type has to be
      // resolved the way CSS resolves it, by pairing the span with that Link.
      //
      // This matcher used to require `text-phx-` ON the span line, which selected the two spans
      // that DO carry it — the section heading and the search-result row, both `font-bold` — and
      // never the nav row at all. That is how the model came to say 700 while every rail row
      // shipped at 600: the guard was green because it was comparing the model against a
      // different element. Requiring the ABSENCE of `text-phx-` is what picks the inheriting row.
      find: (src: string) => {
        const lines = src.split("\n");
        const link = lines.find(
          (l) => l.includes("relative flex w-full items-center") && l.includes("text-phx-"),
        );
        return lines
          .filter((l) => l.includes("min-w-0 flex-1 truncate") && !l.includes("text-phx-"))
          .map((span) => `${link ?? ""} ${span}`);
      },
      modelled: metrics.match(/LABEL_FONT_CSS\s*=\s*`font-size:(\d+)px;font-weight:(\d+)/),
    },
    {
      shell: "portal",
      file: PORTAL_RAIL,
      // Desktop label span; the line is `isMobile ? "<mobile>" : "<desktop>"`, so take the branch
      // after the colon — the collapsed icon rail renders no labels and the mobile sheet is not
      // what PORTAL_LABEL_FONT_CSS models.
      find: (src: string) =>
        src
          .split("\n")
          .filter((l) => l.includes("isMobile ?") && l.includes("text-phx-"))
          .map((l) => l.slice(l.lastIndexOf(":"))),
      modelled: metrics.match(/PORTAL_LABEL_FONT_CSS\s*=\s*`font-size:(\d+)px;font-weight:(\d+)/),
    },
    {
      shell: "bottom bar",
      file: BOTTOM_BAR,
      // The mobile bar carries its type on the <Link>, not on the label span — the span inherits —
      // so match the row that actually declares it. A third surface with a third type scale: 10px
      // at weight 900, the smallest and heaviest of the three, which is exactly why it could not
      // borrow either rail's measurement.
      find: (src: string) =>
        src.split("\n").filter((l) => l.includes("text-phx-") && l.includes("font-black")),
      modelled: metrics.match(/BOTTOM_BAR_LABEL_FONT_CSS\s*=\s*`font-size:(\d+)px;font-weight:(\d+)/),
    },
  ];

  for (const rail of rails) {
    const src = readFileSync(rail.file, "utf8");
    const spans = rail.find(src);
    assert.ok(
      spans.length > 0,
      `Could not find the ${rail.shell} rail's label span in ${rail.file}. This test pins it by the ` +
        `class pattern, so a re-styled span needs the matcher re-pointed here — do not delete the ` +
        `assertion, or the width guard goes back to measuring whatever it likes.`,
    );
    assert.ok(rail.modelled, `${METRICS} must declare a font-size and font-weight for the ${rail.shell} label`);

    const modelledSize = Number(rail.modelled[1]);
    const modelledWeight = Number(rail.modelled[2]);

    for (const classes of spans) {
      const actual = renderedType(classes, tokens);

      assert.equal(
        actual.size,
        modelledSize,
        `The ${rail.shell} rail renders its label at ${actual.size}px but ${METRICS} measures it at ` +
          `${modelledSize}px.\n  rendered: ${classes.trim().slice(0, 120)}\nEvery width in ` +
          `tests/fixtures/sidebar-label-widths.json is wrong by that difference. Fix the model, then ` +
          `re-run \`pnpm run ui:measure-sidebar-labels\`.`,
      );
      assert.equal(
        actual.weight,
        modelledWeight,
        `The ${rail.shell} rail renders its label at weight ${actual.weight} but ${METRICS} measures ` +
          `it at ${modelledWeight}.\n  rendered: ${classes.trim().slice(0, 120)}\nA heavier face is ` +
          `wider, so the budget check is generous by exactly the amount nobody measured — this is the ` +
          `600-vs-700 bug that hid for three months. Fix the model, then re-run ` +
          `\`pnpm run ui:measure-sidebar-labels\`.`,
      );
    }
  }
}
