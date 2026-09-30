import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BRICK_TINTS, brickTintMap } from "../src/components/phoenix-crm/brick-tints.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — one brick, one colour, on every screen that draws one.
 *
 * Owner, 2026-09-26: "I want every brick highlighted, the doctors in the same brick highlighted with
 * the same colour". The colours already existed on the Reps List board and the List tab; the screen
 * the rep uses every day — Add Visit — was the one with no map in it. Adding them there is the moment
 * a THIRD copy of the palette would have been made, and a brick that is teal on one screen and indigo
 * on the next is no use at all as a landmark.
 *
 * So the palette lives in one module, and this pins that there is only one.
 */
export async function runPhoenixCrmBrickTintsTests(): Promise<void> {
  // ── The palette ──────────────────────────────────────────────────────────────────────────────
  {
    assert.equal(BRICK_TINTS.length, 8, "eight hues, as the board has always had");
    assert.equal(new Set(BRICK_TINTS.map((tint) => tint.bar)).size, 8, "no hue is repeated");
    for (const tint of BRICK_TINTS) {
      assert.match(tint.bar, /^border-l-/, "the hue lands as a left bar");
      assert.match(tint.fill, /^bg-/, "and a light fill");
    }
  }

  // ── The assignment is stable and repeatable ──────────────────────────────────────────────────
  {
    const keys = ["B1", "B2", "B3"];
    const first = brickTintMap(keys);
    const again = brickTintMap(keys);
    assert.equal(first.get("B1")?.bar, again.get("B1")?.bar, "the same list gives the same hues");
    assert.equal(first.get("B1")?.bar, BRICK_TINTS[0].bar);
    assert.equal(first.get("B3")?.bar, BRICK_TINTS[2].bar);

    // A repeated key takes its hue once, from where it first appeared.
    const repeated = brickTintMap(["B1", "B1", "B2"]);
    assert.equal(repeated.size, 2);
    assert.equal(repeated.get("B2")?.bar, BRICK_TINTS[1].bar, "the repeat did not consume a hue");

    // More bricks than hues wraps rather than running out of colour.
    const many = brickTintMap(Array.from({ length: 10 }, (_, index) => `B${index}`));
    assert.equal(many.get("B8")?.bar, BRICK_TINTS[0].bar, "the ninth brick wraps to the first hue");

    assert.equal(brickTintMap([]).size, 0);
  }

  // ── One copy, three readers ──────────────────────────────────────────────────────────────────
  {
    const palette = /border-l-(?:sky|emerald|indigo|teal|fuchsia|cyan|lime|stone)-500/;
    // The visit picker is its own file since the one-tap rebuild (2026-09-29), and Today groups the
    // day by brick with the same hues.
    for (const path of [
      "src/components/phoenix-crm/customer-list-board.tsx",
      "src/components/phoenix-crm/visit-customer-picker.tsx",
      "src/components/phoenix-crm/today-tab.tsx",
    ]) {
      const text = stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
      assert.ok(text.includes("brick-tints"), `${path} must take the palette from the one module`);
      assert.equal(palette.test(text), false, `${path} must not carry its own copy of the hues`);
    }
  }

  // ── The visit picker actually has a brick to colour ──────────────────────────────────────────
  {
    // loadVisitForm used to drop every brick field when it built the picker's options, which is the
    // whole reason the one screen a rep opens every day had no geography on it.
    const visits = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/visits.ts", import.meta.url), "utf8"));
    assert.ok(visits.includes("brickId"), "the visit form carries the brick id");
    assert.ok(visits.includes("brickName"), "and its name, because a screen shows names, never codes");
  }

  console.log("phoenix-crm brick tints: OK");
}
