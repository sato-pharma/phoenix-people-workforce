import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { cssColourToRgba, measurePageCall, summarizeMeasurements } from "../scripts/phoenix-inspect/lib/measure.mjs";

type Rgba = { r: number; g: number; b: number; a: number };

/**
 * Phoenix Visual Intelligence: the explorer's in-page measurement reads colours the way the browser
 * computes them. Chrome returns `lab()` and `oklch()` for the app's Tailwind v4 colours, and a reader that
 * understood only `rgb()` scored every heading at contrast 1.0 and skipped the slate text altogether.
 * These pin the converter against reference values, prove it still runs once rebuilt from its own source
 * (the copy sent into the page), and pin the two rules the measurement depends on: text whose colour
 * or ground cannot be read is counted as unmeasured, never scored against a guessed white; and a closed
 * drawer's links (inert, aria-hidden, slid off-screen) are not counted as tap targets.
 */
export function runPhoenixInspectMeasureTests() {
  const near = (value: string, expected: [number, number, number, number?], convert = cssColourToRgba) => {
    const got = convert(value) as Rgba | null;
    assert.ok(got, `${value} is read`);
    const [r, g, b, a = 1] = expected;
    for (const [channel, want] of [["r", r], ["g", g], ["b", b]] as const) {
      assert.ok(Math.abs(got[channel] - want) <= 2, `${value} ${channel}: ${got[channel]} is within 2 of ${want}`);
    }
    assert.ok(Math.abs(got.a - a) <= 0.01, `${value} alpha: ${got.a} is ${a}`);
  };

  const references: Array<[string, [number, number, number, number?]]> = [
    ["rgb(148, 163, 184)", [148, 163, 184]],
    ["rgba(0, 0, 0, 0.5)", [0, 0, 0, 0.5]],
    ["rgb(148 163 184 / 0.5)", [148, 163, 184, 0.5]],
    ["#94a3b8", [148, 163, 184]],
    ["#fff", [255, 255, 255]],
    ["white", [255, 255, 255]],
    ["transparent", [0, 0, 0, 0]],
    ["lab(50 0 0)", [119, 119, 119]],
    ["lab(100 0 0)", [255, 255, 255]],
    ["lab(15 0 0)", [38, 38, 38]],
    ["lab(54.2917 80.8125 69.8851)", [255, 0, 0]],
    ["lch(54.2917 106.839 40.8526)", [255, 0, 0]],
    ["oklch(0.62796 0.25768 29.2339)", [255, 0, 0]],
    ["oklch(0.704 0.04 256.788)", [144, 161, 185]],
    ["oklch(70.4% 0.04 256.788)", [144, 161, 185]],
    ["oklab(1 0 0)", [255, 255, 255]],
    ["color(srgb 1 0 0)", [255, 0, 0]],
    ["color(display-p3 1 0 0)", [255, 0, 0]],
    ["color(srgb-linear 0.2140 0.2140 0.2140)", [128, 128, 128]],
  ];
  for (const [value, expected] of references) near(value, expected);

  for (const unread of ["currentcolor", "", "not-a-colour", "rgb(a b c)", "#12", "color(rec2020 1 0 0)"]) {
    assert.equal(cssColourToRgba(unread), null, `"${unread}" is reported unreadable, never guessed`);
  }

  // The page receives the converter as source text, so it must run with no outer reference.
  const rebuilt = new Function(`return (${cssColourToRgba.toString()})`)() as typeof cssColourToRgba;
  for (const [value, expected] of references) near(value, expected, rebuilt);

  // The expression page.evaluate runs is valid JavaScript and hands the options through.
  const call = measurePageCall({ mobile: true });
  assert.doesNotThrow(() => new Function(`return () => ${call}`), "the evaluate expression parses");
  assert.ok(call.includes('{"mobile":true}'), "the viewport option reaches the page");
  assert.ok(call.includes("function cssColourToRgba"), "the converter travels with the measurement");

  const summary = summarizeMeasurements({
    overflow: { document: 0, main: 3 },
    rounded: { count: 1 },
    ellipsis: { count: 0 },
    fontSizes: { "14px": 2, "12px": 1 },
    colours: { nonTokenText: {}, nonTokenBackground: { x: 1 } },
    tapTargets: { checked: false, count: 9 },
    contrast: { count: 2, measured: 40, unmeasured: 5 },
    scrollers: [],
  });
  assert.equal(summary.horizontalOverflowPx, 3);
  assert.equal(summary.smallTapTargets, null, "a desktop shot reports no tap-target count");
  assert.equal(summary.lowContrastText, 2);
  assert.equal(summary.contrastUnmeasured, 5, "unmeasured contrast is reported beside the count");

  const source = readFileSync(new URL("../scripts/phoenix-inspect/lib/measure.mjs", import.meta.url), "utf8");
  const pageSource = source.slice(source.indexOf("export function measurePage("));
  assert.ok(!/match\(\/rgba\?/.test(source), "no rgb-only colour reader is left");
  assert.ok(/toRgba\(key\)/.test(pageSource), "every colour the page reads goes through the converter");
  assert.ok(/if \(!colour\) return null;/.test(pageSource), "an unreadable ground stops the walk instead of guessing white");
  assert.ok(/backgroundImage !== "none"\) return null/.test(pageSource), "a gradient or picture ground is unmeasured");
  assert.ok(/out\.contrast\.unmeasured \+= 1/.test(pageSource), "unreadable text is counted as unmeasured");
  assert.ok(/mobile && reachable\(element, box\) && element\.matches/.test(pageSource), "tap targets count only what a person can reach");
  assert.ok(/closest\('\[inert\], \[aria-hidden="true"\]'\)/.test(pageSource), "an inert or aria-hidden subtree is not reachable");
}
