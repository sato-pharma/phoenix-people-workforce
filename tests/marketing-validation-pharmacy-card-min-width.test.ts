import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Customer Validation lays its fields out in a CSS grid. A grid item's *automatic minimum size* is
 * its min-content width, so any item holding text that cannot wrap will widen the whole track
 * rather than overflow inside itself.
 *
 * HISTORY. The "My Pharmacies" detail card used to be deliberately `whitespace-nowrap`, scrolling
 * sideways inside its own `overflow-x-auto` box, under the owner's older rule that text never wraps
 * and is never cut with an ellipsis. The pharmacy card sat in a grid item with the default
 * `min-width: auto`, so the moment a rep picked a pharmacy the card's widest line ("Validated by
 * <full employee name>") sized the single mobile column to ~618px inside a 390px viewport. The whole
 * card — including the "Validate New Venue" / "My Venues" tab row — was pushed off the right edge
 * and clipped by an ancestor `overflow-hidden`, so on a phone the rep could no longer see or reach
 * the tabs. Measured on a real Chrome at 390x844. `min-w-0` on the grid item fixed that.
 *
 * THE RULE HAS SINCE CHANGED. "Never wrap" is SUPERSEDED by the fits-the-screen golden rule
 * (AGENTS.md §4, docs/agents-owner-rules.md): text is still never cut with an ellipsis, but where
 * that collides with the no-sideways-scroll rule, WRAPPING WINS — and `overflow-x-auto` around a
 * nowrap line is the exact construct the golden rule names as the bug. So the detail lines and the
 * section subtitle now WRAP (`break-words`), with no sideways scroller.
 *
 * `min-w-0` stays, and stays pinned: it is what stops any single long unbreakable value (a code, an
 * address with no spaces) from sizing the whole phone track past the screen. It reads like a
 * decorative utility class; it is not.
 */

const WORKSPACE = "src/components/employee-portal/marketing-validation-workspace.tsx";

export function runMarketingValidationPharmacyCardMinWidthTests() {
  const source = readFileSync(WORKSPACE, "utf8");

  // 1. The per-pharmacy grid item must be able to shrink below its content.
  const cardWrapper = source.match(
    /customer\.pharmacies\.map\(\(pharmacy, index\) => \(\s*<div className="([^"]+)" key=\{pharmacy\.key\}>/,
  );
  assert.ok(
    cardWrapper,
    `${WORKSPACE}: could not find the per-pharmacy card wrapper — has the pharmacy list been restructured?`,
  );
  assert.ok(
    cardWrapper[1].split(/\s+/).includes("min-w-0"),
    `${WORKSPACE}: the pharmacy card grid item is "${cardWrapper[1]}" — it is missing "min-w-0". ` +
      `Without it one long unbreakable line in the card sizes the whole grid track, and on a 390px ` +
      `phone the pharmacy tabs are pushed off screen and clipped.`,
  );

  // 2. The reused-pharmacy detail card WRAPS — no nowrap line, no sideways scroller.
  const pickerStart = source.indexOf("function ReusablePharmacyPicker");
  assert.ok(pickerStart >= 0, `${WORKSPACE}: ReusablePharmacyPicker is gone — has the picker been restructured?`);
  const detailCard = source.slice(pickerStart, pickerStart + 4000);
  assert.ok(
    !detailCard.includes("whitespace-nowrap"),
    `${WORKSPACE}: ReusablePharmacyPicker renders a whitespace-nowrap line again. On a phone that line ` +
      `either scrolls sideways or is clipped by the card — the fits-the-screen golden rule says wrap it ` +
      `(break-words); "never wrap" is superseded.`,
  );
  assert.ok(
    !detailCard.includes("overflow-x-auto"),
    `${WORKSPACE}: ReusablePharmacyPicker wraps its detail in "overflow-x-auto" again — a sideways ` +
      `scroller around text is the construct the fits-the-screen golden rule names as the bug.`,
  );
  assert.ok(
    detailCard.includes("break-words"),
    `${WORKSPACE}: ReusablePharmacyPicker's detail no longer says "break-words", so a long pharmacy ` +
      `or owner name has no way to fit a phone-width card.`,
  );

  // 3. The Venue Validation section header, one level up, had exactly the same problem: its
  //    subtitle was a single nowrap sentence 335px wide, which sized its own grid item past the
  //    330px mobile track and got cut mid-word by the customer card's `overflow-hidden`. It keeps
  //    `min-w-0` and now wraps. (The original code also carried `text-ellipsis`, which never
  //    rendered an ellipsis — the owner's rule forbids it regardless.)
  const sectionHeader = source.match(
    /<div className="([^"]*)">\s*<div className="flex flex-col gap-3 border-t border-slate-100 pt-4[^"]*">\s*<div className="([^"]+)">\s*<p className="([^"]*)">Venue Validation<\/p>\s*<p className="([^"]+)">/,
  );
  assert.ok(
    sectionHeader,
    `${WORKSPACE}: could not find the "Venue Validation" section header — has it been restructured?`,
  );
  assert.ok(
    sectionHeader[1].split(/\s+/).includes("min-w-0"),
    `${WORKSPACE}: the Venue Validation section's grid item is "${sectionHeader[1]}" — it is ` +
      `missing "min-w-0". Without it the item sizes to its subtitle's min-content width inside a ` +
      `330px phone track, and the customer card's "overflow-hidden" cuts the sentence mid-word.`,
  );
  for (const [label, classes] of [
    ["subtitle wrapper", sectionHeader[2]],
    ["heading", sectionHeader[3]],
    ["subtitle", sectionHeader[4]],
  ] as const) {
    assert.ok(
      !classes.split(/\s+/).includes("overflow-x-auto") && !classes.split(/\s+/).includes("whitespace-nowrap"),
      `${WORKSPACE}: the Venue Validation ${label} is "${classes}" — a nowrap line inside a sideways ` +
        `scroller. It must wrap: where "never cut off" collides with "never scroll sideways", wrapping wins.`,
    );
    assert.ok(
      !classes.includes("text-ellipsis") && !classes.split(/\s+/).includes("truncate"),
      `${WORKSPACE}: the Venue Validation ${label} is "${classes}" — text is never truncated with an ellipsis.`,
    );
  }
}
