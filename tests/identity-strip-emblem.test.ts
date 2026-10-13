import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

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
/**
 * The other half of the region the owner rebuilt on 2026-10-12. The notice band and "Your day" are
 * one deck on the page and were rebuilt under one instruction, so they are pinned in one file: a
 * rule kept on one of them and lost on the other is exactly the split-document look he rejected.
 */
const DAY_PANEL = "src/components/hr/hr-today-panel.tsx";
/** The page the deck sits on — it decides WHERE the day panel renders, which is now a rule too. */
const COMMAND_CENTER = "src/components/hr/hr-command-center.tsx";
/** The bell's own route — the band reads it, and asks it for 20 rather than its default 8. */
const NOTICE_ROUTE = "app/api/notifications/in-app/route.ts";
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
  // BOTH calls are pinned SEPARATELY, and that is not belt-and-braces. The band makes two: a GET
  // carrying `?limit=` and the read-marking PATCH. A single assertion for "the endpoint appears
  // somewhere" was written first and broken to check it — and it stayed GREEN with the GET pointed
  // at a different route, because the PATCH alone satisfied it. One assertion per call is what
  // actually holds the band to the bell.
  assert.ok(
    /fetch\(`\/api\/notifications\/in-app\?limit=\$\{FETCH_LIMIT\}`/.test(notices),
    "the notice band must READ the BELL's endpoint — a second query against notification_events is "
      + "a second place to get the personal-bell allowlist and the test-login fence wrong",
  );
  assert.ok(
    /fetch\("\/api\/notifications\/in-app", \{/.test(notices),
    "reading a notice must MARK it read through the bell's own route — the badge above and the band "
      + "below would otherwise disagree until the next refresh",
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

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // THE DECK — the notice band and the day panel, rebuilt from nothing on 2026-10-12.
  //
  // "the place where I screenshot to you is a fucking oven. It needs to be burned out and
  // re-created from scratch a premium polished ... I want this account to be the fucking best of
  // the world" (owner, 2026-10-12), with the notice band and "Your day" in one screenshot — and, in
  // the same message, the identity bar and the portrait ruled finished: "do not touch, do not ever
  // touch. They're perfect right now."
  //
  // EVERY ASSERTION BELOW IS A THING A LATER SESSION WOULD PUT BACK WITHOUT MEANING TO. None of it
  // is visible in a diff review: a grid of tiles, a tinted chip, a cool hairline and a count printed
  // twice all render perfectly and keep CI green. The only signal is him opening the page again.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  // EVERY NEGATIVE CHECK BELOW RUNS ON THE CODE, NOT ON THE PROSE. These files explain what they
  // replaced — "never with `divide-y`", "a file that writes `rounded-full`" — and a bare `includes`
  // would fail on the paragraph that exists to stop the thing it names. `stripComments` is the
  // repo's own parser-grade stripper, not a regex, so a `//` inside a string or a URL survives.
  const noticesCode = stripComments(notices);
  const dayCode = stripComments(read(DAY_PANEL));

  // 1. THE BAND IS A LEDGER, NOT A GRID OF TILES. The grid revealed its second tile at `sm` and its
  //    third only at `xl`, so at 803px — the width this page is most often read at — it showed two
  //    squat boxes and a hole. Rows are the full width of the band at EVERY size.
  assert.ok(
    /const NOTICE_ROWS = 3/.test(noticesCode) && !noticesCode.includes("TILE_REVEAL"),
    "the notice band is back on the tile grid — it must be a ruled ledger of three rows, all three "
      + "visible at every width; the reveal ladder is what made it show two tiles and a hole at 803px",
  );
  assert.ok(
    !/grid-cols-/.test(noticesCode) && !/\bhidden (sm|md|lg|xl):(flex|grid|block)\b/.test(noticesCode),
    "a notice row must not be gated behind a breakpoint — a band that hides a row at the width it "
      + "is read at under-reports what is waiting, which is the defect the ledger replaced",
  );

  // 2. IT CONTINUES THE IDENTITY BAR'S OWN INK. The bar closes on a wave filled #231e18 under an
  //    #f47b20 stroke; the band opens on a flat rail in exactly those two, which is what makes the
  //    two read as one document rather than as a widget parked under a banner.
  assert.ok(
    /const INK = "#231e18"/.test(noticesCode) && /const ORANGE = "#f47b20"/.test(noticesCode),
    "the notice band's rail must stay in the identity bar's own ink and orange (#231e18 / #f47b20) "
      + "— those are the fill and the stroke of the wave the bar closes on",
  );
  assert.ok(
    /background: INK[,\s}]/.test(noticesCode) && /inset 0 -2px 0 0 \$\{ORANGE\}/.test(noticesCode),
    "the rail must keep its ink ground and its 2px orange edge — without them the band is a grey "
      + "strip and the letterhead stops at the wave",
  );

  // 3. WARM HAIRLINES, NEVER SLATE. A cool grey rule on #fdf8f3 paper is the mismatch that made the
  //    first band look cheap under the banner. This is the assertion most likely to be undone by a
  //    session reaching for the nearest Tailwind token.
  for (const [file, label] of [
    [noticesCode, "the notice band"],
    [dayCode, "the day panel"],
  ] as const) {
    assert.ok(
      !/\b(?:border|divide|bg|text)-slate-\d/.test(file),
      `${label} must not use the cool slate palette — every rule and every grey on this page is `
        + "mixed off the banner's #fdf8f3 paper, and one slate hairline is enough to split the "
        + "page into two documents",
    );
  }

  // 4. THE DAY PANEL CARRIES ITS COUNT ONCE, IN THE GUTTER. It used to print the count in a pill
  //    beside the title AND inside the sentence above — the same fact twice, which is why the eye
  //    had to decide which one mattered.
  assert.ok(
    !/CountPill/.test(dayCode) && !/rounded/.test(dayCode),
    "the day panel's count pill is back, or a radius was written into it — the count belongs in the "
      + "left gutter as a tabular figure, and this page has no round corners anywhere",
  );
  assert.ok(
    /tabular-nums/.test(dayCode) && /\{task\.count\.toLocaleString\("en-US"\)\}/.test(dayCode),
    "the gutter figure must be the task's own count, set tabular — figures that do not share an "
      + "axis down the column are what makes a list of rows read as cards instead of as a ledger",
  );

  // 5. URGENCY IS A MARGIN EDGE AND A FIGURE, NOT A PALETTE. The panel used to carry a rose / amber
  //    / emerald tinted badge, count, icon well and rail per state — four tinted surfaces per row,
  //    three saturated families under a warm cream banner. The house ink rule refuses filled areas.
  assert.ok(
    !/\b(?:bg|border|text)-(?:rose|amber|emerald)-\d/.test(dayCode),
    "the traffic-light tints are back in the day panel — urgency is the orange margin edge and the "
      + "orange figure, and nothing on a row is filled with a state colour",
  );
  assert.ok(
    /URGENCY_MARKS/.test(dayCode) && !/URGENCY_STYLES/.test(dayCode),
    "the day panel's urgency map must stay the two-mark one (edge + figure) — the four-surface map "
      + "it replaced is what made the page read as an oven",
  );
  assert.ok(
    /className="sr-only">Needs you first</.test(dayCode),
    "'Needs you first' must stay in the accessible name even though it is no longer printed — "
      + "colour alone is not an affordance, and printing it put three identical captions in a column",
  );

  // 6. THE HEADLINE IS SET, NOT STYLED, AND ITS FIGURES ARE SEGMENTS. Picking the digits out of
  //    rendered prose with a regex is the version that breaks the first time a name contains one.
  assert.ok(
    /font-display/.test(dayCode) && /segment\.figure/.test(dayCode),
    "the opening sentence must stay in the display serif with its figures carried as segments — "
      + "that sentence is the page's opening line, and a regex over rendered prose is not how its "
      + "numbers get their colour",
  );

  // 7. NO `divide-y` ON A WARM-RULED LIST. `divide-y` sets a width and no colour, and border-color
  //    is not inherited — so a list whose colour is set on the PARENT draws its rules in
  //    currentColor, which turns a #e6e0d6 hairline into a black line nobody asked for.
  assert.ok(
    !/divide-y/.test(dayCode) && !/divide-y/.test(noticesCode),
    "a rule between rows must be written on the row itself — `divide-y` carries no colour, and the "
      + "warm hairline silently becomes currentColor",
  );

  // 8. THE BAND STILL FITS THE AIR THE PORTRAIT RESERVES. Measured on the branch at 803px and at
  //    1440px with three notices loaded: the band is 120px against a 120px reserve and 143px against
  //    a 143px reserve — it fills the overhang exactly and adds no page height. The row paddings
  //    below are what buy that, so they are pinned.
  assert.ok(
    /py-\[5px\] pl-3 pr-2/.test(noticesCode)
      && /className=\{\["@container flex min-w-0 flex-col pt-2"/.test(noticesCode),
    "the notice rows or the band's top padding grew — measured at 803px, a row at py-[7px] and a "
      + "band at pt-3 put the ledger at 136px against the portrait's 120px reserve, which pushes "
      + "the whole dashboard down the page",
  );

  //    AND THE ROWS SWITCH ON THE BAND'S OWN WIDTH, NEVER ON THE VIEWPORT. The band sits beside the
  //    standing portrait inside a shell with a sidebar, so it is 510px across at a 768px viewport
  //    and 545px at 803px — a `md:` breakpoint reveals the module tag at exactly the width that
  //    cannot hold it, and the title wraps to a second line 15px past the portrait's reserve.
  //    Measured both ways on the page before this was written; `@container` is the locked rule for
  //    a component that can sit in a column.
  assert.ok(
    /@container flex/.test(noticesCode)
      && /block: "hidden @min-\[540px\]:inline"/.test(noticesCode)
      && !/\b(?:sm|md|lg|xl):inline\b/.test(noticesCode),
    "a notice row went back to a viewport breakpoint — the band is 510px wide at a 768px viewport, "
      + "so `md:` shows the module tag exactly where the title then wraps and the band outgrows the "
      + "portrait's reserve; the thresholds are the band's own width (@min-[540px] / @min-[380px])",
  );

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 8b. 🔴 SHUT IS NOT BLANK — THE RESERVED AIR CARRIES THE LEDGER (owner, 2026-10-13, with that
  //     air circled on the Talent Acquisition overview: "i donot want this blanque area empty like
  //     this"). Collapsing by default — his OWN ruling the day before, "the notification should take
  //     a small place and be expandable, collapsible" — had emptied the band back out, so the
  //     portrait's overhang was a white hole on every landing carrying a photo.
  //
  //     THE TWO RULINGS ARE BOTH KEPT BY ONE MECHANISM, AND THAT IS WHAT THESE PINS HOLD: the shut
  //     ledger is ABSOLUTELY POSITIONED over air that is reserved whether or not anything is drawn
  //     in it. Absolute content contributes no height, so the band cannot grow the page even if a
  //     row's padding is changed one day — it would be clipped, which is a fault you can SEE,
  //     against a dashboard pushed down the page, which is the silent one. Measured on the branch
  //     at a 101px reserve: band 101px, spacer 101px, three rows ending 6px above the foot.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  assert.ok(
    /reservesAir=\{Boolean\(photoSrc\)\}/.test(strip),
    "the strip stopped telling the band whether there is reserved air — `reservesAir` is the PHOTO "
      + "and nothing else, because the spacer that makes the air exists only when a portrait stands "
      + "there. Without it the shut band either leaves his white hole or grows an initials landing",
  );
  assert.ok(
    /\{!expanded && reservesAir \? \(/.test(noticesCode)
      && /absolute inset-0 flex min-w-0 flex-col overflow-hidden/.test(noticesCode),
    "the shut band is back to rendering nothing, or its ledger left the absolute fill — in normal "
      + "flow a ledger taller than the reserve makes the `items-stretch` row grow and pushes the "
      + "whole dashboard down the page, which is the one failure the identity strip exists to prevent",
  );
  assert.ok(
    /const ledger = \(peek: boolean\)/.test(noticesCode)
      && noticesCode.split("<KindBlock").length === 2,
    "the ledger is written twice — shut and open must draw the SAME markup through one builder, or "
      + "the band's whole claim (that what the shut band shows is what the open one shows) decays "
      + "the first time a figure or a state is changed in one copy only",
  );
  assert.ok(
    /if \(peek\) \{\s*return \(\s*<li className="border-t"[\s\S]{0,180}<div className=\{ROW_SHELL\}>\{body\}<\/div>/
      .test(noticesCode),
    "a peek row became pressable again — the shut ledger is clipped to the reserve, so a drop list "
      + "opened there falls into space nobody can scroll to. The rail above is the control in that "
      + "state, and it swaps the peek for the real ledger",
  );

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 9. ONE BLOCK PER KIND, AND PRESSING IT DROPS THE LIST — the owner's second instruction on the
  //    band, taken partition by partition: "the first partition, which is the new CV received, the
  //    new WhatsApp message, the four CVs received today. We can make it this as one block. And when
  //    I press on this block, a drop list appears ... I press on it, I get the resources."
  //
  //    He was reading a real repetition, not a layout quirk. Measured on production the same day:
  //    `New CV received` fired 9 times that Cairo day and 97 in seven; `New WhatsApp message — no CV
  //    attached` 8 and 53 — every one under the SAME subject, because the sender and the preview live
  //    in the message body. A ledger of three rows was spending the whole band on near-identical
  //    lines. These are the four things a later session would undo without meaning to.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  assert.ok(
    /function groupByKind/.test(noticesCode)
      && /`\$\{notice\.module \?\? ""\}::\$\{notice\.title\}`/.test(noticesCode),
    "the band stopped grouping, or started grouping on the title alone — notices collapse into one "
      + "block per MODULE AND TITLE, so a CRM visit can never land inside a recruitment block and a "
      + "title naming a person stays its own row",
  );
  assert.ok(
    /aria-expanded=\{open\}/.test(noticesCode) && /aria-controls=\{listId\}/.test(noticesCode),
    "a kind block must stay a real disclosure — `aria-expanded` and `aria-controls` on a <button> "
      + "are what make the drop list reachable by keyboard and announceable; a div that responds to "
      + "a click is not",
  );
  assert.ok(
    /onClick=\{\(\) => setOpen\(/.test(noticesCode),
    "pressing a kind block must do nothing but open it — marking nine CVs read because he pressed a "
      + "disclosure would empty the badge for arrivals he has not looked at",
  );

  //    THE FIGURE ON A BLOCK IS "THIS MANY IN THE BAND", AND SAYS `today` ONLY WHEN IT CAN SEE THE
  //    WHOLE DAY. The endpoint serves at most 20 rows, so a count taken at that cap may be short —
  //    and recruitment already ships a real digest titled `4 CVs arrived today` (15:04 Cairo), so a
  //    block inventing its own day total would contradict a notice sitting in the same band.
  assert.ok(
    /const FETCH_LIMIT = 20/.test(noticesCode) && /limit=\$\{FETCH_LIMIT\}/.test(noticesCode),
    "the band must ask the endpoint for its full 20 — at the service default of 8 a kind that fired "
      + "nine times today would be counted as eight, and the count is the whole point of a block",
  );
  assert.ok(
    /const payloadAtCap = loaded\.length >= FETCH_LIMIT/.test(noticesCode)
      && /kind\.allToday && !payloadAtCap/.test(noticesCode),
    "a block said `today` without checking that the payload came back under the endpoint's cap — at "
      + "the cap the count is a floor, not a day total, and the Cairo stamp is the honest alternative",
  );

  //    THE MEMBER ROWS ARE THE PROOF OF THE FIGURE. The message is where the sender and their words
  //    are, so it is the line that identifies a member — and it wraps, because the house rule
  //    forbids an ellipsis and a truncated applicant's name is the one thing a recruiter cannot act
  //    on. The list scrolls on the VERTICAL axis only; the fits-the-screen rule bans the other one.
  assert.ok(
    /\{notice\.message \|\| notice\.title\}/.test(noticesCode)
      && !/line-clamp|truncate|text-ellipsis/.test(noticesCode),
    "a member row must show its own message, wrapped and never clipped — the title is identical "
      + "across the whole block, so the message is the only thing that tells one arrival from another",
  );
  assert.ok(
    /overflow-y-auto overflow-x-hidden/.test(noticesCode) && /max-h-\[\d+px\]/.test(noticesCode),
    "the drop list lost its vertical cap or gained a horizontal scroll — a kind that fired nine "
      + "times must not push the dashboard off the screen, and no surface on this page scrolls sideways",
  );

  // 10. THE ROUTE SERVES THE LIMIT THE BAND ASKS FOR, AND IT IS NOT A TRUST BOUNDARY. The viewer,
  //     the personal-bell allowlist and the test-login fence are resolved server-side from the
  //     access context; the service clamps its own limit to 20. A malformed value must fall back to
  //     the default rather than erroring, because a bad URL must not cost the caller its notices.
  const routeCode = stripComments(read(NOTICE_ROUTE));
  assert.ok(
    /searchParams\.get\("limit"\)/.test(routeCode) && /Math\.min\(parsed, 20\)/.test(routeCode),
    "the in-app notifications route stopped honouring `?limit=` or stopped clamping it — the band "
      + "needs 20 to count a repeating kind, and the ceiling is what keeps the query from asking for "
      + "the whole table",
  );
  assert.ok(
    /return undefined/.test(routeCode) && /limit === undefined/.test(routeCode),
    "a bad or missing `?limit=` must fall through to the service's own default — the bell sends no "
      + "limit at all, and a 400 there would empty its panel",
  );

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // 11. THE PENDINGS LIVE BEHIND THE BUTTON, NOT ABOVE THE TOOLBAR (owner, 2026-10-13: "the needs
  //     attentions button is fair enough make it show all pendings when clicked on and remove the
  //     upper part"). "Your day" stood open as the page's first block; it is now what the toolbar's
  //     "Needs attention" button opens, with every waiting task already expanded.
  //
  //     THE RESTORATION THIS CATCHES is a kind one: a session reading hr-today-panel.tsx's own
  //     header — "the page's opening answer to what do I do today", "the most urgent opens by
  //     default" — would put the panel back at the top in good faith, because the file still says
  //     that is what it is for. It renders perfectly either way.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  const centerCode = stripComments(read(COMMAND_CENTER));
  assert.ok(
    /\{attentionOnly \? \(\s*<div id=\{PENDINGS_PANEL_ID\}>\s*<HrTodayPanel icons=\{GROUP_ICONS\} openAll tasks=\{data\.tasks\} \/>/
      .test(centerCode),
    "the day panel is standing open on the page again, or it opens without `openAll` — it renders "
      + "ONLY inside the attention toggle, and someone who pressed a button for the pendings must "
      + "not get four of the five tasks still shut",
  );
  assert.ok(
    (centerCode.match(/<HrTodayPanel/g) ?? []).length === 1,
    "the day panel is rendered more than once — the upper block he removed is back beside the one "
      + "behind the button",
  );
  assert.ok(
    /aria-controls=\{PENDINGS_PANEL_ID\}/.test(centerCode)
      && /aria-expanded=\{attentionOnly\}/.test(centerCode),
    "the attention button must announce the panel it opens — it is a disclosure now as well as a "
      + "filter, and `aria-controls` pointing at a literal that drifts from the panel's id is a "
      + "dangling reference nothing in the browser reports",
  );
  assert.ok(
    /const waitingKeys = ordered\.filter\(\(task\) => task\.urgency !== "clear"\)\.map\(\(task\) => task\.key\);/
      .test(dayCode) && /new Set\(openAll \? waitingKeys : waitingKeys\.slice\(0, 1\)\)/.test(dayCode),
    "`openAll` stopped opening every waiting task — the panel is only reached by pressing the button "
      + "that asks for all the pendings, so opening one of them is answering a narrower question",
  );

  // The other half of the coupling: the logo the desktop numbers were measured against.
  const band = read(SATO_BAND);
  assert.ok(
    band.includes('className="mr-[28px] h-8 w-auto shrink-0"'),
    "the SATO band logo changed size or spacing — the identity strip's emblem is measured off it "
      + `(h-8 = 32px box, 79.0px of ink across, 28px clear of the band's edge), so re-measure ${STRIP}`,
  );
}
