"use client";

import Image from "next/image";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

import { PhoenixIdentityNotices } from "@/components/phoenix-signature-card/PhoenixIdentityNotices";

/**
 * The signature card's identity, as a THIN STRIP.
 *
 * Built 2026-09-03 at the owner's instruction, for the HR overview command centre: "check the
 * employee portal one ... but the most important thing that I don't want it to be too thick, too
 * many space in the page. I want it to be narrow, to have much space for the page to show data."
 * He named the height himself — under 96px.
 *
 * WHY THIS IS NOT `PhoenixSignatureCard` WITH A CLASS. That card's desktop half is sized by an
 * inline `aspectRatio: 1875 / 420`, and its mobile half by an inline `height: 150px`. Inline
 * styles beat any class a caller passes, so the card cannot be made thin from outside — and it
 * MUST NOT be made thin from inside, because it renders the employee portal's identity banner,
 * which is a design-locked surface (CLAUDE.md, `employee-portal/identity-card.tsx`). So the strip
 * is a sibling that borrows the vocabulary and leaves the card untouched.
 *
 * WHAT IT BORROWS, so the two read as one family: the warm paper ground (#fdf8f3) with the same
 * two radial washes, a Phoenix watermark bleeding off the right edge under the wave, the
 * orange-ringed portrait at the leading edge, the Pinyon Script name, the orange rule with its
 * dot, and the uppercase letter-spaced title.
 *
 * The watermark is the same IDEA but no longer the same FILE — the strip draws the full emblem
 * (ring, phoenix, bars) and the card keeps the wide phoenix. See the two <img> tags below.
 *
 * THE HEIGHT RULE WAS REVERSED BY THE OWNER ON 2026-09-04, AND THIS IS THE NEWER INSTRUCTION.
 * It was 88/92px because on 2026-09-03 he asked for narrow: "I don't want it to be too thick, too
 * many space in the page." That produced a bar whose content ended at 208px of 1084 — 81% empty —
 * with the name at 27.2px under 30px/900 KPI counters. Shown it, he said: "The banner is too
 * small. It's too small in comparison with the dashboard", and when asked directly whether he
 * wanted the bar itself taller or was merely seeing a stale build, he answered "make it taller and
 * its weak". So it is now 120px on a phone and 136px from `sm` up.
 *
 * DO NOT "RESTORE" THE THIN VERSION on the strength of the 09-03 quote — that quote is older, and
 * it is the one this paragraph exists to overrule. What he has never wanted back is the ORIGINAL
 * block, the full `PhoenixSignatureCard` at aspectRatio 1875/420, which is ~243px on this width:
 * "WITHOUT THIS BUFFENK THIVK BANNER BLOCK". 136px sat deliberately between the two.
 *
 * THE DESKTOP BAR IS 160px SINCE 2026-10-12, AND THE PHOTO IS WHAT BOUGHT IT. Looking at the
 * Talent Acquisition landing he asked for one thing: "i want the photo bigger clear obvious". The
 * portrait could not grow inside a 136px bar — the content row is the bar minus the wave's 24px,
 * so 110px of portrait was already filling 112px of room, and anything larger clipped against
 * `overflow-hidden`. So the bar grew by the 24px the portrait needed and the portrait took it:
 * 110 -> 136px, which is 53% more face on the same page. It is still well under the ~243px block
 * he threw out, and the THIN version is still the thing never to restore. MOBILE IS UNTOUCHED at
 * 120px: there the photo already bleeds the full height of the bar frameless, so it is as big as
 * the bar allows and growing the bar would only cost a phone the space he asked to keep.
 *
 * THE PORTRAIT IS TWO DIFFERENT THINGS BY BREAKPOINT, AND THAT IS THE OWNER'S OWN SPLIT.
 * On 2026-09-04 he sent the Phoenix banner artwork and said: "in mobile view i want the photo
 * frameless fading exactly like this". So below `sm` the photo bleeds off the leading edge at full
 * height with no bezel, no ring and no corner, dissolving into the paper; from `sm` up it keeps the
 * framed tile. Both are deliberate — see PORTRAIT_FADE_MASK. A later session "unifying" the two
 * would be undoing an instruction, not removing a duplicate.
 *
 * WHAT IT DELIBERATELY DOES NOT BORROW: the card's two COLD values. The card sets the wave to
 * #0b1f3a and the name to #2a3a5c, both around hue 257-264. The admin shell those two landings
 * render in has had its whole neutral ramp retinted WARM on purpose — `app/globals.css` moves
 * slate to hue 72-92, and says why: a temperature swing between adjacent edges "is what reads as
 * mismatched". The strip's wave is a dark bar sitting 8px above the section header's dark bar at
 * almost the same lightness and 184 degrees away in hue, which is exactly that failure. So the
 * two are carried across at the SAME lightness with only hue and chroma moved into the ramp's own
 * band — #0b1f3a -> #231e18 (L 23.9%, both) and #2a3a5c -> #3f3a33 (L 35.2%, both). Same method
 * globals.css uses for slate; nothing about the composition shifts.
 *
 * The card itself is untouched and stays navy: it renders under `.employee-portal-shell`, which
 * is a different ground and a different identity. Do not "restore parity" by making either one
 * match the other.
 *
 * THE NAME SHRINKS TO FIT RATHER THAN CLIPPING. A script face on one line has no good failure
 * mode: wrapping breaks the strip's height, and an ellipsis is banned outright by the owner's
 * standing rule. So the name is measured and its font-size scaled down until it fits, exactly as
 * the card does it. That logic is deliberately duplicated rather than extracted — pulling it out
 * of `PhoenixSignatureCard` would mean editing the file behind a design-locked portal surface to
 * serve an admin page, which is the wrong trade.
 */

/** The bezel gradient, identical on both breakpoints and to `EmployeePortrait`'s. */
const PORTRAIT_BEZEL = "linear-gradient(145deg, #f9c06a, #f47b20 40%, #c45200 70%, #f9c06a)";

/**
 * MOBILE. The employee-portal identity banner's own four-layer glow, at the floor of each of its
 * `cqw` clamps — the owner, 2026-09-04: "IN MOBILE VIEW I WANT THE PHOTO SHADED AS EMPLOYEE
 * PORTAL IDENTITY BANNER". Copied from `EmployeePortrait` line 32 rather than re-derived, so the
 * two cannot drift. The strip is not a container, so the `cqw` middles cannot be used and the
 * floors are what a small portrait renders at anyway.
 *
 * IT NOW APPLIES TO THE INITIALS ONLY, and is not dead code. His later instruction the same day
 * made the mobile PHOTO frameless, so the framed tile survives on a phone purely as the no-photo
 * fallback — where a glow is still the right answer, because an initials chip has no edge of its
 * own to dissolve.
 *
 * It does NOT clip. The outermost layer is 28px of blur on a 60px portrait with 6px of clearance
 * inside an `overflow-hidden` section — but the layers are warm and low-alpha on a cream ground,
 * and the cut is invisible at 2x. Verified at 375px before shipping.
 */
const PORTRAIT_GLOW =
  "0 0 0 2px rgba(244,123,32,0.18), 0 0 12px 3px rgba(244,123,32,0.4),"
  + " 0 0 28px 5px rgba(255,150,40,0.2), 0 12px 30px rgba(15,35,55,0.2)";

/** DESKTOP. The flat ring the strip has always had; the glow was asked for on mobile only. */
const PORTRAIT_RING = "0 0 0 2px rgba(244,123,32,0.16), 0 4px 12px rgba(15,35,55,0.16)";

/**
 * DESKTOP, THE STANDING PORTRAIT. The in-bar ring above is a 136px tile's shadow and it does not
 * carry a 188x248 column: a 12px blur under a frame that size reads as a sticker, because the
 * shadow is shorter than the thing casting it. This is the same light from the same direction, just
 * spent at the column's own scale — a 1px ink hairline so the gold edge is crisp against cream, a
 * tight contact shadow at the foot, and one long low-alpha cast that actually reaches the page.
 *
 * NO ORANGE GLOW HERE, deliberately. The glow belongs to the frameless phone portrait, where it
 * replaces an edge; this frame HAS an edge — doubling it would halo the gold.
 */
const PORTRAIT_STANDING_SHADOW =
  "0 0 0 1px rgba(35,30,24,0.22), 0 2px 5px rgba(15,35,55,0.12),"
  + " 0 18px 36px -10px rgba(15,35,55,0.34)";

/**
 * THE STANDING PORTRAIT IS SIZED BY THE VIEWPORT, AND EVERYTHING AROUND IT IS DERIVED FROM THAT ONE
 * NUMBER. The owner, 2026-10-12: "MAKE THE PICTURE BIGGER AND MAKE IT RESPONSIVE BASED ON VIEW SIZE
 * AND SHOW THE PHX LOGO FROM BEHIND AS A WATERMARK."
 *
 * WHY CSS VARIABLES AND NOT FOUR BREAKPOINT CLASSES. Five things have to move together — the
 * portrait's width and height, the air the page reserves under it, where the name and rule stop, and
 * where the watermark sits so it comes out from behind the frame. Written as classes that is five
 * `sm:` / `lg:` / `xl:` ladders that a later edit can desynchronise one rung at a time, and the
 * failure is silent (a name under a photo, a mark with nothing showing). Written as one clamp with
 * four `calc`s off it, there is ONE number, and every other number is arithmetic.
 *
 * THE CLAMP: 200px at the narrow end, 17vw in the middle, 268px at the top. The floor is what the
 * bar needs to still read as a bar on a laptop (the frame was a fixed 188px before this and he asked
 * for bigger); the ceiling is where a portrait starts competing with the dashboard instead of
 * introducing it. 17vw puts it at 218px on a 1280 screen and 245px on a 1440.
 *
 * THE HEIGHT IS THE WIDTH x 1.32, which is the 188x248 proportion the shape shipped with — the
 * reversed L he drew. It is NOT the photo's own aspect ratio: the image is `object-cover`, so the
 * frame's proportion is a design choice and the crop follows it.
 *
 * `--phx-text-gap` IS WHY THE NAME STILL CLEARS EVERYTHING. The text column has to stop before the
 * PHOENIX now, not before the frame, because the mark deliberately shows to the left of it: the ink
 * reaches 84px past the frame's leading edge (see `--phx-mark-right`), so the gap is the frame plus
 * 84 plus 12 of air, net of the content wrapper's own `pr-6` — W + 72.
 *
 * `--phx-mark-right` IS THE WHOLE "FROM BEHIND" EFFECT, AS ARITHMETIC. At 162px the emblem's ink
 * starts 31.6px inside its own box on the right and 131.3px inside it on the left. Offsetting the
 * box to W - 47px from the bar's trailing edge therefore lands the ink's right edge 15px BEHIND the
 * frame's leading edge and its left edge 84px CLEAR of it. Both hold at every viewport, because both
 * are stated against W.
 *
 * THE BITE IS 15px AND IT WAS A THIRD OF THE MARK FIRST — that version was looked at and rejected,
 * and the reason generalises. The emblem is a round badge, so an occlusion of about a third does not
 * read as "behind" at all: it reads as a disc sliced down the middle by the frame, because the cut
 * line runs through the body of the phoenix. A badge reads as standing BEHIND something when the
 * near object takes a small bite out of its edge — which is also how the eye resolves depth in the
 * absence of a shadow. Hiding MORE is the other coherent answer (a crescent peeking out), and it was
 * not taken because he asked for the mark to be SHOWN.
 *
 * THE HEIGHT IS THE TALLEST THE BAR CAN HOLD THE MARK WHOLE. The file is 64.1% ink vertically with
 * 14.8% of transparency above it, so at 162px from `top: -5` the ink runs y=19 to y=122.5 — and the
 * wave's box starts at y=130 on a 160px bar. 165px is the ceiling; anything past it stands the
 * phoenix's feet behind the wave, which is the one thing the owner has consistently refused.
 *
 * THE -5px IS THE WAVE, NOT A NUDGE. At `top: 0` the feet measured y=128 against a wave box opening
 * at y=130: inside the contract, and still wrong to look at, because the wave's PAINTED crest rides
 * a few pixels above its box on that part of the curve, so the phoenix's plinth sat on the orange
 * line. Five pixels up is the clearance the drawing needs rather than the clearance the number
 * needed. The crown still has 19px of bar above it, so nothing is cropped.
 *
 * THEY ARE SET ONLY WHEN THERE IS A PHOTO. With initials there is no standing portrait, so the
 * emblem falls back to its own defaults in the style object below — `right: 25px`, `height: 128px`,
 * `top: -11px`, the SATO logo's column, which is the owner's 2026-09-04 instruction and is untouched
 * on that path.
 */
const PORTRAIT_SCALE = {
  "--phx-portrait-h": "calc(var(--phx-portrait-w) * 1.32)",
  "--phx-portrait-w": "clamp(200px, 17vw, 268px)",
  "--phx-text-gap": "calc(var(--phx-portrait-w) + 104px)",
  "--phx-wash-right": "calc(var(--phx-portrait-w) - 138px)",
} as CSSProperties;

/**
 * WITH A PHOTO THE WATERMARK IS THE PORTAL BANNER'S OWN PHOENIX WASH — A DIFFERENT FILE FROM THE
 * CORNER MARK, AND THAT IS THE WHOLE FIX.
 *
 * The owner, 2026-10-12, twice in a row. First at the full-colour emblem enlarged behind the
 * portrait: "the watermark is not fitting good it feels like its not real or extra zeyada msh
 * mazboota". Then at the same emblem greyscaled and multiplied into the paper: "watermark mo2ref".
 *
 * BOTH REJECTIONS WERE OF THE SAME ARTWORK, NOT OF TWO TREATMENTS OF IT.
 * `identity-strip-emblem.png` is a BADGE — a ring, a phoenix and bar-chart bars, in Phoenix orange
 * and teal, ink across 62% of its box. A badge enlarged is a LOGO sitting on the page whatever is
 * done to its colour: at full saturation it reads as a third object, and greyscaled-and-multiplied
 * it reads as a smudge, because a hard-edged round mark pressed into cream paper looks like dirt
 * rather than print. There was no third treatment of that file worth trying.
 *
 * `identity-watermark.png` IS A WATERMARK ALREADY, IN THE FILE. Measured off its own alpha channel
 * in the browser: 1350x900, ink across 188,400 px (15.5% of the box), corners fully transparent,
 * the ink a near-white warm cream — brightest pixel rgb(254,238,221) — at a MEAN ALPHA OF 134 and a
 * MAXIMUM OF 255. A phoenix with no ring, no bars and no second colour.
 *
 * 🔴 IT IS FAINT BECAUSE OF ITS COLOUR, NOT ITS ALPHA — and an earlier note in this file that read
 * "the ink is rgba(255,238,222,0.18)" was wrong on exactly that point. 254/238/221 against the
 * paper's #fdf8f3 is a difference of (1, -10, -22): tone on tone. The alpha is nearly solid. That
 * distinction is the whole of the next paragraph, because a near-solid alpha channel is something
 * you can PAINT THROUGH, and a 0.18 one would not have been.
 *
 * AND IT IS THE SIBLING'S OWN MARK, WHICH IS THE OWNER'S STANDING INSTRUCTION FOR THIS FAMILY.
 * `PhoenixSignatureCard` — the employee portal identity banner he pointed at on 2026-09-03 ("check
 * the employee portal one") — draws THIS file at `height: 145%`, `top: -15%`, opacity 1, bleeding
 * past the bar and under the wave. The strip now does the same thing at the same proportions, so
 * the two surfaces finally carry one watermark instead of two different ideas of one.
 *
 * THE BLEED IS NOT THE THING HE TURNED DOWN IN SEPTEMBER. That refusal — "too embedded, too big,
 * needs to go inside the banner itself" — was the BADGE cropped by the bar's trailing edge, a
 * severed ring. This mark is whole horizontally and dissolves into its own transparency vertically,
 * exactly as it does on the banner beside it. Do not "correct" it back inside the bar's height: a
 * phoenix wash scaled to fit between the bar's top and the wave is 72px of ink across, which is the
 * ghost the owner has already rejected once at this size.
 *
 * THE PORTRAIT COVERS ITS TRAILING THIRD, WHICH IS "FROM BEHIND" — `--phx-wash-right` is stated
 * against the portrait's own width, so ~40px of ink stays behind the frame at every viewport while
 * the body of the bird stands on the cream.
 *
 * NO PHOTO, NO WASH. There is no standing portrait to come out from behind, so that path keeps the
 * corner badge in the SATO column exactly as his 2026-09-04 instruction left it — 128px at
 * `right: 25px`, `top: -11px`, opacity 0.2, untouched by any of this.
 */
const WASH_STYLE = {
  // THE GLOW, IN THE BRAND'S OWN ORANGE. The owner, 2026-10-12, twice: "I want it to be more more
  // appearing ... glossy and uh, shiny, glowing", then at a champagne version of exactly that —
  // "the logo is awful like this. I mean, make it glowing by by its original color, the orange. The,
  // its color is so bad, and make it also its ملامح باينة." A drop-shadow reads the ALPHA of
  // everything inside this box, so the halo is the phoenix's own outline rather than a rectangle
  // behind it: the wide one is the glow, the tight one is the burn that makes the edge read.
  filter:
    "drop-shadow(0 0 30px rgba(244,123,32,0.34)) drop-shadow(0 0 10px rgba(255,186,110,0.30))"
    + " drop-shadow(0 0 16px rgba(127,191,189,0.20))",
  // GEOMETRY UNCHANGED — "its place is perfect". 232px at top -24px against `--phx-wash-right` are
  // the numbers he accepted. The `<img>` took its width from the file; a div has to be given one,
  // and it is STATED as the file's own ratio rather than as 348 so the box cannot drift away from
  // the artwork. `aspect-ratio` alone measured 0px wide here — an absolutely positioned box with
  // only `right` set and nothing but absolute children has no content to shrink-wrap — so the
  // width is explicit and the ratio stays beside it as the derivation.
  aspectRatio: "1350 / 900",
  height: "232px",
  width: "calc(232px * 1350 / 900)",
  // LIGHTER. "No, no, no, what the fuck? It is awful like this. Make it lighter, make it lighter"
  // (owner, 2026-10-12, at the mark painted in solid brand orange). The gradients below are already
  // pale; this is the last stop that keeps the whole thing a WATERMARK rather than a logo on the
  // page, and it is the number to move first if he asks for lighter or stronger again.
  opacity: 0.62,
  right: "var(--phx-wash-right)",
  top: "-24px",
} as CSSProperties;

/**
 * THE GLOSS IS PAINTED THROUGH THE WATERMARK'S OWN ALPHA — the artwork is not altered at all.
 *
 * "its design is perfect and its place is perfect, but I want it to be more more appearing ...
 * glossy and uh, shiny, glowing" (owner, 2026-10-12).
 *
 * 🔴 SO IT IS A MASK NOW, NOT AN `<img>`, AND THAT IS WHY THE DESIGN SURVIVES. Every earlier
 * attempt changed how the mark was COMPOSITED — opacity down, greyscale, multiply — and he turned
 * each one down. A mask changes nothing about the drawing: the same 188,400 ink pixels at the same
 * alpha decide, per pixel, how much of whatever is behind them shows through. The silhouette, the
 * feathering and the position are byte-for-byte the file's. Only the INK is ours.
 *
 * AND IT ONLY WORKS BECAUSE THE ALPHA IS NEARLY SOLID (mean 134, max 255). Painting through an
 * 0.18 channel would have been the dimmed-logo failure again at one remove.
 *
 * 🔴 THE INK IS PHOENIX ORANGE, AND CHAMPAGNE WAS TRIED AND REJECTED. The first gloss painted the
 * mark in the paper's own family (#fffdf8 -> #c9a97c) on the reasoning that a coloured phoenix would
 * read as a second logo. He answered: "the logo is awful like this. I mean, make it glowing by by
 * its original color, the orange. The, its color is so bad, and make it also its ملامح باينة. خلي
 * ملامحها باينة." So the ink is #f47b20 — the brand's own orange, the colour the emblem has always
 * been — and the brief's last clause is its own requirement: the bird's FEATURES have to read.
 *
 * WHY ORANGE MAKES THE FEATURES APPEAR, WHICH TONE-ON-TONE COULD NOT. The detail in this artwork is
 * carried entirely by variation in its alpha — the histogram runs from 32 to 224 across the wing —
 * and alpha variation only becomes visible in proportion to how far the ink sits from the paper it
 * is laid on. Champagne on cream is a few points of difference, so every feather collapsed into one
 * pale shape. #f47b20 on #fdf8f3 is a wide separation, so the same alpha steps that were invisible
 * now draw the feathers, the crest and the plinth.
 *
 * 🔴 THE MASK IS DECLARED ONCE, ON A WRAPPER, AND EVERY LAYER IS ITS CHILD. "make it have a live
 * shading, live shading, but without uh, without decreasing the performance of the page" (owner,
 * 2026-10-12). A mask on each of six layers is six decodes of the same PNG and six masked
 * composites; a mask on their parent is one of each, and `mask-image` makes its own stacking
 * context, so the `multiply` and `screen` layers still blend against each other inside it and never
 * against the page.
 *
 * AND NOTHING ANIMATES EXCEPT `transform` AND `opacity`. Those two are the only properties a
 * browser can run on the compositor without re-running layout or re-painting: the layers are
 * rasterised once and then moved and faded on the GPU. An animated `background-position` — which is
 * how the first sweep was written — repaints a 348x232 masked surface every frame instead, which is
 * exactly the cost he asked not to pay. Measured on this page with the animations running: see the
 * PR. Do not animate a gradient's stops, a filter, a width or a position; move a layer instead.
 *
 * SIX LAYERS, AND EACH ONE HAS A JOB:
 *   · BLOOM — a soft warm core, static, so the bird is lit from inside rather than evenly tinted.
 *   · BODY — the orange ramp, light amber at the crest down to a burnt edge at the foot. A single
 *     flat orange reads as a sticker; the ramp is what makes it a lit object.
 *   · CARVE — a multiply shoulder down the trailing diagonal. This is the "ملامح باينة" layer: it
 *     deepens where the alpha is already high and leaves the thin feather-tips alone, so the
 *     separations between feathers darken instead of blurring together. It blends against the body
 *     INSIDE this box, never against the page, because `filter` on the box makes its own stacking
 *     context.
 *   · LIFT — a `screen` highlight along the leading upper edge, which is the gloss: a polished
 *     surface is a bright edge and a dark shoulder on one object, never overall brightness.
 *   · STRIKE — the lightning. Read the next paragraph; it is the only thing here that moves.
 *
 * 🔴 "LIVE SHADING" IS A STRIKE EVERY FIVE SECONDS, NOT A SURFACE THAT KEEPS MOVING. The first
 * reading of it put the whole mark in constant motion — a core breathing on a 7.5s cycle and a
 * highlight drifting on a 13s one — and he corrected it: "I didn't mean by live shading like this.
 * I mean the logo as it is, and every, for example, uh, five seconds, um, like رعد uh, وبرق" —
 * thunder and lightning. So the mark is STILL. Once every five seconds a bright band crosses it in
 * about six tenths of a second, flickering twice on the way exactly as lightning does, and then
 * there is nothing at all for four and a half seconds. Do not re-add a continuous animation here:
 * he has now rejected that reading in his own words, and a watermark that never stops moving is
 * also the version that pulls the eye off the page it is behind.
 *
 * THE STRIKE RESPECTS `prefers-reduced-motion` — `app/globals.css` turns `.phx-wash-strike` off
 * under it, and the mark keeps every static layer it has. Do not move the keyframes inline; they
 * cannot be inline, which is the only reason any of this lives in a stylesheet.
 */
const WASH_MASK = {
  maskImage: "url(/brand/identity-watermark.png)",
  maskPosition: "center",
  maskRepeat: "no-repeat",
  maskSize: "100% 100%",
  WebkitMaskImage: "url(/brand/identity-watermark.png)",
  WebkitMaskPosition: "center",
  WebkitMaskRepeat: "no-repeat",
  WebkitMaskSize: "100% 100%",
} as CSSProperties;

const WASH_BLOOM_STYLE = {
  background:
    "radial-gradient(62% 62% at 44% 44%, rgba(255,201,133,0.46) 0%, rgba(249,162,90,0.22) 58%,"
    + " rgba(244,123,32,0) 100%)",
} as CSSProperties;

/**
 * THE UPPER WING IS THE FIRST STOP OF THIS RAMP, AND IT WAS TOO PALE. "the part of the upper wing
 * is very is very light" (owner, 2026-10-12). The gradient runs top-left to bottom-right, so stop
 * 0% IS the wing — at #ffe4bd it was four points off the paper and the feathers there vanished,
 * while the body and the bars below read perfectly. The ramp now starts with colour in it and the
 * pale cream is gone; the LIFT layer above was also lightening the same corner and has come down
 * with it. The three merged colours he approved — warm gold, orange, teal — are unchanged.
 */
const WASH_BODY_STYLE = {
  background:
    "linear-gradient(138deg, #ffb878 0%, #fda862 16%, #fa9a55 32%, #f58d4e 50%, #f2c49e 66%,"
    + " #a8d4d0 84%, #7fc3c0 100%)",
} as CSSProperties;

const WASH_CARVE_STYLE = {
  background:
    "linear-gradient(138deg, rgba(150,86,34,0) 40%, rgba(150,86,34,0.10) 74%,"
    + " rgba(84,104,104,0.16) 100%)",
  mixBlendMode: "multiply",
} as CSSProperties;

const WASH_LIFT_STYLE = {
  background:
    "linear-gradient(138deg, rgba(255,245,228,0.30) 0%, rgba(255,222,176,0.14) 26%,"
    + " rgba(255,255,255,0) 48%)",
  mixBlendMode: "screen",
} as CSSProperties;

/**
 * THE LIGHTNING. Its own element, a third of the box wide, crossed by `translate3d` and flickered
 * by `opacity` — the two compositor properties — so the strike costs no repaint and no layout.
 *
 * IT IS BRIGHT ON PURPOSE, UNLIKE THE CONSTANT SWEEP IT REPLACES. A band strong enough to read as
 * lightning would bleach the phoenix if it crossed continuously, which is exactly what the 9s sweep
 * did and why it was turned down to a glint. At one pass every five seconds the mark is unlit 88%
 * of the time, so the strike can carry real light and the features still stand still between them.
 */
const WASH_STRIKE_STYLE = {
  background:
    "linear-gradient(112deg, rgba(255,255,255,0) 0%, rgba(255,250,236,0.92) 44%,"
    + " rgba(255,236,206,0.52) 58%, rgba(255,255,255,0) 100%)",
  mixBlendMode: "screen",
  opacity: 0,
} as CSSProperties;

/** The no-photo desktop mark: the 2026-09-04 SATO column, unchanged. Read the paragraphs below. */
const EMBLEM_DESKTOP_STYLE = {
  height: "128px",
  opacity: 0.2,
  right: "25px",
  top: "-11px",
  width: "auto",
} as CSSProperties;

/**
 * MOBILE, FRAMELESS. The owner, 2026-09-04, with the Phoenix banner artwork attached: "in mobile
 * view i want the photo frameless fading exactly like this". In that reference the portrait is not
 * a tile sitting ON the card — it IS the card's leading edge: full height, flush left, no bezel, no
 * ring, no rounded corner, its right side dissolving into the paper so there is no seam anywhere.
 *
 * SO THE FADE IS THE FRAME. With nothing but a hard edge holding the photo in, the dissolve is the
 * only thing standing between "bleeds off the edge" and "got cropped", and a SHORT taper reads as
 * the second. A two-stop ramp was tried first and the end of it was still visible as a seam at 3x;
 * this one holds solid for the first 38% and then eases off across the remaining 62% in four stops,
 * so there is no point where the falloff changes rate. `-webkit-mask-image` rides alongside for
 * Safari, which still wants the prefix.
 *
 * IT DELIBERATELY SITS UNDER THE WAVE (z-[1] against the wave's z-[3]), exactly as the reference
 * does — the navy band crosses in FRONT of the portrait's lower corner and finishes the shape.
 * Raising this above the wave is what would make it look pasted on.
 *
 * DESKTOP IS UNTOUCHED and keeps the bezel + ring. He asked for mobile, and the wide bar is where
 * the framed portrait still earns its place: at 1084px a bleeding photo would be a stripe.
 */
const PORTRAIT_FADE_MASK =
  "linear-gradient(90deg, #000 0%, #000 38%, rgba(0,0,0,0.86) 56%,"
  + " rgba(0,0,0,0.55) 72%, rgba(0,0,0,0.22) 86%, transparent 100%)";

function signatureNameFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  if (parts.length === 2) return `${parts[0]} ${last}`;
  return `${parts[0]} ${parts[1].charAt(0).toUpperCase()}. ${last}`;
}

function initialsFor(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "EM"
  );
}

export type PhoenixIdentityStripProps = {
  className?: string;
  /** HR ID, shown at the trailing edge. Omitted when absent rather than drawn empty. */
  employeeCode?: string | null;
  /** Full name. Abbreviated to "First M. Last" before it is drawn. */
  name: string;
  /** Profile photo, or null to fall back to initials. */
  photoSrc?: string | null;
  /** Optional honorific, e.g. "Dr." */
  prefix?: string;
  /**
   * WHAT FILLS THE AIR BESIDE THE PORTRAIT, UNDER THE NOTICE RAIL (owner, 2026-10-16, circling that
   * air on the Talent Acquisition overview: "fit the keycards where i marked"). Absent — every other
   * landing — the band is exactly what it was: the notices, whose shut peek fills the air. Given, the
   * notices keep their rail (and still open on a press, growing the band because she asked), and this
   * content stands under it in the reserve instead of the peek. It is in normal flow, so content taller
   * than the reserve grows the row rather than being clipped — the caller sizes it to the air.
   */
  reserve?: ReactNode;
  /**
   * The notice band under the bar. On by default: the band is the answer to the owner's "make use
   * of it", and a landing that opted out silently would be the one page where the reserved air came
   * back. It exists so a surface that genuinely must not fetch (a print or export view) can say so.
   */
  showNotices?: boolean;
  /** Job title, not the permission key — the caller resolves that. */
  title: string;
};

export function PhoenixIdentityStrip({
  className = "",
  employeeCode = null,
  name,
  photoSrc = null,
  prefix,
  reserve,
  showNotices = true,
  title,
}: PhoenixIdentityStripProps) {
  const titleLabel = title.trim().toUpperCase() || "PHOENIX WORKFORCE";
  const sigName = prefix ? `${prefix} ${signatureNameFor(name)}` : signatureNameFor(name);

  const nameRef = useRef<HTMLSpanElement>(null);
  const nameBoxRef = useRef<HTMLParagraphElement>(null);
  const [nameFontPx, setNameFontPx] = useState<number | null>(null);

  // Scale-invariant shrink-to-fit: divides the measured width by the font-size that produced it,
  // so it converges in one pass instead of oscillating. `getBoundingClientRect`, not `scrollWidth`
  // — that reads 0 on a plain `display: inline` element.
  useEffect(() => {
    const span = nameRef.current;
    const box = nameBoxRef.current;
    if (!span || !box) return;
    const measure = () => {
      const containerWidth = box.getBoundingClientRect().width;
      const naturalWidth = span.getBoundingClientRect().width;
      const currentPx = parseFloat(getComputedStyle(span).fontSize) || 16;
      if (containerWidth > 0 && naturalWidth > containerWidth) {
        const widthPerPx = naturalWidth / currentPx;
        setNameFontPx(Math.max((containerWidth / widthPerPx) * 0.97, currentPx * 0.45));
      } else if (containerWidth > 0 && naturalWidth < containerWidth * 0.92) {
        setNameFontPx(null);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [sigName]);

  return (
    <div
      className="relative w-full min-w-0"
      style={photoSrc ? PORTRAIT_SCALE : undefined}
    >
    <section
      aria-label="Your identity"
      className={[
        "relative isolate h-[120px] w-full min-w-0 overflow-hidden shadow-[0_8px_26px_rgba(16,35,61,0.13)] sm:h-[160px]",
        className,
      ].join(" ")}
      style={{ background: "#fdf8f3" }}
    >
      {/* The card's two washes, same stops. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse at 70% 40%, rgba(255,255,255,0.55) 0%, transparent 60%), radial-gradient(ellipse at 10% 60%, rgba(244,123,32,0.06) 0%, transparent 40%)",
        }}
      />

      {/* THE WATERMARK IS THE FULL EMBLEM NOW — ring, phoenix and bars — at the owner's
          instruction on 2026-09-04: "you remove this and you will add this logo that I will upload
          to you ... make it the same situation as this, but change the photo."

          IT IS A COPY, NOT THE SHARED FILE. `/brand/identity-watermark.png` is also drawn by
          `PhoenixSignatureCard`, which renders the employee portal's identity banner — a
          design-locked surface (CLAUDE.md). Repointing or editing that asset would have changed
          the locked banner as a side effect of an admin-strip request, so the emblem was copied to
          its own name. The card is untouched and still draws the old wide phoenix.

          IT IS ALREADY ALPHA-TRANSPARENT at source (81.9% of the file is not fully opaque, corner
          alpha 0), so "make it also transparent" is served by the file itself plus a low opacity,
          not by knocking a white box out of it.

          IT IS WHOLLY INSIDE THE BAR, AND THAT IS A CORRECTION HE MADE HIMSELF.
          It shipped once as a large mark cropped by the trailing edge — the reasoning being that a
          cropped mark reads as chosen furniture rather than a logo dropped in. He looked at it and
          rejected exactly that: "too embedded, too big, needs to go inside the banner itself and be
          small in size." DO NOT re-crop it against the edge — that is the specific thing he turned
          down.

          THE SIZE THEN CAME BACK UP, and both instructions are his, in this order. Taken at its
          word the first one produced a 74px mark that read as a ghost on a 1084px bar, and he said
          so: "the Phoenix needs to become bigger a bit. It's now too small. Make it move inside a
          bit and make it size bigger a bit." So it is now 76%/80% of the bar height with a wider
          right margin. "Small" was never the goal — INSIDE was; small was how he described the fix
          for a mark that was bleeding off the edge.

          THE TWO BREAKPOINTS NOW DIVERGE COMPLETELY, and that is the owner's third and latest
          instruction on this mark: "when on mobile view, make the Phoenix logo appear small at the
          upper right corner. And in desktop view, it needs to be a bigger, a little bit."

          READ THIS BEFORE CHANGING EITHER HEIGHT: THE PNG IS 64% INK AND 36% EMPTY. The file is
          512x512 but the visible mark occupies only x 97..412, y 76..403 — 316x328, with 76px of
          transparency above it, 108px below and ~98px each side. So a CSS `height` here is NOT the
          size of the Phoenix anyone sees: multiply by 0.64 for the ink, and expect the ink to sit
          ~15% of the box below the box top and ~21% above the box bottom. Sizing against the BOX
          is exactly how this shipped twice looking a third smaller than its number suggested.

          BOTH BREAKPOINTS ARE NOW THE SAME IDEA: a small mark tucked into the upper-right corner
          at opacity 0.2. That is the owner's latest word, and it settles a long back-and-forth —
          "make the logo small and out at the right upper corner in desktop view and make its
          color a bit more transparent." Mobile got there first; desktop followed.

          THE MARK NO LONGER TOUCHES THE WAVE AT EITHER SIZE, which is what makes a corner
          placement safe: the wave's box starts at y=90 on mobile and y=106 on desktop, and the
          ink now ends at y=32 at both widths. Nothing about the wave constrains this any more. It
          also means the old reasoning here — sizing the mark against the 112px band above the
          wave, or centring it on the bar to steal height — is dead. Do not restore either. The
          wave is NOT a flat 24px bar: its path runs from y=38 on the left to y=4 at the right edge
          of a 118-unit viewBox drawn 30px tall, so on the right — where this mark lives — it
          stands ~29px and covers the base cleanly. Read the `<svg>` at the end of this file before
          changing either number.

          IT SHIPPED ONCE CROPPED BY THE TRAILING EDGE AND HE TURNED THAT DOWN. Whatever the sizes
          become, the mark stays whole against the right edge — the only thing allowed to cover it
          is the wave from below, and now the standing portrait from the right.

          THE PORTRAIT IS THE SECOND THING ALLOWED TO COVER IT, AND HE ASKED FOR THAT IN THOSE
          WORDS: "SHOW THE PHX LOGO FROM BEHIND AS A WATERMARK" (2026-10-12). When the portrait
          came to the bar's trailing edge it landed exactly on top of this mark and the phoenix
          stopped existing on desktop — 128px of ink, all of it behind an opaque frame. So with a
          photo the mark grows to 150px and moves left by the portrait's own width: about a third of
          it stays behind the frame and the rest stands on the cream, which is what "from behind"
          looks like. It is still NOT cropped by any edge — being partly behind the portrait is
          occlusion by a nearer object, not a crop, and it is the thing he asked for.

          THE SATO COLUMN IS NOT ABANDONED — IT IS THE NO-PHOTO PATH. With initials there is no
          standing portrait, the three `var()` fallbacks below apply, and the mark is exactly where
          his 2026-09-04 instruction put it: 128px at `right: 25px`, `top: -11px`. Do not "unify"
          the two: one of them answers an instruction the other one cannot.

          THE SIZE AND THE COLUMN BOTH COME FROM THE SATO LOGO NOW, at the owner's instruction on
          2026-09-04: "make the Phoenix logo in the identity banner same size as Sato Pharma logo
          and at the same of it. But this is below. This is above." The mark he means is the one in
          the black SATO band immediately under this bar (`ceo-command-center.tsx`), and it is a
          plain `h-8` at EVERY width — so the two disagreed twice over: this one was bigger on
          desktop, and it sat 40px further right than the SATO mark at both widths.

          IT IS THE WIDTH THAT WAS MATCHED, NOT THE HEIGHT, AND HE SETTLED THAT HIMSELF. The two
          marks are different shapes — the SATO one is a wide wordmark, 79px of ink across and 30px
          down; this one is square, 316x328 of ink in a 512x512 file. Matched on HEIGHT the phoenix
          came out 29px wide against the SATO logo's 79px and he read it as unchanged: "the Phoenix
          logo is still very small. I wanted to be compatible in size as the sato pharma logo down
          it. And put it exactly above it to be one line." Two marks of equal WIDTH, stacked on one
          right edge, are what reads as a pair; equal height does not.

          MATCH THE INK, NOT THE BOX — that is the whole trick, and both PNGs carry padding.
          Measured in the browser rather than assumed: the SATO file is 401x158 with ink filling
          97.3% of its width, so `h-8` draws 79.0px across; this file's ink is 61.7% of its box
          wide and 64.1% of it tall. 79.0 / 0.617 = 128, so `height: 128px` (the file is square, so
          height sets width) draws 79.0px of phoenix across and 82.0px down.

          THE COLUMN IS THE SATO MARK'S OWN RIGHT EDGE, which sits 50px in from the bar's trailing
          edge. This box carries 24.8px of transparent margin of its own at 128px, so `right: 25px`
          lands the ink's right edge within 0.3px of the logo below it — which is the "exactly
          above it" half of the instruction, and why 25 is not a number waiting to be rounded: it
          is 50 minus the file's own padding.

          `top: -11px` IS PADDING ARITHMETIC TOO, not a nudge over the edge. The box carries 19.0px
          of transparency above the ink, so this puts the crown 8px below the bar's top edge and
          the feet at 90px — which is the MOBILE constraint, not a taste call: the wave's box
          starts at y=90 on a 120px bar, so any lower and the phoenix stands behind it on a phone.
          On desktop's 136px bar the wave starts at 106 and there is 16px to spare.

          HIS FIRST MEASUREMENT OF THIS SAME MOVE WAS "one centimeter to the left and 0.75
          centimeter up". The centimetre landed within 1px of the SATO column, which is what
          identified the column as the thing he was actually aiming at. The 0.75cm up could not be
          taken literally at the size it was then — 28.3px up from a crown sitting 12.3px below the
          edge is a crop, and this section is `overflow-hidden`.

          TWO ELEMENTS AGAIN, ONE PER BREAKPOINT, and that is the owner's call, not a drift back.
          It was two, then one when the sizes stopped differing; it is two again because they
          differ again. Him, 2026-09-04: "in HRS or identity banner make the Phoenix logo small at
          the upper right corner in mobile view." An inline style cannot carry a media query and
          `cn()` silently drops custom named sizes, so the split is by ELEMENT — a `sm:hidden` /
          `hidden sm:block` pair around two style objects — and never by a size class.

          THE PHONE MARK IS THE SAME MARK AT HALF SIZE, IN THE CORNER. 64px is 128 halved, which
          draws 39.4px of ink across and 40.9px down; `right: 4px` lands its ink's right edge
          16.5px in, which is the text column's own `pr-4` gutter, and `top: 0px` needs no nudge
          because the box carries 9.5px of transparency above the crown by itself. Feet at 50.4px
          on a 120px bar, so the wave at y=90 is not in play on a phone any more.

          WHAT IT BOUGHT, and it is why he asked: at full size the mark's ink began 128.75px in
          from a 351px bar, which left the name 98px to live in and crushed the script. Halved and
          cornered, its ink begins 55.9px in, the name's box is 171px, and the name renders at its
          natural size again. The desktop mark below is untouched — the SATO column and the
          "exactly above it" pairing are a desktop reading and still hold there. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute z-0 sm:hidden"
        src="/brand/identity-strip-emblem.png"
        style={{
          // 64 / 4 / 0 are 128 halved and the text column's own gutter. Read the paragraph above.
          height: "64px",
          opacity: 0.2,
          right: "4px",
          top: "0px",
          width: "auto",
        }}
      />
      {/* DESKTOP, WITH A PHOTO: the portal banner's own phoenix wash, rising from behind the
          standing portrait — "SHOW THE PHX LOGO FROM BEHIND AS A WATERMARK", then "watermark
          mo2ref" at the badge that was doing that job. Read WASH_STYLE before changing a number;
          the file, not the CSS, is what makes this read as a watermark. */}
      {photoSrc ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-0 hidden sm:block"
          style={WASH_STYLE}
        >
          <div className="absolute inset-0 overflow-hidden" style={WASH_MASK}>
            <div className="absolute inset-0" style={WASH_BODY_STYLE} />
            <div className="absolute inset-0" style={WASH_BLOOM_STYLE} />
            <div className="absolute inset-0" style={WASH_CARVE_STYLE} />
            <div className="absolute inset-0" style={WASH_LIFT_STYLE} />
            <div
              className="phx-wash-strike absolute bottom-[-20%] left-[-8%] top-[-20%] w-[34%]"
              style={WASH_STRIKE_STYLE}
            />
          </div>
        </div>
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute z-0 hidden sm:block"
          src="/brand/identity-strip-emblem.png"
          style={EMBLEM_DESKTOP_STYLE}
        />
      )}

      {/* MOBILE ONLY: the portrait as the card's own leading edge — see PORTRAIT_FADE_MASK.

          IT IS `aria-hidden`, NOT A SECOND ANNOUNCEMENT. The framed portrait below carries the
          real alt text and this replaces it at the same breakpoint, but the person's name sits
          two inches to its right in plain text, so a screen reader loses nothing and is spared
          "portrait of X" twice from one bar. It is also what keeps this out of the golden rule's
          overflow measurement, correctly: a decorative bleed is MEANT to cross the edge.

          NO PHOTO, NO BLEED. A frameless nothing is not a design — it is a gap. So this renders
          only when there is a real photo, and the initials keep the framed tile at every width.

          The widths here are LITERAL Tailwind classes on purpose: `w-[108px]` and the `pl-[112px]`
          below are a matched pair (108 of photo, 4 of air), and a class name built from a constant
          is purged from the stylesheet and silently renders as nothing. Change them together. */}
      {photoSrc ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 top-0 z-[1] w-[124px] sm:hidden"
          style={{ maskImage: PORTRAIT_FADE_MASK, WebkitMaskImage: PORTRAIT_FADE_MASK }}
        >
          <Image
            alt=""
            className="object-cover object-top"
            fill
            sizes="124px"
            src={photoSrc}
            unoptimized
          />
        </div>
      ) : null}

      {/* Content sits ABOVE the wave, not on it — hence the bottom inset. The leading inset is
          the bleeding portrait's width plus 4px of air; with no photo there is no bleed, so it
          falls back to the ordinary gutter and the framed initials tile takes the space. */}
      <div
        className={[
          "absolute inset-x-0 bottom-[24px] top-0 z-10 flex min-w-0 items-center gap-4 pr-4 sm:pl-6 sm:pr-6",
          photoSrc ? "pl-[128px]" : "pl-4",
        ].join(" ")}
      >
        <span
          className={[
            "relative h-[80px] w-[80px] shrink-0 sm:h-[136px] sm:w-[136px]",
            // Mobile hands the portrait over to the frameless bleed above and desktop hands it to
            // the standing portrait at the trailing edge — so with a photo this tile draws at
            // NEITHER width. It survives as the no-photo fallback, where initials still need a
            // frame of their own.
            photoSrc ? "hidden" : "block",
          ].join(" ")}
        >
          {/* TWO RINGS, MUTUALLY EXCLUSIVE BY BREAKPOINT. One element would be neater, but an
              inline style cannot carry a media query and these two shadows are genuinely
              different things — see PORTRAIT_GLOW / PORTRAIT_RING above. */}
          <span
            aria-hidden="true"
            className="absolute inset-0 sm:hidden"
            style={{ background: PORTRAIT_BEZEL, boxShadow: PORTRAIT_GLOW }}
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 hidden sm:block"
            style={{ background: PORTRAIT_BEZEL, boxShadow: PORTRAIT_RING }}
          />
          <span className="absolute inset-[2px] overflow-hidden bg-[#f8efe5]">
            {photoSrc ? (
              <Image
                alt={`${name} portrait`}
                className="object-cover object-top"
                fill
                sizes="136px"
                src={photoSrc}
                unoptimized
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-3xl font-black text-[#f47b20]">
                {initialsFor(name)}
              </span>
            )}
          </span>
        </span>

        <span
          aria-hidden="true"
          className="hidden h-12 w-px shrink-0 sm:block"
          style={{ background: "linear-gradient(180deg, transparent, #e0d0bc 20%, #e0d0bc 80%, transparent)" }}
        />

        {/* The name ceiling is 2.4rem (38.4px) and that number is MEASURED, not chosen. The
            strip's inner content box is 76px at `sm`, and the tallest real case — "HR OPERATIONS
            COORDINATOR" over a name — came to 61px at 2rem, leaving 24px. 2.4rem spends 7 of
            those and keeps 16px of clearance, so nothing clips. Raise it further only after
            re-measuring `textColumn.bottom` against the strip height on the HR landing, which is
            the worst case: it carries the longest title in the system.

            WHY IT MATTERS THAT THIS IS BIG. The KPI numerals immediately below are 30px at weight
            900. At the old 1.7rem cap the person's own name was SMALLER and four times lighter
            than the dashboard counters under it, which is what the owner saw.

            THIS BLOCK SPANS THE BAR, and that is a correction, not a drift from the card.
            It was `w-fit`, so the rule and title took the NAME's width — the card's relationship,
            faithfully copied. On a 1084px admin bar it measured a disaster: all content ended at
            208px and 81% of the strip was empty cream. The owner, 2026-09-03: "The banner is too
            small. It's too small in comparison with the dashboard." The card can hug its name
            because it is nearly square; a strip four times wider cannot. So the column flexes and
            the rule runs out across the bar. Height is untouched — that part of his instruction
            still holds. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* THE NAME STOPS BEFORE THE PHOENIX TOO — the owner, 2026-09-04: "the name too, end it
              before the logo." Same clearance as the rule below it, and from the same arithmetic
              at each breakpoint: the mark's ink starts 55.9px in from the bar's trailing edge on a
              phone and 128.75px in from `sm` up, so the box ends 68px / 141px in — which is 52px
              of margin on a phone (`pr-4`) and 117px from `sm` up (`pr-6`).

              FROM `sm` UP IT IS NOW `--phx-text-gap`, AND THAT IS NOT A WEAKER RULE — IT IS THE
              SAME ONE, STATED AGAINST A PORTRAIT THAT MOVES. The portrait's width is a viewport
              clamp now, and the phoenix is positioned off that width so it shows from behind the
              frame, so a fixed pixel margin here could only be right at one viewport. The gap is
              W + 50 (frame, plus the 62px of phoenix ink that stands clear of it, plus 12 of air,
              net of the wrapper's own `pr-6`) — so the name ends clear of the MARK at every width,
              which is the instruction. The 117px fallback is the no-photo path, where there is no
              standing portrait and the mark is back in the SATO column: that is its old number,
              unchanged. The PHONE margin is untouched at 52px — no standing portrait on a phone.

              THE MARGIN IS A CLASS AND THE RESET IS INLINE, and they must stay split that way. An
              inline style beats any class, so the `margin: 0` that used to sit in the style object
              would silently swallow `mr-[52px]` and put the name back under the mark with nothing
              to show for it — the longhands below reset only the top, bottom and left, and leave
              the right to the two classes.

              THE PHONE READING WAS THE COST, AND HE SPENT THE MARK INSTEAD. Clearing the full-size
              watermark left the name 98px to live in on a 351px bar, and the script fell to a size
              he would not have accepted. The answer was the one this comment already predicted —
              the mark is what gave: halved and moved into the corner, its ink now begins 55.9px
              in, so the name keeps 171px and renders at its natural 32px. If a later change grows
              the phone mark again, this margin grows with it and the name shrinks again, so
              measure the name at 375px before accepting that trade. */}
          <p
            className="italic font-medium text-[#3f3a33] mr-[52px] sm:mr-[var(--phx-text-gap,117px)]"
            ref={nameBoxRef}
            style={{
              fontFamily: '"Pinyon Script", cursive',
              fontSize: nameFontPx ? `${nameFontPx}px` : "clamp(2rem, 5vw, 3.1rem)",
              lineHeight: 1.15,
              marginBlock: 0,
              marginLeft: 0,
              whiteSpace: "nowrap",
            }}
          >
            <span ref={nameRef} style={{ display: "inline" }}>
              {sigName}
            </span>
          </p>
          {/* THE RULE STOPS BEFORE THE PHOENIX. The owner, 2026-09-04, on the line under the name:
              "it's under the name ... I wanted to end before it reached the logo ... I wanted
              layer the above or below the photo, the phoenix photo logo." Sized to the SATO mark
              earlier the same day, the watermark grew into the space this rule used to run out
              across, and the gradient tail crossed it at both widths. Ending the rule short is the
              first of the two answers he offered; the mark itself does not move.

              THE MARGIN IS THE MARK'S OWN INK EDGE, not a nudge, and it is read per breakpoint.
              On a phone the corner mark above draws 39.4px of ink beginning 55.9px in from the
              bar's trailing edge; twelve pixels of air puts the end of this rule at 68px, and this
              row sits inside a column that already stops at the content wrapper's own `pr-4`, so
              the margin is 52. FROM `sm` UP THE MARK MOVES WITH THE PORTRAIT, so the number does
              too: `--phx-text-gap` is W + 50 with a photo (the frame, the 62px of ink standing
              clear of it, 12 of air, net of `pr-6`) and 117px without one, which is the old
              SATO-column arithmetic — the fallback 128px emblem at `right: 25px` puts its ink's
              left edge 128.75px in, and 117 + 24 of padding clears that by 12. CHANGE AN EMBLEM NUMBER OR THE PORTRAIT
              CLAMP AND THIS MOVES WITH IT — `tests/identity-strip-emblem.test.ts` recomputes both
              ink edges and fails if the clearance stops covering them.

              IT IS THE RULE ALONE, deliberately. Reserving the column on the WRAPPER instead would
              take the same width off the text block at every breakpoint, and a phone cannot spare
              it: the column is ~223px at 375px and already carries four lines, so the title would
              wrap a third time and clip against `overflow-hidden`. The name carries its own copy
              of the margin, for the same reason. */}
          <span
            aria-hidden="true"
            className="mt-[2px] mr-[52px] flex items-center sm:mr-[var(--phx-text-gap,117px)]"
          >
            <span className="h-[2px] flex-1" style={{ background: "#f47b20" }} />
            <span className="mx-[5px] h-[7px] w-[7px]" style={{ background: "#f47b20" }} />
            <span
              className="h-[2px] flex-[2]"
              style={{ background: "linear-gradient(90deg, rgba(244,123,32,0.5), rgba(244,123,32,0))" }}
            />
          </span>
          {/* THE TITLE WRAPS, and must keep wrapping. At this tracking "HR OPERATIONS
              COORDINATOR" is wider than the column has at 375px. Left `nowrap` it would not
              scroll the page — this section is `overflow-hidden`, so it would CLIP, which is the
              failure `scrollWidth > clientWidth` is blind to (AGENTS.md §4).

              THE SPARE ROOM IS NOW SMALL, because the HR ID below took a fourth line. Worst case
              is the HR landing at 375px: a wrapped two-line title AND the HR ID under a name at
              the clamp's 1.25rem floor. That is what to re-measure before adding anything else to
              this column, or before raising the name ceiling back. */}
          <p
            className={
              "break-words text-left font-bold uppercase text-[10px] tracking-[0.12em]"
              + " sm:text-[13px] sm:tracking-[0.18em]"
            }
            style={{ color: "#f47b20", lineHeight: 1.2, margin: "2px 0 0" }}
          >
            {titleLabel}
          </p>
          {/* THE HR ID SITS UNDER THE TITLE, not at the trailing edge — the owner, 2026-09-04:
              "HR ID UNDER TITLE". It reads as part of the identity block now rather than as a
              figure floating at the far right of a wide bar.

              IT COSTS A FOURTH LINE, and the strip's height is fixed, so the name ceiling came
              down with it — 2.4rem to 2rem. 32px still clears the 30px KPI numerals below, which
              is what #3050 was protecting, and anything smaller gives that back.

              THE TYPE SCALE IS PER-BREAKPOINT, and that is the fix for a real complaint. The
              title and this line were a fixed 13px/12px at EVERY width while the name scaled with
              the viewport, so the ratio silently inverted on a phone: the title was 26% of the
              name on desktop and 46% of it at 375px, bold and wide-tracked, wrapped onto two
              lines. It outweighed the person's own name. The owner: "the mobile view, the font of
              the title is very big. It's very incompatible."

              So mobile alone drops to 10px/0.12em and 9px, and the name's clamp FLOOR came up from
              1.75rem to 2rem. The title then fits one line, the block goes from four lines to
              three, and measured spare went 2px -> 11px at 375px and 5px at 320px. Desktop is
              untouched at 13px/12px with the name at 49.6px.

              KEEP THE SIZES AS LITERAL ARBITRARY CLASSES (`text-[10px]`), never a named size —
              tailwind-merge silently DROPS custom named font sizes, and only a real browser can
              see it happen (AGENTS.md). Re-measure both widths before adding a line here. */}
          {employeeCode ? (
            <p
              className="font-semibold text-[#3f3a33] opacity-75 text-[9px] sm:text-[12px]"
              style={{ letterSpacing: "0.08em", lineHeight: 1.2, margin: "4px 0 0" }}
            >
              {employeeCode}
            </p>
          ) : null}
        </div>
      </div>

      {/* The card's wave, scaled to this height. */}
      <svg
        aria-hidden="true"
        className="absolute bottom-0 left-0 z-[3] h-[30px] w-full"
        preserveAspectRatio="none"
        viewBox="0 0 1875 118"
      >
        <path d="M0 38C420 58 1030 58 1875 4V118H0Z" fill="#231e18" />
        <path d="M0 38C420 58 1030 58 1875 4" fill="none" stroke="#f47b20" strokeWidth="11" />
      </svg>
    </section>

    {/* DESKTOP: THE PORTRAIT STANDS AT THE TRAILING EDGE AND HANGS BELOW THE BAR — the owner,
        2026-10-12, drawing the shape himself: "MAKE THE PHOTO ON THE RIGHT OF THE BANNER AND MAKE
        IT BIGGER WHILE NEVER TOUCH THE BANNER SO THE BANNER AND THE PHOTO LOOKS LIKE REVERTED L
        LETTER", then "L MA2LOOB -------| KDA TEB2A BASA L TAHT KDA" — a bar with a column dropping
        from its right end.

        IT IS A SIBLING OF THE BAR, NOT A CHILD OF IT, AND THAT IS THE WHOLE TRICK. The bar is
        `overflow-hidden` (the watermark and the wave both rely on it), so a portrait taller than
        160px inside it would simply be cut at the bar's foot. Rendering it beside the section, in
        a wrapper that positions it, is what lets it stand 88px proud of the bar while the bar
        itself keeps every number it had — "NEVER TOUCH THE BANNER", his words.

        THE OVERHANG IS RESERVED BY A SPACER IN NORMAL FLOW, NOT BY FLOATING OVER THE PAGE. A
        portrait hanging over the first task card would cover live work and would move with it on
        every scroll; the spacer keeps the column its own air and nothing below has to know the
        strip is there. It is rendered only when there IS a photo — the initials tile stays inside
        the bar at both widths.

        IT IS A SPACER AND NOT PADDING ON THE WRAPPER FOR ONE MECHANICAL REASON: the height is now
        viewport-derived (`--phx-portrait-h`) and it must be ZERO below `sm`, where there is no
        standing portrait at all. An inline style cannot carry a media query, and padding written as
        a `sm:` class cannot carry a `calc` of a variable without a Tailwind arbitrary property that
        nothing else in this codebase uses. A `hidden sm:block` element whose own height is the
        calc does both, with no new mechanism.

        ITS 16px IS AIR, NOT SLACK. Reserving the overhang exactly put the portrait's foot and the
        next section's top border on the same line (both y=333, measured on the branch), which reads
        as a collision rather than a column standing on the page.

        THE FRAME IS HEAVIER THAN THE IN-BAR TILE'S ON PURPOSE. 3px of gold around a 136px tile is
        the same ANGLE as 4px around a 188px one; held at 3 the bezel thinned out as the portrait
        grew and the big photo lost its mount. The well also carries a 1px ink hairline inside the
        gold, which is what a mounted print has and what stops a bright photo from bleeding into
        its own frame.

        MOBILE KEEPS THE FRAMELESS BLEED. This is a `sm:` element only; on a phone the photo is
        still the bar's own leading edge, which is his 2026-09-04 instruction and is untouched. */}
    {/* THE RESERVED BAND IS WORKING SPACE NOW, NOT AIR — the owner, 2026-10-12, with the empty
        band circled in red: "the market space donot leave it like this make use of it for example
        for a notification center or any other idea workable". So the overhang the portrait opened
        carries the viewer's own notices; `PhoenixIdentityNotices` reads the bell's endpoint, so the
        band and the bell can never disagree.

        ONE ELEMENT STILL DOES BOTH JOBS, AND IT IS THE SAME ELEMENT AS BEFORE. As a flex row, the
        reserving column's own height sets the row's minimum — which is what the bare spacer did —
        and its width keeps the notices clear of the portrait standing over them. `hidden sm:block`
        is still how a viewport-derived `calc` reaches a breakpoint without an inline media query,
        and the row grows past the minimum when a long notice needs it, which is why the band has a
        min-height and never a fixed one. The 16px of air is `gap-4`.

        NO PHOTO, NO COLUMN: there is no standing portrait, nothing is reserved, and the notices take
        the full width under the bar. */}
    <div className="flex items-stretch gap-4">
      {reserve ? (
        // The caller's content takes the air, so the notices draw their rail and no peek.
        <div className="flex min-w-0 flex-1 flex-col">
          {showNotices ? <PhoenixIdentityNotices reservesAir={false} /> : null}
          <div className="flex min-w-0 flex-auto shrink-0 flex-col pt-1.5">{reserve}</div>
        </div>
      ) : showNotices ? (
        // `reservesAir` is the photo, and nothing else: the spacer beside this band exists only when
        // there IS a standing portrait, so it is the one condition under which the shut band has air
        // to fill without growing the page. See the prop's own header in that file.
        <PhoenixIdentityNotices className="flex-1" reservesAir={Boolean(photoSrc)} />
      ) : (
        <span className="flex-1" />
      )}
      {photoSrc ? (
        <span
          aria-hidden="true"
          className="hidden shrink-0 sm:block"
          style={{ height: "calc(var(--phx-portrait-h) - 144px)", width: "var(--phx-portrait-w)" }}
        />
      ) : null}
    </div>
    {photoSrc ? (
      <span
        className="pointer-events-none absolute right-0 top-0 z-20 hidden sm:block"
        style={{ height: "var(--phx-portrait-h)", width: "var(--phx-portrait-w)" }}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0"
          style={{ background: PORTRAIT_BEZEL, boxShadow: PORTRAIT_STANDING_SHADOW }}
        />
        <span className="absolute inset-[4px] overflow-hidden bg-[#f8efe5]">
          <Image
            alt={`${name} portrait`}
            className="object-cover object-top"
            fill
            sizes="(min-width: 1576px) 268px, 17vw"
            src={photoSrc}
            unoptimized
          />
          {/* OVER the photo, not under it. An `inset` box-shadow on the well itself paints on the
              well's own background layer, which a `fill` image covers completely — the hairline
              would be in the file and invisible on the page. */}
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{ boxShadow: "inset 0 0 0 1px rgba(35,30,24,0.26)" }}
          />
        </span>
      </span>
    ) : null}
    </div>
  );
}
