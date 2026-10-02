/**
 * Clicking the control and not the thing on top of it — what this file protects.
 *
 * 🔴 THE INCIDENT, measured on production 2026-10-02. The joiner failed to create three mailboxes
 * with `Waiting for selector input[name="emailLocal"] failed`, and that form was present the whole
 * time. The driver launched Chromium with no viewport, so puppeteer's default 800x600 applied; at
 * 600px tall Turbify's cookie banner (fixed, z-index 99999, 188px) covered everything below y=412;
 * the "Email user" button sat at y=430. `document.elementFromPoint` at the button's own centre
 * returned the BANNER, `handle.click()` clicked those coordinates, and it reported NO ERROR. The
 * modal never opened and the failure pointed at an innocent selector twenty seconds later.
 *
 * So the two things asserted here are:
 *   1. an obstruction is DETECTED and the click is re-delivered on the node, which cannot land
 *      anywhere else because `resolveOne` has already matched exactly one element;
 *   2. the explicit viewport is large enough that a bottom-anchored banner does not reach the
 *      console's controls — the condition that caused the incident is gone, not merely handled.
 *
 * And one that is easy to lose: a hit test that cannot answer must NOT become a refusal. The
 * coordinate click is still the normal path; this is a diagnostic improvement on it, not a new gate.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONSOLE_VIEWPORT,
  decideClickDelivery,
  HIT_TEST_EXPRESSION,
  NODE_CLICK_EXPRESSION,
  type HitTest,
} from "../src/lib/turbify/click-delivery.ts";

function runDecisionCases(): void {
  // Nothing on top → the faithful, real-user path.
  const clear = decideClickDelivery({ isTopmost: true, obstruction: null }, "the Email user button");
  assert.equal(clear.via, "coordinates");

  // 🔴 THE HEADLINE. The real obstruction from the incident, by name.
  const banner: HitTest = {
    isTopmost: false,
    obstruction: { tag: "div", text: "We use tools, such as cookies, to enable essential services" },
  };
  const covered = decideClickDelivery(banner, "the Email user button");
  assert.equal(covered.via, "node", "a covered control must be clicked on the node, not at its coordinates");
  assert.match(covered.via === "node" ? covered.reason : "", /covering the the Email user button|covering the Email user button/);
  assert.match(covered.via === "node" ? covered.reason : "", /cookies/, "the reason must name what was in the way");
  assert.match(covered.via === "node" ? covered.reason : "", /cannot land anywhere else/);

  // An obstruction with no readable text still produces a usable reason rather than an empty one.
  const silent = decideClickDelivery({ isTopmost: false, obstruction: { tag: "div", text: "" } }, "the Save button");
  assert.equal(silent.via, "node");
  assert.match(silent.via === "node" ? silent.reason : "", /div/);
  const none = decideClickDelivery({ isTopmost: false, obstruction: null }, "the Save button");
  assert.equal(none.via, "node");
  assert.match(none.via === "node" ? none.reason : "", /no readable text/);
}

function runViewportCases(): void {
  // 🔴 The condition that caused the incident: at 600px tall, a 188px bottom-anchored banner reaches
  // y=412, and the console's buttons sit around y=430. The viewport must leave real headroom.
  assert.equal(CONSOLE_VIEWPORT.height, 900);
  assert.equal(CONSOLE_VIEWPORT.width, 1400);
  const BANNER_HEIGHT = 188;
  const BUTTON_Y = 442; // measured at 1400x900 on the live console
  assert.ok(
    CONSOLE_VIEWPORT.height - BANNER_HEIGHT > BUTTON_Y,
    `a ${BANNER_HEIGHT}px bottom banner must not reach y=${BUTTON_Y} at ${CONSOLE_VIEWPORT.height}px tall`,
  );
  // And the default that broke it would NOT pass that test, which is the whole point.
  assert.equal(600 - BANNER_HEIGHT > BUTTON_Y, false, "puppeteer's 800x600 default is what failed");
}

function runExpressionCases(): void {
  // The hit test must FAIL OPEN: every path that cannot answer returns isTopmost true, so a browser
  // quirk degrades to the old behaviour rather than refusing to click.
  assert.match(HIT_TEST_EXPRESSION, /catch\s*\{\s*return \{ isTopmost: true/);
  assert.equal((HIT_TEST_EXPRESSION.match(/isTopmost: true/g) ?? []).length >= 4, true,
    "every unanswerable path must fall back to the coordinate click");
  // It must treat an element inside the control as the control — a button's own <span> is topmost.
  assert.match(HIT_TEST_EXPRESSION, /element\.contains\(top\)/);
  assert.match(HIT_TEST_EXPRESSION, /top\.contains\(element\)/);
  // It reads only geometry and text; it never acts.
  assert.doesNotMatch(HIT_TEST_EXPRESSION, /\.click\(|\.focus\(|\.submit\(/);
  // The node click dispatches on the element, which is what makes it unable to hit anything else.
  assert.match(NODE_CLICK_EXPRESSION, /element\.click\(\)/);
}

function runWiringCases(): void {
  const root = new URL("../", import.meta.url);
  const driver = readFileSync(new URL("src/lib/new-hire-mailbox/robot/turbify-joiner.ts", root), "utf8");

  // 🔴 Every click goes through the hit-tested path. A bare `handle.click()` as the clickOne
  // implementation is exactly the bug.
  assert.match(driver, /const clickOne = \(page: ConsolePage, locator: Locator\) => clickResolved\(page, locator\)/);
  assert.equal(
    /const clickOne = .*handle\.click\(\)/.test(driver), false,
    "clickOne must not click by coordinates without the hit test",
  );
  // The viewport is set explicitly — the default is what caused the incident.
  assert.match(driver, /setViewport\(\{ \.\.\.CONSOLE_VIEWPORT \}\)/);
  // And it never dismisses the consent banner: accepting cookies is not the robot's decision.
  assert.equal(
    /Accept All|acceptAll|accept_all/i.test(driver), false,
    "the robot must never accept cookies on the owner's behalf",
  );
}

export function runTurbifyClickDeliveryTests(): void {
  runDecisionCases();
  runViewportCases();
  runExpressionCases();
  runWiringCases();
}
