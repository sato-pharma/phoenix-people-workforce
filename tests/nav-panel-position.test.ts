import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  clampPanelToViewport,
  NAV_PANEL_GUTTER,
  NAV_PANEL_WIDTH,
  placeAnchoredPanel,
  subscribeToViewportChange,
  VIEWPORT_CHANGE_EVENTS,
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

  // ── Right-aligned panels: the notifications bell, measured on production ─────────────────────
  // 2026-09-02, revision 99c9909f2: the bell sat at x=265..301 in a 375px viewport and its panel
  // opened at `left: -50 → right: 301` — 50px off the LEFT edge, clipped. The exact mirror of the
  // "+" panel's failure, which is the whole reason both edges are covered here.
  //
  // Note what it proves about narrowing: the panel's width was ALREADY capped at 100vw-24 = 351 and
  // it still hung off the screen. Width was never the problem; the anchor's position was.
  {
    const gutter12 = 12;
    const placed = placeAnchoredPanel({
      align: "right",
      anchorLeft: 265,
      anchorRight: 301,
      gutter: gutter12,
      preferredWidth: 380,
      viewportWidth: 375,
    });
    const left = 265 + placed.offsetLeft;
    const right = left + placed.width;
    assert.ok(left >= gutter12, `the bell panel must not hang off the LEFT: landed at ${left}`);
    assert.ok(right <= 375 - gutter12, `nor off the right: right edge ${right}`);
    // Anti-vacuity: unclamped, right-alignment genuinely put it at -50.
    assert.equal(301 - Math.min(380, 375 - gutter12 * 2), -50, "the fixture must reproduce the measured -50");
  }

  // Right-alignment must still be HONOURED when there is room — otherwise this "fix" silently
  // relocates every desktop dropdown to the left of its trigger, which is its own regression.
  {
    const placed = placeAnchoredPanel({
      align: "right",
      anchorLeft: 1360,
      anchorRight: 1396,
      gutter: 12,
      preferredWidth: 380,
      viewportWidth: 1440,
    });
    const left = 1360 + placed.offsetLeft;
    assert.equal(left + placed.width, 1396, "with room to spare the panel's right edge meets the anchor's");
    assert.equal(placed.width, 380, "and it keeps its full width");
  }

  // Both alignments, swept — neither may ever escape either edge.
  {
    for (const viewportWidth of [320, 375, 414, 768, 1024, 1440]) {
      for (const anchorLeft of [0, 12, 40, 184, 265, 300, Math.max(0, viewportWidth - 36)]) {
        for (const align of ["left", "right"] as const) {
          const placed = placeAnchoredPanel({
            align,
            anchorLeft,
            anchorRight: anchorLeft + 36,
            gutter: 12,
            preferredWidth: 380,
            viewportWidth,
          });
          const left = anchorLeft + placed.offsetLeft;
          const right = left + placed.width;
          assert.ok(
            left >= 12 - 0.5 && right <= viewportWidth - 12 + 0.5,
            `${align}-aligned panel escaped: anchor ${anchorLeft} in ${viewportWidth} placed ${left}→${right}`,
          );
        }
      }
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

  // ── A rotation must RE-place the panel, not leave it wearing the old viewport's offset ────────
  // The gap the clamp above did not cover. Every caller measures its anchor in the click handler,
  // so the placement is correct at the moment of opening and frozen from then on. Rotate a phone
  // from landscape to portrait with the notifications bell open and the panel keeps a width and an
  // offset computed for an 812px viewport, in a 375px one.
  {
    // The bell's real constants, and a right-aligned topbar control: 12px in from the right edge at
    // any width, 36px square (`h-9 w-9`).
    const width = 380;
    const gutter = 12;
    const landscapeViewport = 812;
    const portraitViewport = 375;
    const anchorIn = (viewportWidth: number) => ({
      left: viewportWidth - gutter - 36,
      right: viewportWidth - gutter,
    });
    const place = (viewportWidth: number) => {
      const anchor = anchorIn(viewportWidth);
      return placeAnchoredPanel({
        align: "right",
        anchorLeft: anchor.left,
        anchorRight: anchor.right,
        gutter,
        preferredWidth: width,
        viewportWidth,
      });
    };

    // Opened in landscape, where it is correct.
    const opened = place(landscapeViewport);
    const landscapeLeft = anchorIn(landscapeViewport).left + opened.offsetLeft;
    assert.ok(
      landscapeLeft >= gutter && landscapeLeft + opened.width <= landscapeViewport - gutter,
      `sanity: the panel must open on screen in landscape, got left ${landscapeLeft}`,
    );

    // Now rotate. The anchor moves with the topbar; a frozen placement does not.
    const portraitAnchor = anchorIn(portraitViewport);
    const staleLeft = portraitAnchor.left + opened.offsetLeft;
    assert.ok(
      staleLeft < 0,
      `the fixture must genuinely break, or it proves nothing: the stale placement put the left edge at ${staleLeft} in a ${portraitViewport}px viewport`,
    );
    assert.ok(
      opened.width > portraitViewport - gutter * 2,
      "and the stale WIDTH must genuinely overflow too — the panel is re-placed for both reasons",
    );

    // What the resize listener now does: measure again against the new viewport.
    const replaced = place(portraitViewport);
    const left = portraitAnchor.left + replaced.offsetLeft;
    const right = left + replaced.width;
    assert.ok(
      left >= gutter && right <= portraitViewport - gutter,
      `after re-placing, the panel must sit inside the rotated viewport: ${left} → ${right} in ${portraitViewport}px`,
    );
  }

  // ── The subscription that triggers that re-placement ─────────────────────────────────────────
  {
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    let repositioned = 0;
    const target = {
      addEventListener: (type: string, listener: () => void) => {
        calls.push(`+${type}`);
        listeners.set(type, listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        calls.push(`-${type}`);
        // Only drop it if it is the SAME reference — the bug this guards is a cleanup that detaches
        // a freshly-created closure and silently leaves the real listener attached for ever.
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    };

    const unsubscribe = subscribeToViewportChange(target, () => {
      repositioned += 1;
    });
    assert.deepEqual(
      calls,
      VIEWPORT_CHANGE_EVENTS.map((event) => `+${event}`),
      "both viewport events must be watched: a desktop drag fires resize, a phone rotation fires orientationchange",
    );

    for (const listener of listeners.values()) listener();
    assert.equal(
      repositioned,
      VIEWPORT_CHANGE_EVENTS.length,
      "every watched event must re-run the placement",
    );

    unsubscribe();
    assert.deepEqual(
      calls.slice(VIEWPORT_CHANGE_EVENTS.length),
      VIEWPORT_CHANGE_EVENTS.map((event) => `-${event}`),
      "cleanup must detach everything it attached",
    );
    assert.equal(
      listeners.size,
      0,
      "cleanup must pass the same listener reference, or a closed panel keeps re-placing for ever",
    );
  }

  // ── Every panel must actually SUBSCRIBE, not just be capable of re-placing ────────────────────
  // The section above proves the arithmetic re-places correctly when it is re-run. This is the half
  // that proves it IS re-run: without the hook wired in, a rotation never calls it and the panel
  // keeps the stale offset. Source-pinned because these are JSX modules the runner cannot import.
  {
    const panels = [
      "src/components/layout/in-app-notifications-bell.tsx",
      "src/components/layout/internal-messages-menu.tsx",
      "src/components/layout/nav-row-add-button.tsx",
    ];

    for (const path of panels) {
      const source = readFileSync(path, "utf8");
      assert.ok(
        /useRepositionOnViewportChange\(\s*open\s*,/.test(source),
        `${path} must re-place its panel on a viewport change — a rotation with the panel open otherwise leaves it off-screen`,
      );
      // The measurement has to be reachable from outside the click handler, or the hook has nothing
      // to call. `event.currentTarget` is what makes it unreachable, so it must be gone.
      assert.ok(
        !/const\s+(anchor|rect)\s*=\s*event\.currentTarget\.getBoundingClientRect\(\)/.test(source),
        `${path} must measure via a ref, not event.currentTarget — a resize has no event to read`,
      );
      assert.ok(
        /buttonRef/.test(source),
        `${path} must hold a ref to its anchor so the placement can be recomputed later`,
      );
    }
  }
}
