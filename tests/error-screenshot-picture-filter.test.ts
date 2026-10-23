import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createPictureFilter, emptiesInPicture, type PictureBox } from "../src/lib/error-monitor/screen-capture-rules.ts";

/**
 * The error screenshot came out BLANK for a person scrolled down a page (System Audit, the first real
 * refusal: Khaled Mohamed Ali Bedair on Phoenix CRM, 23 Oct 2026 18:51 Cairo — sidebar and top bar
 * drawn, the page area pure white). The capture dropped every element above the viewport, which took
 * its SPACE away too, so everything after it moved up by its height; then the picture moved the page
 * up by the scroll position. The visible part was shifted up twice, out of the picture.
 *
 * Measured on the live Phoenix CRM page at 1920x869, scrolled 592px, against a capture that drops
 * nothing: the old filter differed in 298 of 960 sample cells, the fixed one in 0.
 *
 * A tiny layout model below plays the same page: a column of rows, scrolled; a kept row takes its
 * height whether or not its contents were copied, a dropped one takes none.
 */

type FakeElement = { name: string; box: PictureBox; display: string; parentElement: FakeElement | null };

const VIEWPORT = { width: 1920, height: 869 };

function box(top: number, height: number, left = 300, width = 1580): PictureBox {
  return { top, bottom: top + height, left, right: left + width, width, height };
}

function element(name: string, b: PictureBox, parent: FakeElement | null, display = "block"): FakeElement {
  return { name, box: b, display, parentElement: parent };
}

/** A card holding 40 rows of 100px, its top at page y 100, the window scrolled `scrollY` down. */
function scrolledList(scrollY: number) {
  const body = element("body", box(-scrollY, 4200, 0, 1920), null);
  const card = element("card", box(100 - scrollY, 4000), body);
  const rows = Array.from({ length: 40 }, (_, i) => element(`row ${i}`, box(100 - scrollY + i * 100, 100), card));
  const cells = rows.map((row) => element(`${row.name} text`, row.box, row));
  return { body, card, rows, cells };
}

/** Where row `index` lands in the picture: the rows the filter kept before it, minus the scroll. */
function pictureTopOf(index: number, kept: (row: FakeElement) => boolean, rows: FakeElement[], scrollY: number): number {
  const before = rows.slice(0, index).filter(kept).length * 100;
  return 100 + before - scrollY;
}

export function runErrorScreenPictureFilterTests() {
  // 1. The headline: a person scrolled 2,050px down a list is photographed where they were looking.
  const scrollY = 2050;
  const page = scrolledList(scrollY);
  const filter = createPictureFilter<FakeElement, FakeElement>((el) => ({ box: el.box, display: el.display }), VIEWPORT);
  const firstVisible = page.rows.findIndex((row) => row.box.bottom >= 0);
  assert.equal(firstVisible, 19, "model check: row 19 is the first one on screen");
  assert.equal(
    pictureTopOf(firstVisible, filter, page.rows, scrollY),
    page.rows[firstVisible].box.top,
    "the first row on screen is drawn exactly where the person saw it — every row above it still takes its space",
  );
  assert.ok(page.rows.every((row) => filter(row)), "every row of the on-screen card is copied, as an empty box when it is off screen");
  assert.equal(page.cells.filter((cell) => filter(cell)).length, 10, "and only what sits inside the rows on screen is copied (rows 19–28)");

  // 2. The rule each box is judged by.
  const sized = (top: number, height: number) => box(top, height);
  assert.equal(emptiesInPicture(sized(-500, 100), "block", VIEWPORT), true, "a block wholly above the screen is copied empty");
  assert.equal(emptiesInPicture(sized(900, 100), "flex", VIEWPORT), true, "and one wholly below it");
  assert.equal(emptiesInPicture(sized(-50, 100), "block", VIEWPORT), false, "a box that reaches onto the screen is copied whole");
  assert.equal(emptiesInPicture({ top: -500, bottom: -500, left: 0, right: 0, width: 0, height: 0 }, "block", VIEWPORT), false, "a zero-size box may hold visible children positioned outside it");
  assert.equal(emptiesInPicture(sized(-500, 100), "inline", VIEWPORT), false, "an inline element's size is its text, so its text is copied");
  assert.equal(emptiesInPicture(sized(-500, 100), "table-row", VIEWPORT), false, "a table part's widths come from its cells, so they are copied");
  assert.equal(emptiesInPicture(sized(-500, 100), "contents", VIEWPORT), false, "a display:contents element has no box of its own to hold the place");

  // 3. Each box is measured once per picture, not once per child.
  let measured = 0;
  const counting = createPictureFilter<FakeElement, FakeElement>((el) => {
    measured += 1;
    return { box: el.box, display: el.display };
  }, VIEWPORT);
  for (const cell of page.cells) counting(cell);
  for (const cell of page.cells) counting(cell);
  assert.equal(measured, 40, "forty rows measured once each, however many times their contents are asked about");

  // 4. Both pictures use it: the refusal screenshot and the crash screenshot.
  for (const file of ["screen-capture.ts", "capture-screenshot.ts"]) {
    const source = readFileSync(new URL(`../src/lib/error-monitor/${file}`, import.meta.url), "utf8");
    assert.ok(source.includes("filter: pictureFilter(),"), `${file} copies off-screen boxes empty instead of dropping them`);
    assert.ok(!/\bonScreen\b/.test(source), `${file} no longer uses the filter that dropped them`);
  }
}
