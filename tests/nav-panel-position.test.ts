import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  clampPanelToViewport,
  NAV_PANEL_GUTTER,
  NAV_PANEL_WIDTH,
} from "../src/lib/navigation/panel-position.ts";

/**
 * The nav row's "+" panel must stay on screen — the owner's fits-the-screen golden rule.
 *
 * THE BUG THIS PINS, measured on production 2026-09-02 at revision 803d74e13: the panel opened at
 * `left: 184 → right: 472` in a 375px viewport, about 97px off the right edge, clipped rather than
 * scrollable so that strip could not be reached at all.
 *
 * The trap worth remembering is how it PASSED the check that should have caught it. The rule is
 * usually verified as `scrollWidth > clientWidth` over `main` — and the document measured 375/375
 * throughout, because an ancestor clipped the overflow instead of scrolling. A popover can hang off
 * the side of a page that reports itself as fitting perfectly. Measure the PANEL.
 */
export function runNavPanelPositionTests() {
  const gutter = NAV_PANEL_GUTTER;

  // ── The exact production failure, as a fixture ───────────────────────────────────────────────
  {
    // The upper row's "+" sat at x=184 with a 288px panel in a 375px viewport.
    const placed = clampPanelToViewport({ anchorLeft: 184, viewportWidth: 375 });
    const left = 184 + placed.offsetLeft;
    const right = left + placed.width;

    assert.ok(
      right <= 375 - gutter,
      `the measured production case must now fit: right edge landed at ${right} in a 375px viewport`,
    );
    assert.ok(left >= gutter, `and must not be pushed off the LEFT instead: left edge ${left}`);
    // Proof the fixture is the real bug and not a case that always passed: unclamped, it overflowed.
    assert.ok(184 + NAV_PANEL_WIDTH > 375, "the raw anchored position must genuinely overflow, or this fixture proves nothing");
  }

  // ── Both edges, because the two rows fail in opposite directions ─────────────────────────────
  // The upper row's "+" sits near the right edge of a phone screen and overflows RIGHT; the lower
  // row's sits near the left and would overflow LEFT under a right-anchored or centred panel. Any
  // fix that only handles one of them is not a fix.
  {
    for (const viewportWidth of [320, 375, 414, 768, 1024, 1440]) {
      for (const anchorLeft of [0, 4, 40, 59, 184, 197, 300, viewportWidth - 24, viewportWidth]) {
        const placed = clampPanelToViewport({ anchorLeft, viewportWidth });
        const left = anchorLeft + placed.offsetLeft;
        const right = left + placed.width;
        assert.ok(
          left >= gutter - 0.5 && right <= viewportWidth - gutter + 0.5,
          `panel escaped the viewport: anchor ${anchorLeft} in ${viewportWidth} placed ${left}→${right}`,
        );
        assert.ok(placed.width > 0, "a zero-width panel is not a placement");
      }
    }
  }

  // ── It does not move a panel that already fits ───────────────────────────────────────────────
  // Desktop is the common case and it was never broken; a fix that shifts it is a regression in the
  // layout the owner already approved.
  {
    const placed = clampPanelToViewport({ anchorLeft: 200, viewportWidth: 1440 });
    assert.equal(placed.offsetLeft, 0, "a panel with room to spare must stay flush with its anchor");
    assert.equal(placed.width, NAV_PANEL_WIDTH, "and must keep its full width");
  }

  // ── It narrows only when it must ─────────────────────────────────────────────────────────────
  {
    const roomy = clampPanelToViewport({ anchorLeft: 10, viewportWidth: NAV_PANEL_WIDTH + gutter * 2 });
    assert.equal(roomy.width, NAV_PANEL_WIDTH, "exactly enough room means full width, not narrowed");

    const tight = clampPanelToViewport({ anchorLeft: 10, viewportWidth: 200 });
    assert.equal(tight.width, 200 - gutter * 2, "a viewport narrower than the panel must narrow it");
    const left = 10 + tight.offsetLeft;
    assert.equal(left, gutter, "and there is then exactly one legal position");
  }

  // ── Degenerate viewports must not produce a negative position ────────────────────────────────
  // A 0-width measurement happens in practice — a hidden tab, a pane mid-resize. It must return
  // something inert rather than a panel placed at a negative coordinate.
  {
    for (const viewportWidth of [0, 1, gutter, gutter * 2]) {
      const placed = clampPanelToViewport({ anchorLeft: 0, viewportWidth });
      assert.ok(placed.width >= 0, `width must never be negative (viewport ${viewportWidth})`);
      assert.ok(
        Number.isFinite(placed.offsetLeft),
        `offset must be a real number (viewport ${viewportWidth})`,
      );
    }
  }

  // ── The component must actually USE it ───────────────────────────────────────────────────────
  // Source-pinned because the component is JSX and the runner's type stripping cannot import it.
  // Without this the arithmetic above can be perfect and unreached — which is the shape of "a fix
  // that ships green and is exercised by nobody".
  {
    const source = readFileSync("src/components/layout/nav-row-add-button.tsx", "utf8");
    assert.ok(
      source.includes("clampPanelToViewport("),
      "the + must place its panel through the clamp, not with a fixed className",
    );
    assert.ok(
      /style=\{\{ marginLeft: placement\.offsetLeft, width: placement\.width \}\}/.test(source),
      "the measured placement must reach the panel element, or it is computed and discarded",
    );
    assert.ok(
      !/\bw-72\b/.test(source),
      "the hard-coded w-72 must be gone — a fixed width class would override the clamped one",
    );
    // The clamp is deliberately called from the click handler. An effect would be a lint error here
    // (setState inside useEffect), and this is the kind of thing a later refactor "tidies" into one.
    assert.ok(
      !/useEffect\(/.test(source),
      "placement must stay in the event handler — setState inside useEffect is a lint error in this repo",
    );
  }
}
