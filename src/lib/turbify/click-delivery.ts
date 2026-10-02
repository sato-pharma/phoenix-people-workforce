/**
 * Making sure a click reaches the control the robot resolved — not whatever is lying on top of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 TWO INCIDENTS LIVE HERE, AND THE SECOND WAS CAUSED BY THE FIX FOR THE FIRST.
 *
 * **One — the cookie banner.** Measured on production 2026-10-02: the joiner failed to create three
 * mailboxes with `Waiting for selector input[name="emailLocal"] failed`, and that form was present
 * the whole time. The driver launched Chromium with NO viewport, so puppeteer's default 800x600
 * applied; at 600px tall Turbify's cookie-consent banner — `position: fixed`, `z-index: 99999`,
 * 188px tall — covered everything below y=412, and the "Email user" button sat at y=430.
 * `document.elementFromPoint` at the button's own centre returned the BANNER, and `handle.click()`
 * clicked those coordinates and reported NO ERROR. At 1400x900 the same page and the same click
 * work, which is why the original reconnaissance recorded those locators as proven.
 *
 * **Two — the fix did nothing, and turned every click into a no-op.** That first fix passed its
 * in-page code as a STRING to `page.evaluate(expression, handle)`. Measured in the container the
 * same night:
 *
 *     page.evaluate('(element) => ({ tag: element.tagName })', handle)  ->  {}
 *     page.evaluate((el) => ({ tag: el.tagName }), handle)              ->  { tag: 'BUTTON' }
 *     handle.evaluate((el) => ({ tag: el.tagName }))                    ->  { tag: 'BUTTON' }
 *
 * A string is evaluated as an EXPRESSION, so `'(element) => {...}'` produces a function object which
 * serialises to `{}` and is never called: the body never runs and the argument is never bound. The
 * consequences chained exactly as the production log showed — the hit test returned `{}`, so
 * `isTopmost` was `undefined` and every control read as covered; `obstruction` was `undefined`, so
 * the log read "something with no readable text is covering the control"; and the node click, also a
 * string, clicked nothing. The driver therefore skipped the real click AND failed to perform the
 * fallback, which is why the create form never opened.
 *
 * 🔴 THE LESSON THAT OUTLIVES BOTH BUGS: asserting on the SOURCE TEXT of in-page code proves nothing
 * about whether it runs. The first fix shipped with green tests that matched substrings of an
 * expression that was never executed. Everything below is a real function, invoked through
 * `handle.evaluate(fn)`, and its tests CALL it rather than reading it.
 */

/** A big, realistic window. Set explicitly because the default 800x600 is what caused incident one. */
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
 * 🔴 A MALFORMED hit test counts as "not covered", so a broken reader degrades to the ordinary
 * coordinate click instead of silently routing every click down the fallback — which is precisely
 * what incident two did. `isTopmost` must be exactly the boolean `false` to mean obstructed.
 */
export function decideClickDelivery(hit: HitTest | null | undefined, purpose: string): ClickDelivery {
  if (!hit || typeof hit.isTopmost !== "boolean" || hit.isTopmost) return { via: "coordinates" };
  const what = hit.obstruction && hit.obstruction.tag
    ? `${hit.obstruction.tag}${hit.obstruction.text ? ` ("${hit.obstruction.text}")` : ""}`
    : "something with no readable text";
  return {
    reason:
      `${what} is covering ${purpose}, so a click at its coordinates would have hit that instead. `
      + "Dispatching on the element itself, which cannot land anywhere else.",
    via: "node",
  };
}

/**
 * Is this element what sits at its own centre?
 *
 * Runs IN THE PAGE via `handle.evaluate(readHitTest)`, so it stays self-contained: it closes over
 * nothing, because puppeteer serialises the function and any captured value would be lost.
 *
 * Returns `isTopmost: true` whenever it cannot tell — the coordinate click is the normal path.
 */
export function readHitTest(element: Element): HitTest {
  try {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return { isTopmost: true, obstruction: null };
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const top = document.elementFromPoint(x, y);
    if (!top) return { isTopmost: true, obstruction: null };
    if (top === element || element.contains(top) || top.contains(element)) {
      return { isTopmost: true, obstruction: null };
    }
    return {
      isTopmost: false,
      obstruction: {
        tag: (top.tagName || "").toLowerCase(),
        text: (top.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
      },
    };
  } catch {
    return { isTopmost: true, obstruction: null };
  }
}

/**
 * Dispatch a click on the node, bypassing whatever is painted over it.
 *
 * Safe only because `resolveOne` has already matched EXACTLY ONE element: the danger with clicking
 * is hitting the wrong thing, and dispatching on an identified node cannot.
 */
export function clickNode(element: Element): void {
  (element as HTMLElement).click();
}

/**
 * Empty a field before typing into it.
 *
 * 🔴 Puppeteer's `type()` APPENDS, and this driver reuses one page for every candidate in a run — so
 * a second search left the box holding both addresses joined (measured on production 2026-10-02: 54
 * characters of `adel.srour@…` + `asmaa.zaghloul@…`). A box in that state filters to nothing, and
 * `createMailbox`'s "does this address already exist?" test reads the filtered page — so the one
 * check standing between a second mailbox and an address that already has one can answer about a
 * string nobody searched for.
 *
 * The `input` event is load-bearing: a controlled React field that is not notified re-renders the old
 * value straight back.
 */
export function clearField(element: Element): void {
  try {
    const field = element as HTMLInputElement;
    if (typeof field.value !== "string") return;
    field.focus();
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  } catch {
    // A field that cannot be cleared keeps the old append behaviour rather than throwing mid-run.
  }
}
