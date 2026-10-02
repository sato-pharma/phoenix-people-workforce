/**
 * Making sure a click reaches the control the robot resolved — not whatever is lying on top of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 THE INCIDENT THIS EXISTS FOR, measured on production 2026-10-02. The joiner failed to create
 * three mailboxes with `Waiting for selector input[name="emailLocal"] failed`, and the form it was
 * waiting for was perfectly present. What actually happened:
 *
 *   - the driver launched Chromium with NO viewport, so puppeteer's default 800x600 applied;
 *   - at 600px tall, Turbify's cookie-consent banner — `position: fixed`, `z-index: 99999`, 188px
 *     tall — covered everything below y=412;
 *   - the "Email user" button sat at y=430, inside that band. `document.elementFromPoint` at the
 *     button's own centre returned the BANNER;
 *   - `handle.click()`, which clicks the element's centre COORDINATES, therefore clicked the banner
 *     — and reported no error whatsoever. The modal never opened, and the step failed 20 seconds
 *     later pointing at a selector that was never the problem.
 *
 * At 1400x900 the same page, the same code and the same click all work, which is why the original
 * reconnaissance recorded these locators as proven: it had a viewport set.
 *
 * 🔴 SO A COORDINATE CLICK THAT REPORTS SUCCESS IS NOT EVIDENCE THE CONTROL WAS CLICKED. That is the
 * durable lesson, and it is why this module exists rather than just a bigger viewport: a viewport
 * only makes this particular overlap unlikely, while the hit test makes the whole class visible.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * HOW IT RESOLVES, and why a DOM click is the right fallback rather than a refusal.
 *
 * The danger with clicking is hitting the WRONG element. By the time this runs that danger is gone:
 * `resolveOne` has already matched EXACTLY ONE element, or thrown. So the only open question is how
 * to deliver the click to an element we have positively identified — and `element.click()` in the
 * page cannot land anywhere else, because it dispatches on the node rather than at a point.
 *
 * So: hit-test first, click by coordinates when the control is genuinely on top (the faithful,
 * real-user path), and dispatch on the node when something is covering it — saying so in the log,
 * because an overlay is worth knowing about even when it is handled.
 *
 * It never dismisses the consent banner. Accepting cookies on the owner's behalf is not this
 * robot's decision to make, and guessing inside a consent dialog is exactly what this codebase
 * refuses to do everywhere else.
 */

/** A big, realistic window. Set explicitly because the default 800x600 is what caused the incident. */
export const CONSOLE_VIEWPORT = { height: 900, width: 1400 } as const;

export type HitTest = {
  /** True when the element at the control's own centre IS the control (or inside it). */
  isTopmost: boolean;
  /** What was found there instead, for the log. Null when `isTopmost`. */
  obstruction: { tag: string; text: string } | null;
};

export type ClickDelivery =
  | { via: "coordinates" }
  | { via: "node"; reason: string };

/**
 * Decide how to deliver the click.
 *
 * Pure so the decision is provable without a browser — the hit test itself is one in-page
 * expression, but *what to do about it* is the part that must not drift.
 */
export function decideClickDelivery(hit: HitTest, purpose: string): ClickDelivery {
  if (hit.isTopmost) return { via: "coordinates" };
  const what = hit.obstruction
    ? `${hit.obstruction.tag}${hit.obstruction.text ? ` ("${hit.obstruction.text}")` : ""}`
    : "something with no readable text";
  return {
    reason:
      `${what} is covering the ${purpose}, so a click at its coordinates would have hit that instead. `
      + "Dispatching on the element itself, which cannot land anywhere else.",
    via: "node",
  };
}

/**
 * The in-page hit test for one element handle.
 *
 * Returns `isTopmost: true` when it cannot tell — a hit test that fails must not turn into a
 * refusal, because the coordinate click is still the normal path and this is a diagnostic
 * improvement on it, not a new gate.
 */
export const HIT_TEST_EXPRESSION = `(element) => {
  try {
    const r = element.getBoundingClientRect();
    if (!r.width || !r.height) return { isTopmost: true, obstruction: null };
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    if (!top) return { isTopmost: true, obstruction: null };
    if (top === element || element.contains(top) || top.contains(element)) {
      return { isTopmost: true, obstruction: null };
    }
    return {
      isTopmost: false,
      obstruction: {
        tag: (top.tagName || "").toLowerCase(),
        text: (top.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 60),
      },
    };
  } catch {
    return { isTopmost: true, obstruction: null };
  }
}`;

/** Dispatch a click on the node, bypassing whatever is painted over it. */
export const NODE_CLICK_EXPRESSION = `(element) => { element.click(); }`;
