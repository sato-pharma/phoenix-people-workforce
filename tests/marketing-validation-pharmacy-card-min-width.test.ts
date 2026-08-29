import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Customer Validation lays its fields out in a CSS grid. A grid item's *automatic minimum size* is
 * its min-content width, so any item holding text that cannot wrap will widen the whole track
 * rather than overflow inside itself.
 *
 * The "My Pharmacies" detail card is deliberately `whitespace-nowrap` — the owner's standing rule
 * is that text never wraps and is never cut with an ellipsis; long lines scroll inside their own
 * `overflow-x-auto` box instead. That is correct on its own, but the pharmacy card sat in a grid
 * item with the default `min-width: auto`, so the moment a rep picked a pharmacy the card's widest
 * line ("Validated by <full employee name>") sized the single mobile column to ~618px inside a
 * 390px viewport. The whole card — including the "Validate New Venue" / "My Venues" tab row
 * — was pushed off the right edge and clipped by an ancestor `overflow-hidden`, so on a phone the
 * rep could no longer see or reach the tabs. Measured on a real Chrome at 390x844.
 *
 * `min-w-0` on the card's grid item is what keeps the track at the viewport width and lets the
 * card's own horizontal scroll do its job. It reads like a decorative utility class; it is not.
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
      `Without it the reused-pharmacy detail card's nowrap lines size the whole grid track, and on a ` +
      `390px phone the pharmacy tabs are pushed off screen and clipped.`,
  );

  // 2. The reason it is needed: those detail lines really are nowrap, inside their own scroller.
  const detailCard = source.slice(
    source.indexOf("function ReusablePharmacyPicker"),
    source.indexOf("function ReusablePharmacyPicker") + 4000,
  );
  assert.ok(
    detailCard.includes("whitespace-nowrap"),
    `${WORKSPACE}: ReusablePharmacyPicker no longer renders nowrap detail lines. If wrapping was ` +
      `introduced deliberately, check with the owner first — his standing rule is that text never ` +
      `wraps and is never truncated.`,
  );
  assert.ok(
    detailCard.includes("overflow-x-auto"),
    `${WORKSPACE}: ReusablePharmacyPicker's nowrap lines are no longer inside an "overflow-x-auto" ` +
      `box, so a long pharmacy name or owner name has nowhere to scroll and will overflow the card.`,
  );

  // 3. The Pharmacy Validation section header, one level up, has exactly the same problem. Its
  //    subtitle is a single nowrap sentence 335px wide, which sized its own grid item past the
  //    330px mobile track and got cut mid-word by the customer card's `overflow-hidden`. Note the
  //    original code carried `text-ellipsis` and it never rendered an ellipsis: the paragraph was
  //    not overflowing its OWN box, so `text-overflow` had nothing to act on. `text-ellipsis` is
  //    the wrong treatment here regardless — the owner's rule is scroll, never truncate.
  const sectionHeader = source.match(
    /<div className="([^"]*)">\s*<div className="flex flex-col gap-3 border-t border-slate-100 pt-4[^"]*">\s*<div className="([^"]+)">\s*<p className="[^"]*">Venue Validation<\/p>\s*<p className="([^"]+)">/,
  );
  assert.ok(
    sectionHeader,
    `${WORKSPACE}: could not find the "Venue Validation" section header — has it been restructured?`,
  );
  assert.ok(
    sectionHeader[1].split(/\s+/).includes("min-w-0"),
    `${WORKSPACE}: the Venue Validation section's grid item is "${sectionHeader[1]}" — it is ` +
      `missing "min-w-0". Without it the item sizes to its subtitle's min-content width (335px) ` +
      `inside a 330px phone track, and the customer card's "overflow-hidden" cuts the sentence ` +
      `mid-word with no ellipsis to show anything is missing.`,
  );
  assert.ok(
    sectionHeader[2].split(/\s+/).includes("overflow-x-auto"),
    `${WORKSPACE}: the Venue Validation subtitle's wrapper is "${sectionHeader[2]}" — it is ` +
      `missing "overflow-x-auto", so the nowrap sentence has nowhere to scroll on a phone.`,
  );
  assert.ok(
    !sectionHeader[3].includes("text-ellipsis"),
    `${WORKSPACE}: the Pharmacy Validation subtitle is "${sectionHeader[3]}" — it uses ` +
      `"text-ellipsis". The owner's standing rule is that text is never truncated with an ellipsis; ` +
      `let it scroll inside "overflow-x-auto" instead.`,
  );
}
