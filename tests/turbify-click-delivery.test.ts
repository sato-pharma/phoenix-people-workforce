/**
 * Clicking the control and not the thing on top of it — what this file protects.
 *
 * 🔴 TWO INCIDENTS, AND THE SECOND WAS CAUSED BY THE FIX FOR THE FIRST. Both measured on production
 * 2026-10-02.
 *
 * One: the driver ran at puppeteer's default 800x600 because no viewport was set. Turbify's cookie
 * banner (fixed, z-index 99999, 188px) covered everything below y=412; the "Email user" button sat
 * at y=430; `elementFromPoint` at its centre returned the banner; `handle.click()` clicked the
 * banner and reported NO error. Three mailboxes failed, blaming an innocent selector.
 *
 * Two: that fix passed its in-page code as a STRING to `page.evaluate(expression, handle)`. A string
 * is evaluated as an EXPRESSION, so `"(element) => {...}"` yields a function object that serialises
 * to `{}` and is never called. The hit test returned `{}` → `isTopmost` undefined → every control
 * read as covered; `obstruction` undefined → the log said "something with no readable text"; and the
 * node click, also a string, clicked nothing. **Every click in the driver became a no-op.**
 *
 * 🔴 SO THIS FILE CALLS THE FUNCTIONS. The first fix shipped with GREEN tests that matched substrings
 * of an expression which never executed — asserting on the source text of in-page code proves
 * nothing about whether it runs. Every assertion below exercises real behaviour, and the only
 * source-level checks left are the ones that cannot be expressed any other way: that the driver
 * passes a function rather than a string.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  clearField,
  clickNode,
  CONSOLE_VIEWPORT,
  decideClickDelivery,
  readHitTest,
  type HitTest,
} from "../src/lib/turbify/click-delivery.ts";

/** A stand-in for a DOM element, enough for the three functions to run against. */
function fakeElement(options: {
  rect?: { bottom: number; height: number; left: number; right: number; top: number; width: number };
  tagName?: string;
  textContent?: string;
  value?: unknown;
} = {}) {
  const events: string[] = [];
  let focused = false;
  const el: Record<string, unknown> = {
    click: () => { events.push("click"); },
    contains: (other: unknown) => other === el,
    dispatchEvent: (event: { type: string }) => { events.push(event.type); return true; },
    events,
    focus: () => { focused = true; },
    getBoundingClientRect: () =>
      options.rect ?? { bottom: 60, height: 40, left: 100, right: 220, top: 20, width: 120 },
    tagName: options.tagName ?? "BUTTON",
    textContent: options.textContent ?? "Email user",
    wasFocused: () => focused,
  };
  if ("value" in options) el.value = options.value;
  return el;
}

/** Run `fn` with `document.elementFromPoint` returning `top`. */
function withElementFromPoint<T>(top: unknown, fn: () => T): T {
  const scope = globalThis as unknown as { document?: unknown };
  const had = "document" in scope;
  const previous = scope.document;
  scope.document = { elementFromPoint: () => top };
  try {
    return fn();
  } finally {
    if (had) scope.document = previous;
    else delete scope.document;
  }
}

function runHitTestCases(): void {
  // The control is topmost — the ordinary, faithful path.
  const button = fakeElement();
  const clear = withElementFromPoint(button, () => readHitTest(button as unknown as Element));
  assert.equal(clear.isTopmost, true);
  assert.equal(clear.obstruction, null);

  // 🔴 THE BANNER FROM INCIDENT ONE. Something else is at the control's own centre.
  const banner = fakeElement({
    tagName: "DIV",
    textContent: "We use tools, such as cookies, to enable essential services",
  });
  const covered = withElementFromPoint(banner, () => readHitTest(button as unknown as Element));
  assert.equal(covered.isTopmost, false, "a covered control must be reported as covered");
  assert.equal(covered.obstruction?.tag, "div");
  assert.match(covered.obstruction?.text ?? "", /cookies/);

  // A child of the control (a button's own <span>) counts as the control, not an obstruction.
  const span = { contains: () => false, tagName: "SPAN", textContent: "Email user" };
  const outer = fakeElement();
  outer.contains = (other: unknown) => other === span;
  assert.equal(
    withElementFromPoint(span, () => readHitTest(outer as unknown as Element)).isTopmost, true,
    "the control's own child is not an obstruction",
  );

  // Nothing at that point, and a zero-size element, both fall back rather than refusing.
  assert.equal(withElementFromPoint(null, () => readHitTest(button as unknown as Element)).isTopmost, true);
  const zero = fakeElement({ rect: { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0 } });
  assert.equal(withElementFromPoint(banner, () => readHitTest(zero as unknown as Element)).isTopmost, true);

  // 🔴 AND IT MUST NOT THROW. In the page there is always a document, but a throw here would
  // propagate into the middle of a provisioning run.
  const broken = { getBoundingClientRect: () => { throw new Error("detached"); } };
  assert.equal(readHitTest(broken as unknown as Element).isTopmost, true);
}

function runDecisionCases(): void {
  assert.equal(
    decideClickDelivery({ isTopmost: true, obstruction: null }, "the Email user button").via,
    "coordinates",
  );

  const covered = decideClickDelivery(
    { isTopmost: false, obstruction: { tag: "div", text: "We use tools, such as cookies" } },
    "the Email user button",
  );
  assert.equal(covered.via, "node");
  assert.match(covered.via === "node" ? covered.reason : "", /cookies/);
  assert.match(covered.via === "node" ? covered.reason : "", /cannot land anywhere else/);

  // 🔴 THE HEADLINE FROM INCIDENT TWO. A malformed hit test must read as NOT covered, so a broken
  // reader degrades to the ordinary click instead of sending every click down the fallback. `{}` is
  // exactly what the string-expression bug returned, and it is what routed every click to a no-op.
  for (const bad of [{} as HitTest, null, undefined, { isTopmost: "false" } as unknown as HitTest]) {
    assert.equal(
      decideClickDelivery(bad, "the Email user button").via, "coordinates",
      `a malformed hit test (${JSON.stringify(bad)}) must not be treated as an obstruction`,
    );
  }
}

function runClickAndClearCases(): void {
  // clickNode actually clicks the element it is given.
  const element = fakeElement();
  clickNode(element as unknown as Element);
  assert.deepEqual(element.events, ["click"]);

  // clearField empties the value and notifies a controlled field, in that order.
  const field = fakeElement({ tagName: "INPUT", value: "adel.srour@satopharma.com" });
  clearField(field as unknown as Element);
  assert.equal(field.value, "", "the field must be emptied, not appended to");
  assert.deepEqual(field.events, ["input", "change"], "a controlled React field must be notified");
  assert.equal((field.wasFocused as () => boolean)(), true);

  // Something that is not a field is left alone rather than mangled.
  const notAField = fakeElement({ tagName: "DIV" });
  clearField(notAField as unknown as Element);
  assert.deepEqual(notAField.events, [], "a non-field must not receive events");
}

function runViewportCases(): void {
  // The condition behind incident one: at 600px tall a 188px bottom banner reaches y=412, and the
  // console's buttons sit around y=430.
  assert.equal(CONSOLE_VIEWPORT.height, 900);
  assert.equal(CONSOLE_VIEWPORT.width, 1400);
  const BANNER = 188;
  const BUTTON_Y = 442;
  assert.ok(CONSOLE_VIEWPORT.height - BANNER > BUTTON_Y, "the viewport must leave real headroom");
  assert.equal(600 - BANNER > BUTTON_Y, false, "puppeteer's 800x600 default is what failed");
}

/**
 * The one thing no unit call can prove: that the DRIVER hands these to `handle.evaluate(fn)` rather
 * than `page.evaluate(string, handle)`. That is incident two expressed as a test.
 */
function runWiringCases(): void {
  const driver = readFileSync(
    new URL("src/lib/new-hire-mailbox/robot/turbify-joiner.ts", new URL("../", import.meta.url)),
    "utf8",
  );
  const flat = driver.replace(/\s+/g, " ");

  assert.match(flat, /handle \.evaluate<HitTest>\(readHitTest\)|handle\.evaluate<HitTest>\(readHitTest\)/);
  assert.match(flat, /handle\.evaluate<void>\(clickNode\)/);
  assert.match(flat, /handle\.evaluate<void>\(clearField\)/);

  // 🔴 No in-page code may be handed to page.evaluate WITH a handle — that form never runs.
  assert.equal(
    /page\.evaluate<[^>]*>\([A-Za-z_]+, handle\)/.test(flat), false,
    "page.evaluate(string, handle) never binds the handle and never runs the body",
  );
  // Every click goes through the hit-tested path.
  assert.match(flat, /const clickOne = \(page: ConsolePage, locator: Locator\) => clickResolved\(page, locator\)/);
  assert.equal(/const clickOne = .*handle\.click\(\)/.test(flat), false);
  // The viewport is explicit, and cookies are never accepted on the owner's behalf.
  assert.match(flat, /setViewport\(\{ \.\.\.CONSOLE_VIEWPORT \}\)/);
  assert.equal(/Accept All|acceptAll/i.test(driver), false);
}

export function runTurbifyClickDeliveryTests(): void {
  runHitTestCases();
  runDecisionCases();
  runClickAndClearCases();
  runViewportCases();
  runWiringCases();
}
