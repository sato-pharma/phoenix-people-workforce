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
 * 390px viewport. The whole card — including the "Validate New Pharmacy" / "My Pharmacies" tab row
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
}
