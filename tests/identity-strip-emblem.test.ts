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
const NOTICES = "src/components/phoenix-signature-card/PhoenixIdentityNotices.tsx";
const SATO_BAND = "src/components/admin/ceo-command-center.tsx";

/**
 * `/public/brand/identity-strip-emblem.png` is 512x512 with the visible mark at x 97..412,
 * y 76..403. Measured from the file's alpha channel, not assumed — a CSS `height` here sizes the
 * BOX, and the box is 36% empty.
 */
const INK = { bottom: 403 / 512, left: 97 / 512, right: 412 / 512, top: 76 / 512 };

/**
 * `/public/brand/identity-watermark.png` — the WITH-PHOTO mark, and a different file from the badge
 * above it. 1350x900, corners fully transparent, ink at x 361..969 and y 114..746, drawn in
 * rgba(255,238,222,0.18). Measured from its own alpha channel in the browser on 2026-10-12, not
 * assumed: the box is 55% empty across and 29% empty down, so a CSS `height` here is not the size of
 * the phoenix anyone sees. It is the same file `PhoenixSignatureCard` draws.
 */
const WASH_INK = { bottom: 747 / 900, left: 361 / 1350, right: 970 / 1350, top: 114 / 900 };
const WASH_ASPECT = 1350 / 900;

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
    // The desktop margin is `--phx-text-gap` with the no-photo number as its fallback, since
    // 2026-10-12: with a photo the clearance has to track a portrait whose width is a viewport
    // clamp. This reads the FALLBACK, which is the no-photo path the numbers below belong to; the
    // with-photo gap is checked against `PORTRAIT_SCALE` at the bottom of this file.
    marginPattern: /\bsm:mr-\[var\(--phx-text-gap,(\d+)px\)\]/,
    pinned: { height: 128, right: 25, top: -11 },
    visibility: "hidden sm:block",
    waveTop: 130,
    wrapperPr: 24,
  },
} as const;

type BreakpointKey = keyof typeof BREAKPOINTS;

/**
 * `style` is an inline object on one mark and a NAMED CONSTANT on the other, since 2026-10-12: the
 * desktop mark's ink became `var()`-driven (filter, blend and opacity as well as the three
 * positions), and an inline object that long sat between the comment and the tag it belongs to. Both
 * spellings are matched here, and `styleBody` resolves the named one, so neither shape can quietly
 * drop out of this test by being refactored.
 */
const EMBLEM_TAG =
  /<img\b[^>]*?className="([^"]*)"[^>]*?src="\/brand\/identity-strip-emblem\.png"[^>]*?style=\{(\{[^}]*\}|[A-Z][A-Z_]+)\}/g;

function read(file: string) {
  return readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
}

/** The inline object itself, or the body of the `as CSSProperties` constant the tag names. */
function styleBody(strip: string, token: string): string {
  if (token.startsWith("{")) return token;
  return new RegExp(`const ${token} = \\{([\\s\\S]*?)\\} as CSSProperties;`).exec(strip)?.[1] ?? "";
}

/**
 * Reads a pinned pixel number out of the emblem's inline style.
 *
 * FROM 2026-10-12 THE DESKTOP MARK'S THREE NUMBERS ARE `var(--phx-mark-*, Npx)`, and the FALLBACK
 * is what this reads — deliberately. The fallback is the no-photo path, which is still exactly the
 * owner's 2026-09-04 SATO-column placement, so every assertion below goes on holding that rule
 * where it still applies. The with-photo values live in `PORTRAIT_SCALE` and are checked separately
 * at the bottom of this file, against their own instruction.
 */
function styleNumber(style: string, property: string): number {
  const plain = new RegExp(`${property}: "(-?\\d+)px",`).exec(style)?.[1];
  if (plain !== undefined) return Number(plain);
  const fallback = new RegExp(`${property}: "var\\(--[a-z-]+, ?(-?\\d+)px\\)",`).exec(style)?.[1];
  return Number(fallback ?? NaN);
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
    const body = styleBody(strip, style);
    assert.ok(
      body.length > 0,
      `the ${key} emblem's style is a constant this test cannot resolve (${style}) — its numbers `
        + "are then unpinned, which is the whole point of this file",
    );
    drawn.set(key, {
      height: styleNumber(body, "height"),
      right: styleNumber(body, "right"),
      top: styleNumber(body, "top"),
    });
  }

  // `\s+` between the attributes, not a space: the class list outgrew one line when the desktop
  // margin became a `var()`, and a prettier line break here must not read as a missing rule.
  const ruleRow = /<span\s+aria-hidden="true"\s+className="([^"]*mt-\[2px\][^"]*)"/.exec(strip)?.[1];
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

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE STANDING PORTRAIT, AND THE MARK THAT COMES OUT FROM BEHIND IT.
  //
  // The owner, 2026-10-12: "MAKE THE PICTURE BIGGER AND MAKE IT RESPONSIVE BASED ON VIEW SIZE AND
  // SHOW THE PHX LOGO FROM BEHIND AS A WATERMARK." Everything here is one clamp and four `calc`s
  // off it (`PORTRAIT_SCALE`), so the only way the shape can break is for one of those numbers to
  // be edited alone. That is exactly what this block refuses.
  //
  // It is checked SYMBOLICALLY, at both ends of the clamp, because there is no viewport in a unit
  // test: every property below is stated against W, so if it holds at the clamp's floor and its
  // ceiling it holds at every width between them.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  const scale = /const PORTRAIT_SCALE = \{([\s\S]*?)\} as CSSProperties;/.exec(strip)?.[1];
  assert.ok(scale, "PORTRAIT_SCALE is gone — the standing portrait's whole scale is unpinned");

  const clamp = /"--phx-portrait-w": "clamp\((\d+)px, (\d+)vw, (\d+)px\)"/.exec(scale);
  assert.ok(clamp, "the portrait width must stay a `clamp(min, vw, max)` — a fixed width is the "
    + "thing the owner asked to replace ('MAKE IT RESPONSIVE BASED ON VIEW SIZE')");
  const [minW, vw, maxW] = clamp.slice(1, 4).map(Number);
  assert.ok(
    minW >= 188 && maxW > minW && vw > 0,
    `the clamp must START no smaller than the 188px fixed frame it replaced and GROW from there — `
      + `read ${minW}px / ${vw}vw / ${maxW}px. He asked for bigger, not merely different.`,
  );

  const textGap = Number(
    /"--phx-text-gap": "calc\(var\(--phx-portrait-w\) \+ (\d+)px\)"/.exec(scale)?.[1] ?? NaN,
  );
  const washBack = Number(
    /"--phx-wash-right": "calc\(var\(--phx-portrait-w\) - (\d+)px\)"/.exec(scale)?.[1] ?? NaN,
  );
  for (const [label, value] of [
    ["--phx-text-gap", textGap],
    ["--phx-wash-right", washBack],
  ] as const) {
    assert.ok(
      Number.isFinite(value),
      `${label} is missing or no longer stated against the portrait width — the mark and the text `
        + "then stop moving with the portrait, and the shape silently breaks at some viewport",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE WITH-PHOTO WATERMARK IS A DIFFERENT FILE, AND THAT IS THE FIX ITSELF.
  //
  // The owner rejected the enlarged badge twice on 2026-10-12 — "it feels like its not real or
  // extra zeyada msh mazboota" at full colour, then "watermark mo2ref" greyscaled and multiplied
  // into the paper. Both were the same artwork: `identity-strip-emblem.png` is a hard-edged round
  // BADGE, and a badge enlarged behind a photo reads as a logo or as dirt, never as print.
  // `identity-watermark.png` is a watermark in the file — a pale warm phoenix wash, no ring, no
  // bars, rgba(255,238,222,0.18) ink on full transparency — and it is the mark the employee portal
  // banner draws, which is the surface he pointed this family at in the first place.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  const washTag =
    /photoSrc \? \(\s*(?:\/\*[\s\S]*?\*\/\s*)?<div[\s\S]{0,600}?style=\{WASH_STYLE\}/.exec(strip);
  assert.ok(
    washTag,
    "the with-photo watermark must be the WASH_STYLE box, drawn only when there IS a photo. The "
      + "badge enlarged behind the portrait is the thing the owner turned down twice — at full "
      + "colour and greyscaled — and no third treatment of that file is the answer.",
  );
  const maskDeclarations = strip.match(/maskImage: "url\(\/brand\/identity-watermark\.png\)"/g) ?? [];
  assert.equal(
    maskDeclarations.length,
    1,
    `the watermark's alpha must be declared as a mask ONCE, on a wrapper the paint layers sit `
      + `inside — read ${maskDeclarations.length}. One mask is one decode and one masked composite; `
      + "one per layer is six of each, every frame the strike runs, which is the cost the owner "
      + 'asked not to pay ("without decreasing the performance of the page").',
  );
  assert.ok(
    /WebkitMaskImage: "url\(\/brand\/identity-watermark\.png\)"/.test(strip),
    "the mask needs its `-webkit-` twin for Safari, exactly as the portrait's fade mask has one — "
      + "without it the gloss is an unmasked RECTANGLE of orange on the banner, not a phoenix",
  );
  const washStyle = styleBody(strip, "WASH_STYLE");
  assert.ok(washStyle.length > 0, "WASH_STYLE is gone — the watermark's whole geometry is unpinned");

  // THE GLOW IS HIS, IN HIS OWN WORDS — "glossy and uh, shiny, glowing", then "make it glowing by
  // by its original color, the orange". A drop-shadow is how a glow follows the phoenix's outline
  // instead of boxing it; `grayscale` and a whole-mark `multiply` are the two treatments he
  // rejected by name, and neither may come back here.
  assert.ok(
    /drop-shadow\(/.test(washStyle),
    "the watermark has lost its glow — he asked for it glowing, twice, and a drop-shadow on this "
      + "box is what makes the halo the bird's own shape rather than a rectangle behind it",
  );
  assert.ok(
    !/grayscale\(|blur\(/.test(washStyle),
    "greyscale is the treatment the owner answered with `watermark mo2ref`, and a blur on the whole "
      + "box throws away the feature definition he asked for in the same breath as the colour",
  );
  const washOpacity = Number(/opacity: ([\d.]+)/.exec(washStyle)?.[1] ?? NaN);
  assert.ok(
    washOpacity >= 0.4 && washOpacity <= 0.9,
    `the mark draws at opacity ${washOpacity}. Above 0.9 it is a LOGO sitting on the banner — "it `
      + 'is awful like this. Make it lighter, make it lighter" — and below 0.4 it is the ghost he '
      + "asked to end. It is a watermark, and it has to stay one.",
  );

  // "the part of the upper wing is very is very light" (owner, 2026-10-12). The body ramp runs
  // top-left to bottom-right, so its FIRST stop is the upper wing, and a first stop within a few
  // points of the paper is the complaint itself — restated as arithmetic so it cannot drift back.
  const bodyRamp = styleBody(strip, "WASH_BODY_STYLE");
  const firstStop = /#([0-9a-f]{6})/i.exec(bodyRamp)?.[1];
  assert.ok(firstStop, "WASH_BODY_STYLE no longer starts with a hex stop — the ramp is unreadable");
  const paper = [0xfd, 0xf8, 0xf3];
  const wing = [0, 2, 4].map((i) => Number.parseInt(firstStop!.slice(i, i + 2), 16));
  const wingDistance = Math.max(...paper.map((channel, i) => Math.abs(channel - wing[i])));
  assert.ok(
    wingDistance >= 32,
    `the body ramp starts at #${firstStop}, only ${wingDistance} points off the #fdf8f3 paper on `
      + "its widest channel — that is the washed-out upper wing the owner pointed at. The ramp's "
      + "first stop is the wing, and it has to carry colour.",
  );
  const rampStops = bodyRamp.match(/#[0-9a-f]{6}/gi) ?? [];
  assert.ok(
    rampStops.length >= 3,
    `the ramp has ${rampStops.length} stops. He asked for "two or three colors merged in with each `
      + 'other" and approved the gold -> orange -> teal ramp; a single flat fill is the version '
      + "before that note.",
  );
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE LIGHTNING, AND THE PRICE OF IT.
  //
  // "Make it have a live shading, live shading, but without uh, without decreasing the performance
  // of the page", then, at a first reading that had the whole surface breathing and drifting: "I
  // didn't mean by live shading like this. I mean the logo as it is, and every, for example, uh,
  // five seconds, um, like رعد uh, وبرق." So: the mark is still, one strike crosses it every five
  // seconds, and the only properties that move are the two the compositor can run without a repaint.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  assert.ok(
    /className="phx-wash-strike /.test(strip),
    "the strike layer is gone from the markup — the mark no longer has the lightning he asked for",
  );
  for (const retired of ["phx-wash-breathe", "phx-wash-glint", "phx-wash-sheen"]) {
    assert.ok(
      !strip.includes(retired),
      `\`${retired}\` is back. That is the continuous movement the owner corrected in his own `
        + 'words — "I didn\'t mean by live shading like this. I mean the logo as it is" — and a '
        + "watermark that never stops moving also pulls the eye off the page it sits behind.",
    );
  }

  const css = read("app/globals.css");
  const strikeRule = /\.phx-wash-strike \{([\s\S]*?)\}/.exec(css)?.[1] ?? "";
  const strikeSeconds = Number(/animation: phx-wash-strike ([\d.]+)s/.exec(strikeRule)?.[1] ?? NaN);
  assert.ok(
    strikeSeconds >= 3 && strikeSeconds <= 8,
    `the strike runs every ${strikeSeconds}s. He named the interval himself — "every, for example, `
      + 'uh, five seconds" — and outside this band it is either a flicker or a thing you never see.',
  );

  const strikeFrames = /@keyframes phx-wash-strike \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  assert.ok(strikeFrames.length > 0, "the `phx-wash-strike` keyframes are gone from app/globals.css");
  const animated = [...strikeFrames.matchAll(/^\s{4}([a-z-]+):/gm)].map((match) => match[1]);
  assert.ok(animated.length > 0, "the strike's keyframes declare nothing — it cannot animate");
  const offCompositor = [...new Set(animated)].filter(
    (property) => property !== "opacity" && property !== "transform",
  );
  assert.deepEqual(
    offCompositor,
    [],
    `the strike animates ${offCompositor.join(", ")}. Only \`transform\` and \`opacity\` run on the `
      + "compositor — every other property re-paints a 348x232 masked surface on every frame of "
      + 'every strike, for as long as the page is open, which is the one thing he ruled out: '
      + '"without decreasing the performance of the page".',
  );

  // A STRIKE, NOT A SHIMMER: it has to be dark at the end of the cycle, so the four-and-a-half
  // quiet seconds are real. A keyframe list that never returns to 0 is a permanent highlight.
  assert.ok(
    /100% \{\s*opacity: 0;/.test(strikeFrames),
    "the strike never goes dark — its last keyframe leaves the band lit, which is a permanent "
      + "sheen across the phoenix rather than lightning that comes and goes",
  );
  const litUntil = Math.max(
    ...[...strikeFrames.matchAll(/^\s{2}(\d+)% \{/gm)]
      .map((match) => Number(match[1]))
      .filter((percent) => percent < 100),
  );
  assert.ok(
    litUntil <= 20,
    `the strike is still running ${litUntil}% into its cycle — at ${strikeSeconds}s that is `
      + `${((litUntil / 100) * strikeSeconds).toFixed(1)}s of light. Lightning is a flash and then `
      + "nothing; a pass that fills a fifth of the cycle reads as a sweep, which he turned down.",
  );

  const reducedMotion = /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g;
  const reducedBlocks = css.match(reducedMotion) ?? [];
  assert.ok(
    reducedBlocks.some(
      (block) => block.includes(".phx-wash-strike") && /animation: none/.test(block),
    ),
    "nothing turns the lightning off under `prefers-reduced-motion` — a repeating flash is exactly "
      + "the motion that setting exists to stop, and the mark reads perfectly without it",
  );

  const washHeight = Number(/height: "(\d+)px"/.exec(washStyle)?.[1] ?? NaN);
  const washTop = Number(/top: "(-?\d+)px"/.exec(washStyle)?.[1] ?? NaN);
  assert.ok(
    Number.isFinite(washHeight) && Number.isFinite(washTop),
    "the wash's height and top must stay literal pixels on a bar that is itself a literal height",
  );
  assert.ok(
    washHeight >= BREAKPOINTS.sm.barHeight,
    `the wash must stand at least as tall as the bar (${washHeight}px against `
      + `${BREAKPOINTS.sm.barHeight}px). Scaled to fit between the bar's top and the wave it draws `
      + "72px of ink across, which is the ghost-sized mark he has already rejected once.",
  );
  assert.ok(
    washTop + washHeight * WASH_INK.top >= 0,
    `the wash's crown (y=${(washTop + washHeight * WASH_INK.top).toFixed(1)}px) is cut off by the `
      + "bar's top edge — it bleeds at the FOOT, under the wave, exactly as the sibling card does, "
      + "and nowhere else",
  );

  // "FROM BEHIND" IS TWO FACTS AT ONCE, and one without the other is a different picture: part of
  // the mark must be COVERED by the portrait, and part of it must be CLEAR of it. Both are stated
  // against W, so W cancels and the test is viewport-free.
  const washBoxWidth = washHeight * WASH_ASPECT;
  const inkRightOfMark = washBoxWidth * (1 - WASH_INK.right); // inside its own box, from the right
  const inkWidthOfMark = washBoxWidth * (WASH_INK.right - WASH_INK.left);
  const coveredByPortrait = washBack - inkRightOfMark; // px of ink hidden behind the frame
  const clearOfPortrait = inkWidthOfMark - coveredByPortrait; // px of ink standing on the cream
  assert.ok(
    washBack - inkRightOfMark < inkWidthOfMark,
    "the portrait covers the whole watermark — nothing shows from behind it, which is the state "
      + "the owner asked to end",
  );
  assert.ok(
    coveredByPortrait > 8,
    `the mark is not actually BEHIND the portrait — only ${coveredByPortrait.toFixed(1)}px of its `
      + "ink is covered. It reads as a mark parked beside a photo, not one showing from behind it.",
  );
  assert.ok(
    clearOfPortrait > 24,
    `only ${clearOfPortrait.toFixed(1)}px of the phoenix stands clear of the portrait — at that `
      + "width it is hidden rather than shown, which is the state the owner asked to end",
  );

  // AND THE TEXT STILL STOPS BEFORE IT. This is his 2026-09-04 rule, re-derived: the ink now
  // reaches PAST the frame's leading edge, so clearing the frame is no longer enough.
  assert.ok(
    textGap + BREAKPOINTS.sm.wrapperPr >= clearOfPortrait + MIN_GAP_PX,
    `with a photo the name and rule end ${textGap + BREAKPOINTS.sm.wrapperPr}px past the portrait `
      + `but the phoenix's ink reaches ${clearOfPortrait.toFixed(2)}px past it — they cross the `
      + "mark, which is exactly what the owner asked to stop. Re-derive the gap from the mark.",
  );

  // The portrait, the air under it and the frame are one chain of arithmetic; a reserve that stops
  // matching the portrait's height either overlaps the next section or leaves a hole. Since
  // 2026-10-12 the same element also reserves the portrait's WIDTH, because the band beside it
  // carries the notice centre and would otherwise run under the photo — one element, both jobs.
  const column =
    /height: "calc\(var\(--phx-portrait-h\) - (\d+)px\)",\s*width: "var\(--phx-portrait-w\)"/.exec(strip);
  assert.ok(
    column,
    "the overhang reserve must state BOTH the portrait's height minus the bar and the portrait's "
      + "own width — the height is the air under the photo and the width is what keeps the notice "
      + "band clear of it. One without the other breaks a layout nothing else measures.",
  );
  assert.ok(
    Number(column?.[1]) < BREAKPOINTS.sm.barHeight,
    "the overhang reserve must be the portrait's height minus LESS than the bar's own height — "
      + `anything at or above ${BREAKPOINTS.sm.barHeight} leaves the portrait's foot sitting on the `
      + "next section's top border, which is the collision this reserve exists to prevent",
  );

  // THE NO-PHOTO PATH IS A DIFFERENT INSTRUCTION AND MUST NOT MOVE WITH THIS ONE. With initials
  // there is no standing portrait for a mark to come out from behind, so that path keeps the badge
  // in the SATO column exactly as 2026-09-04 left it — and it keeps its own opacity, which is the
  // one number the two paths could silently share.
  const plainStyle = styleBody(strip, "EMBLEM_DESKTOP_STYLE");
  assert.ok(plainStyle.length > 0, "EMBLEM_DESKTOP_STYLE is gone — the no-photo mark is unpinned");
  assert.equal(
    /opacity: ([\d.]+)/.exec(plainStyle)?.[1],
    "0.2",
    "the no-photo mark must stay at opacity 0.2 — its own instruction, unchanged since 2026-09-04",
  );
  assert.ok(
    !/filter|mixBlendMode/.test(plainStyle),
    "the no-photo badge must carry no filter and no blend — the treatments tried on the with-photo "
      + "mark were both rejected, and applying one here would change a mark he never complained of",
  );

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE RESERVED BAND CARRIES THE NOTICE CENTRE — "the market space donot leave it like this make
  // use of it for example for a notification center" (owner, 2026-10-12).
  // ───────────────────────────────────────────────────────────────────────────────────────────
  assert.ok(
    strip.includes("<PhoenixIdentityNotices"),
    "the band under the bar is empty again — the owner circled that space and asked for it to be "
      + "used; the notice centre is what fills it",
  );
  assert.ok(
    strip.indexOf("<PhoenixIdentityNotices") > strip.lastIndexOf("</section>"),
    "the notice band must render OUTSIDE the bar's section — that section is `overflow-hidden` for "
      + "the watermark and the wave, so a band inside it is simply cut off",
  );

  const notices = read(NOTICES);
  assert.ok(
    notices.includes('fetch("/api/notifications/in-app"'),
    "the notice band must read the BELL's endpoint — a second query against notification_events is "
      + "a second place to get the personal-bell allowlist and the test-login fence wrong",
  );
  assert.ok(
    !/from "@\/lib\/supabase/.test(notices),
    "the notice band must not reach the database directly — it is a client component, and the "
      + "route it calls is what resolves the viewer server-side",
  );
  assert.ok(
    notices.includes("could not be loaded") && notices.includes("Nothing is waiting"),
    "a failure and an empty inbox must read as DIFFERENT facts — a band that says 'nothing waiting' "
      + "when it means 'could not load' is the misleading zero AGENTS.md §7 forbids",
  );

  // The reveal ladder and the grid must agree: a tile revealed at a width whose grid has no column
  // for it lands on a second row and the band doubles in height, silently.
  const reveal = /const TILE_REVEAL = \[([^\]]*)\]/.exec(notices)?.[1] ?? "";
  assert.ok(
    reveal.includes('"hidden sm:flex"') && reveal.includes('"hidden xl:flex"'),
    "the notice tiles must stay a 1 / 2 / 3 ladder — measured at 803px, three tiles wrap every "
      + "title onto three lines and the band outgrows the air the portrait reserves",
  );
  assert.ok(
    (notices.match(/sm:grid-cols-2 xl:grid-cols-3/g) ?? []).length >= 2,
    "the grid's columns must match the reveal ladder at BOTH the loading and the loaded state — "
      + "they are the same band and a viewer sees them one after the other",
  );

  // The other half of the coupling: the logo the desktop numbers were measured against.
  const band = read(SATO_BAND);
  assert.ok(
    band.includes('className="mr-[28px] h-8 w-auto shrink-0"'),
    "the SATO band logo changed size or spacing — the identity strip's emblem is measured off it "
      + `(h-8 = 32px box, 79.0px of ink across, 28px clear of the band's edge), so re-measure ${STRIP}`,
  );
}
