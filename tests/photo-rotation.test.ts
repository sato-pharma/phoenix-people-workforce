import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  swapsFrameSides,
  turnedFillStyle,
  turnedFitLimits,
  TURNABLE_FRAME_STYLE,
  turnPhoto,
  type QuarterTurns,
} from "../src/components/ui/photo-rotation.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Turning a photo a quarter at a time on Place checks (owner, 2026-10-17: "make me able to rotate the
 * picture of validation in place checks bec some timetables are rotated and i cannot read").
 *
 * Two things break silently:
 * - a photo turned onto its side keeps the frame's own width and height, so a sideways timetable
 *   turned upright overflows its tile or shrinks to a strip — nothing errors, it just cannot be read;
 * - the buttons reaching a rep's own screens, where nothing was asked for and the photo is his.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

function tsxUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(new URL(dir, ROOT))) {
    const path = join(dir, name).replace(/\\/g, "/");
    if (statSync(new URL(path, ROOT)).isDirectory()) out.push(...tsxUnder(`${path}/`));
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** The Place checks page's own photographs — the only screens that turn one. */
const PLACE_CHECKS = new Set([
  "src/components/phoenix-crm/validation-review-queue.tsx",
  "src/components/phoenix-crm/validated-place-list.tsx",
  "src/components/phoenix-crm/shared-place-list.tsx",
  "src/components/phoenix-crm/shared-place-customers.tsx",
  "src/components/phoenix-crm/place-match-board.tsx",
]);

function checkTurns() {
  assert.equal(turnPhoto(0, "right"), 1);
  assert.equal(turnPhoto(3, "right"), 0, "four quarter turns come back to how the photo was taken");
  assert.equal(turnPhoto(0, "left"), 3, "a left turn from upright is three quarters right, never -1");
  assert.equal(turnPhoto(2, "left"), 1);

  const sides = ([0, 1, 2, 3] as QuarterTurns[]).map(swapsFrameSides);
  assert.deepEqual(sides, [false, true, false, true], "only 90° and 270° lay the photo on its side");

  // 🔴 On its side the photo is sized to the frame's HEIGHT by its WIDTH, so once turned it fits.
  for (const turns of [1, 3] as QuarterTurns[]) {
    const style = turnedFillStyle(turns);
    assert.equal(style.width, "100cqh", `at ${turns * 90}° the photo is as wide as its frame is tall`);
    assert.equal(style.height, "100cqw", `at ${turns * 90}° the photo is as tall as its frame is wide`);
    assert.match(String(style.transform), new RegExp(`rotate\\(${turns * 90}deg\\)`));
    assert.equal(style.objectFit, "contain", "the whole timetable stays in the frame — never cropped");
    assert.deepEqual(turnedFitLimits(turns), { maxHeight: "100cqw", maxWidth: "100cqh" }, "the full-screen view swaps its limits too");
  }
  for (const turns of [0, 2] as QuarterTurns[]) {
    const style = turnedFillStyle(turns);
    assert.equal(style.width, "100%");
    assert.equal(style.height, "100%");
    assert.deepEqual(turnedFitLimits(turns), {}, "upright or upside down, the frame's own limits stand");
  }
  assert.equal(turnedFillStyle(0).transform, undefined, "an unturned photo carries no transform at all");
  assert.equal(TURNABLE_FRAME_STYLE.containerType, "size", "the cqw/cqh units measure the frame only when it is a size container");
}

function checkViewer() {
  const viewer = read("src/components/ui/zoomable-photo.tsx");
  assert.match(viewer, /style=\{rotatable \? turnedFillStyle\(turns\) : undefined\}/, "an unturnable photo keeps the caller's own styling");
  assert.match(viewer, /style=\{TURNABLE_FRAME_STYLE\}/, "the thumbnail's frame is the size container its photo is measured against");
  assert.match(viewer, /style=\{onTurn \? TURNABLE_FRAME_STYLE : undefined\}/, "the full-screen stage is too, only when the photo turns");
  assert.match(viewer, /\.\.\.turnedFitLimits\(turns\)/);
  assert.match(viewer, /rotate\(\$\{turns \* 90\}deg\)/, "the full-screen photo is turned as the thumbnail was");
  assert.match(viewer, /onTurn=\{rotatable \? turn : undefined\}/, "the turn follows the photo into the full-screen view");
  assert.match(viewer, /turns=\{rotatable \? turns : 0\}/);
  assert.match(
    viewer,
    /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*turn\(direction\);/,
    "turning a photo opens nothing and fires nothing on the card underneath it",
  );
  assert.ok(!/upload|storage|fetch\(/i.test(read("src/components/ui/photo-rotation.ts")), "view only: the stored photograph is never changed");
}

/** Forwards the caller's own `rotatable` and decides nothing itself. */
const PASS_THROUGH = new Set(["src/components/phoenix-crm/photo.tsx"]);

function checkWhereItIsOffered() {
  const offered = new Set<string>();
  for (const file of [...tsxUnder("src/"), ...tsxUnder("app/")]) {
    if (PASS_THROUGH.has(file)) continue;
    const source = read(file);
    if (/<(?:CrmPhotoThumb|ZoomablePhoto)\b[^>]*\brotatable\b/.test(source)) offered.add(file);
  }
  for (const file of PLACE_CHECKS) {
    assert.ok(offered.has(file), `${file}: every photograph on Place checks can be turned`);
  }
  for (const file of offered) {
    assert.ok(PLACE_CHECKS.has(file), `🔴 ${file} turns a photo, but only Place checks asked for it — a rep's screens stay as they are`);
  }
}

export function runPhotoRotationTests() {
  checkTurns();
  checkViewer();
  checkWhereItIsOffered();
}
