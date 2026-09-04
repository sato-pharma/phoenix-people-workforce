import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The Phoenix watermark in the admin identity banner is measured off the SATO logo below it, and
// the rule under the name is measured off the watermark.
//
// The owner, 2026-09-04: "make the Phoenix logo in the identity banner same size as sato pharma
// logo and at the same of it. But this is below. This is above." The two marks sit in stacked
// bands on /admin and /admin/hr-command-center, so the phoenix is sized and columned to match the
// SATO mark rather than to any number of its own. Later the same day, on the rule: "it's under the
// name ... I wanted to end before it reached the logo."
//
// WHY THIS IS PINNED AT ALL. None of the three parts can see the others at runtime — they live in
// two components and one PNG — so every coupling is invisible in the files themselves, and each
// number looks arbitrary enough to "tidy". Three things break it silently:
//   1. rounding 25px or -11px, which are the SATO column and the PNG's own transparent margin
//      subtracted from each other, not nudges;
//   2. resizing or re-spacing the SATO logo in the band below, which is where 128/25 came from;
//   3. changing the emblem without moving the rule's clearance, which puts the orange tail back
//      across the phoenix — the exact thing the owner asked to stop.
// Measured in the browser at 1440px on 2026-09-04: phoenix ink 79.0px wide against SATO ink
// 79.0px, right edges 0.3px apart. It is the WIDTH the two share — the marks are different shapes,
// and matching their heights is what the owner rejected as "still very small".
// ─────────────────────────────────────────────────────────────────────────────

const STRIP = "src/components/phoenix-signature-card/PhoenixIdentityStrip.tsx";
const SATO_BAND = "src/components/admin/ceo-command-center.tsx";

/**
 * `/public/brand/identity-strip-emblem.png` is 512x512 with the visible mark at x 97..412,
 * y 76..403. Measured from the file's alpha channel, not assumed — a CSS `height` here sizes the
 * BOX, and the box is 36% empty.
 */
const INK = { bottom: 403 / 512, left: 97 / 512, right: 412 / 512, top: 76 / 512 };

/** The content wrapper's own right padding, which the rule's column already stops at. */
const WRAPPER_PR = { mobile: 16, sm: 24 };

/** The rule has to stop clear of the mark, not merely short of it. */
const MIN_GAP_PX = 8;

function read(file: string) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

export function runIdentityStripEmblemTests() {
  const strip = read(STRIP);

  // ONE element. It was two, one per breakpoint, back when the sizes differed; they no longer do,
  // because `h-8` is `h-8` on a phone. A second copy means someone re-split it without saying why.
  const emblemTags = strip.match(/src="\/brand\/identity-strip-emblem\.png"/g) ?? [];
  assert.equal(
    emblemTags.length,
    1,
    "the identity strip must draw the emblem once, at both breakpoints — see the comment above it",
  );

  for (const [property, value] of [
    ["height", '"128px"'],
    ["right", '"25px"'],
    ["top", '"-11px"'],
  ] as const) {
    assert.ok(
      strip.includes(`${property}: ${value},`),
      `the emblem's ${property} must stay ${value}: it is the SATO logo's size/column minus the `
        + "PNG's own transparent margin, not a free number",
    );
  }

  const height: number = Number(/height: "(\d+)px",/.exec(strip)?.[1] ?? NaN);
  const right: number = Number(/right: "(\d+)px",/.exec(strip)?.[1] ?? NaN);
  const top: number = Number(/top: "(-?\d+)px",/.exec(strip)?.[1] ?? NaN);
  assert.ok(
    Number.isFinite(height) && Number.isFinite(right) && Number.isFinite(top),
    "the emblem's three inline numbers must stay readable — everything below is derived from them",
  );

  // The mark must stay WHOLE. `top` is negative on purpose (the file's top 14.8% is transparent),
  // but past -19px the phoenix's crown is cut off by the section's overflow-hidden, and a cropped
  // mark is the one thing the owner has already turned down.
  const inkTopOffset = height * INK.top;
  assert.ok(
    top + inkTopOffset >= 0,
    `the emblem's top (${top}px) would clip the phoenix — ${height}px carries ${inkTopOffset.toFixed(1)}px `
      + "of transparency above the ink",
  );

  // And it must clear the wave ON A PHONE, which is the tighter of the two bars: 120px tall with
  // the wave's box starting at y=90.
  const inkBottom = top + height * INK.bottom;
  assert.ok(
    inkBottom <= 90,
    `the emblem's feet (y=${inkBottom.toFixed(1)}px) stand behind the wave on a 120px mobile bar`,
  );

  // THE RULE UNDER THE NAME MUST END BEFORE THE MARK — the owner's instruction, and the one thing
  // here that a change to the emblem breaks from a distance. The mark's ink starts this far in
  // from the bar's trailing edge:
  const inkLeftInset = right + height * (1 - INK.left);
  const ruleRow = /<span aria-hidden="true" className="([^"]*mt-\[2px\][^"]*)">/.exec(strip)?.[1];
  assert.ok(ruleRow, "the rule row under the name is no longer findable — its clearance cannot be checked");

  for (const [label, pattern, padding] of [
    ["mobile", /(?:^|\s)mr-\[(\d+)px\]/, WRAPPER_PR.mobile],
    ["sm", /\bsm:mr-\[(\d+)px\]/, WRAPPER_PR.sm],
  ] as const) {
    const margin: number = Number(pattern.exec(ruleRow ?? "")?.[1] ?? NaN);
    assert.ok(
      Number.isFinite(margin),
      `the rule row lost its ${label} right margin — the orange tail then runs across the phoenix`,
    );
    const ruleEndsAt = margin + padding;
    assert.ok(
      ruleEndsAt >= inkLeftInset + MIN_GAP_PX,
      `at ${label} the rule ends ${ruleEndsAt}px in from the trailing edge but the phoenix's ink starts `
        + `${inkLeftInset.toFixed(2)}px in — it needs ${(inkLeftInset + MIN_GAP_PX - ruleEndsAt).toFixed(2)}px `
        + "more clearance. Re-derive it from the emblem's height/right; do not shrink the gap.",
    );
  }

  // The margins above are stated NET of the wrapper's own padding, so that padding is part of the
  // sum and cannot drift silently.
  assert.ok(
    strip.includes("top-0 z-10 flex min-w-0 items-center gap-4 pr-4 sm:pl-6 sm:pr-6"),
    `the content wrapper's right padding changed — the rule's ${WRAPPER_PR.mobile}/${WRAPPER_PR.sm}px `
      + "margins are 141 minus it, so both must be re-derived",
  );

  // The other half of the coupling: the logo the numbers were measured against.
  const band = read(SATO_BAND);
  assert.ok(
    band.includes('className="mr-[28px] h-8 w-auto shrink-0"'),
    "the SATO band logo changed size or spacing — the identity strip's emblem is measured off it "
      + `(h-8 = 32px box, 79.0px of ink across, 28px clear of the band's edge), so re-measure ${STRIP}`,
  );
}
