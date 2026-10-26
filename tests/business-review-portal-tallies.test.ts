/**
 * The portal Business Review says how its cards relate to the totals above them (NSM audit, 2026-10-26).
 *
 *   1. The header read sales EGP 8,626,400 and the district cards added up to 8,547,338. The missing 79,062
 *      sat in "Others (vacant)", which carries no target in the window and so draws no card — and nothing on
 *      the page said so. `districtCardsRemainder` names it, and the portal prints the sentence under the cards.
 *   2. "Earners ≥ 90%: 4 of 36 graded" counted vacant areas in the 36 though a vacant area never earns.
 *      `earnerTally` counts the earners over the STAFFED areas with a target and says how many vacant were graded.
 *
 * Display only: the figures are summed exactly as the page always summed them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  districtCardsRemainder,
  districtCardsRemainderText,
  earnerTally,
  earnerTallyNote,
} from "@/lib/business-review/portal-tallies";

const PORTAL = "src/components/business-review/portal-review.client.tsx";

const slice = (sales: number, target: number) => ({ sales, target, ach: target > 0 ? (100 * sales) / target : null });
const money = (value: number) => `EGP ${Math.round(value).toLocaleString("en-US")}`;
const count = (value: number) => String(value);

export function runBusinessReviewPortalTalliesTests() {
  // ── 1. The district cards and the header's sales ──────────────────────────────────────────────────
  {
    const sahar = { dm: "Sahar El Gallad", vacant: false, allProducts: slice(4_000_000, 5_000_000) };
    const ahmed = { dm: "Ahmed Fathy", vacant: false, allProducts: slice(4_547_338, 5_200_000) };
    const others = { dm: "Others (vacant)", vacant: true, allProducts: slice(79_062, 0) };
    const all = [sahar, ahmed, others];
    // The portal draws only a district with a target — exactly what it drew before this change.
    const drawn = all.filter((district) => district.allProducts.target > 0);

    const remainder = districtCardsRemainder(all, drawn, 8_626_400);
    assert.equal(remainder.drawnSales, 8_547_338);
    assert.equal(remainder.remainderSales, 79_062, "the cards fall short of the header by what Others (vacant) holds");
    assert.deepEqual(remainder.undrawn, [{ name: "Others (vacant)", sales: 79_062, reason: "no target" }]);

    const text = districtCardsRemainderText(remainder, money);
    assert.ok(text, "a gap between the cards and the header is said under the cards");
    assert.ok(text.includes("EGP 8,547,338") && text.includes("EGP 79,062"), text);
    assert.ok(text.includes("Others (vacant) EGP 79,062 (no target in this window)"), text);

    // A vacant district hidden by the "Exclude vacant" switch is named for that reason.
    const vacantWithTarget = { dm: "Vacant — Assiut", vacant: true, allProducts: slice(50_000, 100_000) };
    const hidden = districtCardsRemainder([sahar, vacantWithTarget], [sahar], 4_050_000);
    assert.deepEqual(hidden.undrawn, [{ name: "Vacant — Assiut", sales: 50_000, reason: "vacant hidden" }]);

    // Cards that reach the header print nothing — a whole pound of float noise is not a gap.
    const whole = districtCardsRemainder([sahar, ahmed], [sahar, ahmed], 8_547_338.4);
    assert.equal(whole.remainderSales, 0);
    assert.equal(districtCardsRemainderText(whole, money), null);
  }

  // ── 2. Earners over the areas that can earn ───────────────────────────────────────────────────────
  {
    const area = (vacant: boolean, sales: number, target: number) => ({
      vacant,
      hasTarget: target > 0,
      allProducts: slice(sales, target),
    });
    const areas = [
      area(false, 95, 100), // earner
      area(false, 90, 100), // earner, at the bar
      area(false, 50, 100),
      area(true, 120, 100), // vacant, graded, never an earner
      area(true, 10, 100),
      area(false, 10, 0), // no target: not graded at all
    ];
    const tally = earnerTally(areas);
    assert.deepEqual(tally, { earners: 2, staffedGraded: 3, vacantGraded: 2 }, "a vacant area is never an earner nor in its denominator");
    assert.equal(earnerTallyNote(tally, count), "of 3 staffed areas with a target · 2 vacant never earn");
    assert.equal(earnerTallyNote({ earners: 1, staffedGraded: 2, vacantGraded: 0 }, count), "of 2 staffed areas with a target");
  }

  // ── 3. The portal prints both ─────────────────────────────────────────────────────────────────────
  {
    const portal = readFileSync(PORTAL, "utf8").replace(/\s+/g, " ");
    assert.ok(portal.includes("const earners = useMemo(() => earnerTally(areas), [areas]);"), `${PORTAL}: the Earners card must count with earnerTally`);
    assert.ok(
      portal.includes('label="Earners ≥ 90%" note={earnerTallyNote(earners, num)} value={num(earners.earners)}'),
      `${PORTAL}: the Earners card must say what its denominator counts`,
    );
    assert.ok(
      portal.includes("districtCardsRemainderText(districtCardsRemainder(dms, visibleDms, totals.sales), egp)"),
      `${PORTAL}: the district cards must be measured against the header's sales`,
    );
    assert.ok(portal.includes("{dmCardsNote ? <p"), `${PORTAL}: the remainder sentence must be printed under the district cards`);
  }
}
