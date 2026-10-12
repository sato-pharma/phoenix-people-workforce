import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The Phoenix watermark in the admin identity banner is measured off the SATO logo below it, and
// the name and rule under it are measured off the watermark.
//
// The owner, 2026-09-04: "make the Phoenix logo in the identity banner same size as sato pharma
// logo and at the same of it. But this is below. This is above." The two marks sit in stacked
// bands on /admin and /admin/hr-command-center, so the phoenix is sized and columned to match the
// SATO mark rather than to any number of its own. Later the same day, on the rule: "it's under the
// name ... I wanted to end before it reached the logo", then "the name too", and finally — after
// seeing what that cost the name on a phone — "in HRS or identity banner make the Phoenix logo
// small at the upper right corner in mobile view."
//
// SO THERE ARE TWO MARKS, one per breakpoint, and every number below is derived per breakpoint.
//
// WHY THIS IS PINNED AT ALL. None of the parts can see the others at runtime — they live in two
// components and one PNG — so every coupling is invisible in the files themselves, and each number
// looks arbitrary enough to "tidy". Four things break it silently:
//   1. rounding 25px or -11px, which are the SATO column and the PNG's own transparent margin
//      subtracted from each other, not nudges;
//   2. resizing or re-spacing the SATO logo in the band below, which is where 128/25 came from;
//   3. changing an emblem without moving the name's and rule's clearance, which puts them back
//      across the phoenix — the exact thing the owner asked to stop;
//   4. re-merging the two marks into one, which restores the phone collision he asked to end.
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

/** The name and the rule have to stop clear of the mark, not merely short of it. */
const MIN_GAP_PX = 8;

/**
 * One entry per drawn mark. `wrapperPr` is the content wrapper's own right padding, which the name
 * and rule already stop at, so their margins are stated net of it. `waveTop` is where the wave's
 * box starts on that bar — a mark whose feet reach it stands behind it.
 */
const BREAKPOINTS = {
  mobile: {
    barHeight: 120,
    marginPattern: /(?:^|\s)mr-\[(\d+)px\]/,
    pinned: { height: 64, right: 4, top: 0 },
    visibility: "sm:hidden",
    waveTop: 90,
    wrapperPr: 16,
  },
  sm: {
    // 160px since 2026-10-12 — the portrait grew to 136px on the owner's "i want the photo bigger
    // clear obvious", and the bar grew by exactly what it needed. The wave is a fixed 30px band at
    // the bottom, so its box starts 30px above the bar's foot and the mark has MORE room than it
    // had at 136, not less.
    barHeight: 160,
    marginPattern: /\bsm:mr-\[(\d+)px\]/,
    pinned: { height: 128, right: 25, top: -11 },
    visibility: "hidden sm:block",
    waveTop: 130,
    wrapperPr: 24,
  },
} as const;

type BreakpointKey = keyof typeof BREAKPOINTS;

const EMBLEM_TAG =
  /<img\b[^>]*?className="([^"]*)"[^>]*?src="\/brand\/identity-strip-emblem\.png"[^>]*?style=\{\{([^}]*)\}\}/g;

function read(file: string) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

function styleNumber(style: string, property: string): number {
  return Number(new RegExp(`${property}: "(-?\\d+)px",`).exec(style)?.[1] ?? NaN);
}

export function runIdentityStripEmblemTests() {
  const strip = read(STRIP);

  // TWO elements, one per breakpoint. It was one while the sizes matched; they stopped matching
  // when the owner asked for a small corner mark on a phone, and an inline style cannot carry a
  // media query. A third copy, or a lost one, means someone re-merged them without saying why.
  const emblemTags = strip.match(/src="\/brand\/identity-strip-emblem\.png"/g) ?? [];
  assert.equal(
    emblemTags.length,
    2,
    "the identity strip must draw the emblem twice — a small corner mark on a phone and the "
      + "SATO-columned one from `sm` up. See the comment above them.",
  );

  const drawn = new Map<BreakpointKey, { height: number; right: number; top: number }>();
  for (const [, classes, style] of strip.matchAll(EMBLEM_TAG)) {
    const key: BreakpointKey | undefined = classes.includes(BREAKPOINTS.sm.visibility)
      ? "sm"
      : classes.includes(BREAKPOINTS.mobile.visibility)
        ? "mobile"
        : undefined;
    assert.ok(
      key,
      `an emblem carries neither breakpoint's visibility class (${classes}) — both marks would `
        + "then draw at once, one on top of the other",
    );
    assert.ok(!drawn.has(key), `two emblems claim the same breakpoint (${key})`);
    drawn.set(key, {
      height: styleNumber(style, "height"),
      right: styleNumber(style, "right"),
      top: styleNumber(style, "top"),
    });
  }

  const ruleRow = /<span aria-hidden="true" className="([^"]*mt-\[2px\][^"]*)">/.exec(strip)?.[1];
  assert.ok(ruleRow, "the rule row under the name is no longer findable — its clearance cannot be checked");
  const nameBox = /className="(italic font-medium[^"]*)"/.exec(strip)?.[1];
  assert.ok(nameBox, "the name paragraph is no longer findable — its clearance cannot be checked");

  // The name's margin RESET is inline and its right margin is a CLASS, and that split is load
  // bearing: an inline style beats a class, so restoring the `margin: 0` shorthand would swallow
  // the margin below and put the name back under the phoenix with every assertion here still green.
  assert.ok(
    strip.includes("marginBlock: 0,") && strip.includes("marginLeft: 0,"),
    "the name's inline margin reset must stay split into longhands — a `margin: 0` shorthand "
      + "overrides the right margin that keeps the name clear of the phoenix, silently",
  );

  const inkLeftInsets = {} as Record<BreakpointKey, number>;
  const inkRightInsets = {} as Record<BreakpointKey, number>;

  for (const key of Object.keys(BREAKPOINTS) as BreakpointKey[]) {
    const spec = BREAKPOINTS[key];
    const mark = drawn.get(key);
    assert.ok(mark, `no emblem is drawn at ${key} — the identity bar loses its watermark there`);

    for (const property of ["height", "right", "top"] as const) {
      assert.equal(
        mark[property],
        spec.pinned[property],
        `the ${key} emblem's ${property} must stay ${spec.pinned[property]}px: it is `
          + (key === "sm"
            ? "the SATO logo's size and column minus the PNG's own transparent margin"
            : "that mark halved and set into the corner on the text column's own gutter")
          + ", not a free number",
      );
    }

    // The mark must stay WHOLE. `top` is negative on the desktop mark on purpose (the file's top
    // 14.8% is transparent), but past -19px the crown is cut off by the section's overflow-hidden,
    // and a cropped mark is the one thing the owner has already turned down.
    const inkTop = mark.top + mark.height * INK.top;
    assert.ok(
      inkTop >= 0,
      `the ${key} emblem's top (${mark.top}px) would clip the phoenix — ${mark.height}px carries `
        + `${(mark.height * INK.top).toFixed(1)}px of transparency above the ink`,
    );

    // And it must clear the wave on its own bar.
    const inkBottom = mark.top + mark.height * INK.bottom;
    assert.ok(
      inkBottom <= spec.waveTop,
      `the ${key} emblem's feet (y=${inkBottom.toFixed(1)}px) stand behind the wave, which starts `
        + `at y=${spec.waveTop} on a ${spec.barHeight}px bar`,
    );

    inkRightInsets[key] = mark.right + mark.height * (1 - INK.right);
    inkLeftInsets[key] = inkRightInsets[key] + mark.height * (INK.right - INK.left);
  }

  // "Small, at the upper right corner" — the instruction itself, pinned in both halves, because
  // either one alone reads as already satisfied by the desktop mark.
  const phone = drawn.get("mobile");
  const desktop = drawn.get("sm");
  assert.ok(phone && desktop, "both marks must be readable before they can be compared");
  assert.ok(
    phone.height < desktop.height,
    "the phone mark must stay SMALLER than the desktop one — the owner asked for a small mark on "
      + "a phone precisely because the full-size one crushed the name beside it",
  );
  assert.ok(
    inkRightInsets.mobile < inkRightInsets.sm,
    "the phone mark must sit further into the CORNER than the desktop one, which is columned on "
      + "the SATO logo instead",
  );
  assert.ok(
    phone.top + phone.height * INK.bottom <= BREAKPOINTS.mobile.barHeight / 2,
    "the phone mark must sit in the UPPER half of the bar — 'the upper right corner', his words",
  );

  // THE NAME AND THE RULE BOTH STOP BEFORE THE MARK — the owner asked for each in turn ("I wanted
  // to end before it reached the logo", then "the name too, end it before the logo"), and this is
  // the one thing here that a change to either emblem breaks from a distance.
  for (const [element, classes] of [
    ["rule", ruleRow],
    ["name", nameBox],
  ] as const) {
    for (const key of Object.keys(BREAKPOINTS) as BreakpointKey[]) {
      const spec = BREAKPOINTS[key];
      const margin: number = Number(spec.marginPattern.exec(classes ?? "")?.[1] ?? NaN);
      assert.ok(
        Number.isFinite(margin),
        `the ${element} lost its ${key} right margin — it then runs across the phoenix`,
      );
      const endsAt = margin + spec.wrapperPr;
      assert.ok(
        endsAt >= inkLeftInsets[key] + MIN_GAP_PX,
        `at ${key} the ${element} ends ${endsAt}px in from the trailing edge but the phoenix's ink `
          + `starts ${inkLeftInsets[key].toFixed(2)}px in — it needs `
          + `${(inkLeftInsets[key] + MIN_GAP_PX - endsAt).toFixed(2)}px more clearance. Re-derive it `
          + "from that breakpoint's emblem height/right; do not shrink the gap.",
      );
    }
  }

  // The margins above are stated NET of the wrapper's own padding, so that padding is part of the
  // sum and cannot drift silently.
  assert.ok(
    strip.includes("top-0 z-10 flex min-w-0 items-center gap-4 pr-4 sm:pl-6 sm:pr-6"),
    "the content wrapper's right padding changed — the name's and rule's margins are their "
      + `clearance minus it (${BREAKPOINTS.mobile.wrapperPr}px on a phone, `
      + `${BREAKPOINTS.sm.wrapperPr}px from sm up), so both must be re-derived`,
  );

  // The other half of the coupling: the logo the desktop numbers were measured against.
  const band = read(SATO_BAND);
  assert.ok(
    band.includes('className="mr-[28px] h-8 w-auto shrink-0"'),
    "the SATO band logo changed size or spacing — the identity strip's emblem is measured off it "
      + `(h-8 = 32px box, 79.0px of ink across, 28px clear of the band's edge), so re-measure ${STRIP}`,
  );
}
