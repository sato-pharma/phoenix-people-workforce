import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Every tone the one Badge device offers must be READABLE, in BOTH themes.
//
// This exists because the failure is silent. A badge whose text sits at 2.55:1
// on its own fill renders perfectly, throws nothing, breaks no build, and is
// simply hard to read — which is how the `accent` tone got as far as a working
// component before being measured. TypeScript cannot see contrast, and
// `next.config` sets `ignoreBuildErrors: true`, so a type-level constraint would
// not have gated it either (AGENTS.md: an exhaustive Record does NOT gate the
// build). The check has to be arithmetic, at runtime, in a registered test.
//
// It reads the REAL sources — the TONE map in badge.tsx and the token values in
// tokens.css — so it also catches someone darkening a -bg token later and
// quietly pushing an existing tone under the line.
// ─────────────────────────────────────────────────────────────────────────────

const BADGE = "src/components/ui/badge.tsx";
const TOKENS = "src/styles/tokens.css";

/** WCAG AA for text under ~18px. Badge text is 9–10px, so this is the right bar. */
const AA_SMALL_TEXT = 4.5;

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.substr(i, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Parse one CSS block's `--phx-*: #hex;` declarations into a map. */
function tokensIn(css: string, startSelector: string): Map<string, string> {
  const start = css.indexOf(startSelector);
  assert.ok(start !== -1, `${startSelector} block is missing from ${TOKENS}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  const block = css.slice(open, close);
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--phx-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out.set(m[1], m[2].toLowerCase());
  }
  return out;
}

export function runBadgeToneContrastTests() {
  const badge = readFileSync(BADGE, "utf8");
  const css = readFileSync(TOKENS, "utf8");

  // ── the tones the device actually offers ──────────────────────────────────
  const mapMatch = badge.match(/const TONE: Record<BadgeTone, string> = \{([\s\S]*?)\n\};/);
  assert.ok(mapMatch, "could not find the TONE map in badge.tsx — this test is reading the wrong shape");

  const tones = new Map<string, { fg: string; bg: string }>();
  for (const m of mapMatch[1].matchAll(/(\w+):\s*"([^"]+)"/g)) {
    const classes = m[2];
    const bg = classes.match(/\bbg-phx-([a-z0-9-]+)/)?.[1];
    const fg = classes.match(/\btext-phx-([a-z0-9-]+)/)?.[1];
    assert.ok(bg && fg, `tone "${m[1]}" is missing a bg-phx-* or text-phx-* class`);
    tones.set(m[1], { fg: `--phx-${fg}`, bg: `--phx-${bg}` });
  }

  assert.ok(tones.size >= 4, `only ${tones.size} tones parsed — the TONE map shape changed`);

  // Every member of the BadgeTone union must have an entry. A missing key compiles
  // (ignoreBuildErrors) and renders an undefined class string at runtime.
  const union = badge.match(/export type BadgeTone =\s*([^;]+);/)?.[1] ?? "";
  const declared = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length > 0, "could not parse the BadgeTone union");
  for (const tone of declared) {
    assert.ok(tones.has(tone), `BadgeTone declares "${tone}" but the TONE map has no entry for it`);
  }
  for (const tone of tones.keys()) {
    assert.ok(declared.includes(tone), `the TONE map has "${tone}" but BadgeTone does not declare it`);
  }

  // ── measure, in both themes ───────────────────────────────────────────────
  const themes: Array<[string, Map<string, string>]> = [
    ["light", tokensIn(css, ":root {")],
    ["dark", tokensIn(css, ".dark {")],
  ];

  const failures: string[] = [];
  for (const [themeName, vars] of themes) {
    for (const [tone, { fg, bg }] of tones) {
      const fgHex = vars.get(fg);
      const bgHex = vars.get(bg);
      assert.ok(fgHex, `${themeName}: token ${fg} (tone "${tone}") is not defined`);
      assert.ok(bgHex, `${themeName}: token ${bg} (tone "${tone}") is not defined`);
      const ratio = contrastRatio(fgHex, bgHex);
      if (ratio < AA_SMALL_TEXT) {
        failures.push(
          `  ${themeName}/${tone}: ${fgHex} on ${bgHex} = ${ratio.toFixed(2)}:1 (needs ${AA_SMALL_TEXT})`,
        );
      }
    }
  }

  assert.equal(
    failures.length,
    0,
    `Badge tone(s) below WCAG AA for small text:\n${failures.join("\n")}\n\n` +
      `Badge text is 9-10px uppercase, so ${AA_SMALL_TEXT}:1 is the right bar. Either darken the ` +
      `-bg token, darken the text token, or drop the tone — a brand colour is not a status meaning.`,
  );
}
