import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// "make the tgt orange" — the owner, 2026-09-12.
//
// The Tgt Units / Tgt Value figures on the Monthly Closing matrix used to borrow the grey the
// renderer gives any dimmed figure. On this grid that grey is not "subtle", it is gone: measured on
// the grounds the grid actually puts those cells on, slate-300 on the Grand Total block's #FBD8A6
// reads 1.09:1 and slate-500 on #F4C078 reads 2.87:1, against a 4.5:1 floor for 14px text. He
// raised it first as "font color is tgt needs to be more clear", and after the whole Sato rebrand
// of that screen was reverted the grey came back with it — so he said it again, in one line.
//
// WHAT THIS FILE GUARDS, AND WHY EACH HALF IS HERE.
//
//   1. THE DECISION. Orange on the Target axis is his, not a design opinion, and it survived five
//      rounds (navy → blue → amber → dark orange → the full revert). The shades are pinned by
//      EQUALITY, so a later session that "tidies" the column back to a muted grey — or to the blue
//      and navy he explicitly refused — goes red in the required `validate` job instead of shipping.
//
//   2. THE FLOOR. A Tgt cell does not sit on one ground. It lands on white, on the band tint, on
//      the family block's amber, on the Grand Total block's orange, on a region subtotal's #FDEAD0,
//      and on a pre-August month on the direct-residue row's blue. The axis is ONE ink anyway —
//      he answered the first cut's per-row ladder with "no noisy" — so that ink has to clear 4.5:1
//      on all of them at once. Section 3 re-measures every pair from the source, so the test fires
//      if EITHER the ink or a ground moves: darkening `bg-[#F4C078]` is exactly as much a
//      regression as darkening the ink, and neither is visible in a diff of the other file.
//
// ON THE BLUE GROUNDS, SO NOBODY READS THEM WRONG LATER. They are NOT how direct orders appear.
// Owner, 2026-09-12: "direct orders are not added as a one row" — and production agrees. Every
// direct row in 2026-08 carries a real area: Pedia 13 rows over 6 areas, Anti Infective 6 over 4,
// zero rows without an area and none coded DIRECT, so the synthetic "◆ Direct – National" row does
// not render at all on a current month. It is the residue band for direct money that belongs to no
// area, which is the shape of 2026-06 and earlier. The grounds stay measured here because those
// months are still openable — not because a closing files direct orders in one row.
//
// The grounds below are asserted to still exist in the component before they are measured, so this
// file can never quietly grade a colour combination the screen has stopped using.
// ─────────────────────────────────────────────────────────────────────────────

const SOURCE = readFileSync(
  new URL("../src/components/sales/closing-matrix-table.tsx", import.meta.url),
  "utf8",
);

/** WCAG 2.1 floor for normal-size text. The grid renders these figures at 14px. */
const FLOOR = 4.5;

type RowVariant = "area" | "subtotal" | "grand";

// ── Section 1 · the ink is his decision, pinned by equality ───────────────────

/** Tailwind's own values for the classes the component uses. Not paraphrased — the palette's. */
const TAILWIND_ORANGE: Record<string, string> = {
  "text-orange-300": "#fdba74",
  "text-orange-800": "#9a3412",
  "text-orange-900": "#7c2d12",
};

const TARGET_INK: Record<RowVariant, string> = {
  area: "text-orange-900",
  subtotal: "text-orange-900",
  grand: "text-orange-300",
};

function runInkPinTests() {
  const fn = SOURCE.match(/function targetText\(variant: RowVariant\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "closing-matrix-table.tsx still has a targetText(variant) helper for the Target axis");
  const body = fn[0];

  // ONE ink for the whole axis, and one exception for the black rows. He answered a per-row ladder
  // with "no noisy", so a third branch is a regression even if every shade in it is orange.
  assert.match(
    body,
    /return variant === "grand" \? "text-orange-300" : "text-orange-900";/,
    'the Target axis is ONE orange — text-orange-900 everywhere, text-orange-300 only on the black '
    + 'grand rows where no dark ink is visible (owner, 2026-09-12: "make the tgt orange", then "no noisy")',
  );
  assert.equal(
    (body.match(/\breturn\b/g) ?? []).length,
    1,
    'targetText has exactly one return — a per-row-variant ladder is the thing he rejected ("no noisy")',
  );

  // NOT ASSERTED, deliberately — two rules that the two lines above already enforce, so a check for
  // either could never fire, and an assertion that cannot fire reads as cover in a diff while
  // giving none. They still hold, and belong in review:
  //
  //   * No navy ("no return it back"), no blue ("idont want it blue"), no muted grey ("font color
  //     is tgt needs to be more clear"). Changing an ink fails the exact-string pin; adding a
  //     branch for one fails the single-return count.
  //   * No font-weight on the Target ink. Same reason — `font-bold text-orange-900` is not the
  //     pinned string. The Tgt headers are `font-normal opacity-60` because the target is the
  //     secondary axis beside the sale, and bolding the figure undoes that.
}

// ── Section 2 · every Target figure is wired to that ink ──────────────────────
//
// Four render sites carry a target: Tgt Units and Tgt Value per product, the family block's
// Tgt Value, and the Grand Total block's Tgt Value. Missing one leaves a column half-grey.

function runWiringTests() {
  const targetProps = SOURCE.match(/<NumCell[^>]*\btarget\b[^>]*\/>/g) ?? [];
  assert.equal(
    targetProps.length,
    4,
    "all four Target figures (Tgt Units, Tgt Value, family Tgt Value, Grand Total Tgt Value) pass "
    + `target — found ${targetProps.length}`,
  );

  for (const [what, pattern] of [
    ["Tgt Units", /<NumCell[^>]*\btarget\b[^>]*value=\{cell\.targetUnits\}/],
    ["Tgt Value", /<NumCell[^>]*\btarget\b[^>]*value=\{cell\.targetValue\}/],
    ["the family block's Tgt Value", /<NumCell[^>]*\btarget\b[^>]*value=\{famTarget\}/],
  ] as const) {
    assert.match(SOURCE, pattern, `${what} renders with the Target axis's own ink`);
  }

  // The old `muted` prop WAS the bug: it routed the Target figures through toneText's dim branch,
  // the same branch a zero sales figure takes. Nothing may reintroduce it.
  assert.ok(
    !/\bmuted\b/.test(SOURCE),
    "no Target figure falls back to the dim grey — the `muted` prop is gone, not merely unused",
  );

  // A blank Target ("no target set") stays in the column's ink so the axis reads as one column.
  assert.match(
    SOURCE,
    /const blankTone = target \? targetText\(variant\)/,
    "an empty Target cell keeps the Target ink rather than dropping to slate",
  );
}

// ── Section 3 · the floor, measured against the grounds the grid really uses ──

function channels(hex: string) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function luminance(hex: string) {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `bg-orange-50/50` composites Tailwind's orange-50 at 50% over the white row beneath it. */
function over(top: string, bottom: string, alpha: number) {
  const [t, b] = [channels(top), channels(bottom)];
  const hex = t
    .map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

type Ground = {
  /** The class as it is written in the component. Asserted present before the colour is graded. */
  token: string | null;
  hex: string;
  what: string;
};

const GROUNDS: Record<RowVariant, Ground[]> = {
  area: [
    { token: null, hex: "#FFFFFF", what: "a plain area row" },
    { token: "bg-orange-50/50", hex: over("#FFF7ED", "#FFFFFF", 0.5), what: "a banded area row" },
    { token: 'bg-[#CFE0FB]', hex: "#CFE0FB", what: "the direct-residue row on a pre-August month" },
    { token: "bg-amber-50", hex: "#FFFBEB", what: "the family summary block" },
    { token: 'bg-[#FBD8A6]', hex: "#FBD8A6", what: "the Grand Total block" },
  ],
  subtotal: [
    { token: 'bg-[#FDEAD0]', hex: "#FDEAD0", what: "a region subtotal row" },
    { token: 'bg-[#B6CEF8]', hex: "#B6CEF8", what: "the direct-residue national row (pre-August months)" },
    { token: "bg-amber-100", hex: "#FEF3C7", what: "the family summary block" },
    { token: 'bg-[#F4C078]', hex: "#F4C078", what: "the Grand Total block" },
  ],
  grand: [{ token: 'bg-[#0B0B0B]', hex: "#0B0B0B", what: "the black grand-total rows" }],
};

function runContrastTests() {
  for (const [variant, grounds] of Object.entries(GROUNDS) as [RowVariant, Ground[]][]) {
    const ink = TAILWIND_ORANGE[TARGET_INK[variant]];
    assert.ok(ink, `${TARGET_INK[variant]} has a pinned hex to measure`);

    for (const ground of grounds) {
      if (ground.token) {
        assert.ok(
          SOURCE.includes(ground.token),
          `${ground.token} is still a ground under a Target cell (${ground.what}) — if it moved, `
          + "re-measure the Target ink against the new ground rather than deleting this line",
        );
      }
      const ratio = contrast(ink, ground.hex);
      assert.ok(
        ratio >= FLOOR,
        `${TARGET_INK[variant]} on ${ground.what} (${ground.hex}) reads ${ratio.toFixed(2)}:1, `
        + `below the ${FLOOR}:1 floor for 14px text`,
      );
    }
  }
}

// ── Section 4 · the shade is the LIGHTEST one that clears the floor ───────────
//
// Not decoration: it is the reason the ink is orange-900 and not something brighter. The axis is
// this dark ONLY because #F4C078 forces it — orange-800 reads 4.40:1 there and orange-700 (#c2410c,
// the hex he picked on 2026-09-12) 3.12:1. If a later design lightens those grounds, this fires and
// names the lighter shade, so the column gets brighter rather than staying dark out of habit.
//
// It fires on the run AFTER a ground change, not on the change itself: section 3's token check
// catches the edit first and stops there. That is the intended order — the maintainer re-syncs the
// GROUNDS table above, runs again, and this tells them the shade can now come back up.

// One ink covers every light ground, so the question is asked against the UNION of them, not per
// row variant: orange-800 already clears all five AREA grounds — it is the subtotal side that
// forces the darker shade — and a per-variant check would read that as "too dark" and be wrong.
// Listed lightest-first; the first shade that clears everything is the one to move to.
const LIGHTER_SHADES = [
  { cls: "text-orange-700", hex: "#c2410c", note: "the shade the owner picked on 2026-09-12" },
  { cls: "text-orange-800", hex: "#9a3412", note: "one step lighter than today's" },
] as const;

function runShadeIsNotTooDarkTests() {
  const lightGrounds = [...GROUNDS.area, ...GROUNDS.subtotal];
  const current = TARGET_INK.area;

  for (const lighter of LIGHTER_SHADES) {
    if (lighter.cls === current) break;
    const failing = lightGrounds.filter((g) => contrast(lighter.hex, g.hex) < FLOOR);
    assert.ok(
      failing.length > 0,
      `${lighter.cls} (${lighter.hex}) now clears ${FLOOR}:1 on every ground the Target axis lands `
      + `on, so ${current} is darker than it needs to be — move the Target ink up to ${lighter.cls}, `
      + `${lighter.note}`,
    );
  }
}

export async function runClosingTargetInkTests() {
  runInkPinTests();
  runWiringTests();
  runContrastTests();
  runShadeIsNotTooDarkTests();
}
