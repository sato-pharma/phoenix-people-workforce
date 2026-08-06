import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// The pharmacy combo box must open where there is room for it.
//
// Reported from production: typing a pharmacy name opened a list "at the end of the page and
// unscrollable". Measured on the live admin submit form — the list is a fixed 320px and always
// opened downward, and this input sits low in a long form. With a phone keyboard up there were
// ZERO visible pixels of it, and no scrolling could reveal it: an absolutely-positioned list
// cannot be scrolled to when the space simply does not exist.
//
// The rep cannot pick a pharmacy, so the order is submitted as a NEW pharmacy instead — which is
// the held lane, the validation desk, and a provisional pharmacy on a 90-day clock. A dropdown
// that cannot be reached does not merely annoy; it manufactures exactly the phantom-pharmacy risk
// the whole V2 gate exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrdersPharmacyComboboxPlacementTests() {
  const source = readFileSync(
    new URL("../src/components/direct-orders/pharmacy-combo-box.tsx", import.meta.url),
    "utf8",
  );

  // ── The height must be measured, never asserted by a class ────────────────
  assert.doesNotMatch(
    source,
    /max-h-80/,
    "the list must not carry a fixed 320px cap — that is the bug: 320px of list where only 100px " +
      "of room exists puts the rest under the keyboard, and no amount of scrolling reveals it",
  );
  assert.match(
    source,
    /style=\{\{ maxHeight: `\$\{placement\.maxHeight\}px` \}\}/,
    "the height must come from the measurement",
  );

  // ── visualViewport is the load-bearing part ───────────────────────────────
  // window.innerHeight does NOT shrink when a mobile keyboard opens. Measuring against it would
  // compute plenty of room below and place the list straight back under the keyboard — the bug,
  // reproduced by the fix meant to cure it.
  assert.match(
    source,
    /window\.visualViewport/,
    "available room must be measured against visualViewport — window.innerHeight does not shrink " +
      "for the on-screen keyboard, so measuring against it re-creates the exact bug",
  );
  assert.match(
    source,
    /visualViewport\?\.addEventListener\("resize"/,
    "the list must re-measure when the keyboard opens or closes",
  );

  // ── It must be able to flip above the input ───────────────────────────────
  assert.match(
    source,
    /placement\.dropUp \? "bottom-full mb-1" : "mt-1"/,
    "when there is more room above than below, the list must open upward",
  );
  assert.match(
    source,
    /const dropUp = below < 176 && above > below;/,
    "flip only when below is genuinely too tight AND above is roomier — a list that flips on every " +
      "keystroke is worse than one that is merely short",
  );

  // ── Scroll in a container must re-measure ─────────────────────────────────
  assert.match(
    source,
    /addEventListener\("scroll", measure, true\)/,
    "scroll must be listened for in the CAPTURE phase — the form can sit inside a scrolling " +
      "container, and a container's scroll event does not bubble to window",
  );

  // ── The repo's lint rule, which is an ERROR here ──────────────────────────
  assert.match(
    source,
    /requestAnimationFrame\(measure\)/,
    "the measurement's setState must run in a scheduled callback, never in the effect body — " +
      "react-hooks/set-state-in-effect is an error in this repo and is invisible to typecheck",
  );
  assert.match(
    source,
    /cancelAnimationFrame\(raf\)/,
    "the scheduled measurement must be cancelled on cleanup, or it fires against an unmounted list",
  );

  // ── The list scrolls itself, not the page behind it ───────────────────────
  assert.match(
    source,
    /overscroll-contain/,
    "scrolling to the end of the list must not start scrolling the form behind it, which on a " +
      "phone reads as the list running away from the thumb",
  );
}
