import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  areaSpendTrend,
  buildConcentration,
  concentrationForAreas,
  describeSpread,
  type ReviewSalesDetail,
} from "@/lib/business-review/concentration";
import { spendPerPoint, formatSpendPerPoint } from "@/lib/business-review/spend-efficiency";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Business Review — where a scope's money came from, and what a point of achievement cost.
 *
 * The owner's questions, 2026-09-26, in his own words: "is he selling from all his bricks or almost
 * of them or only one brick", "is his sales from distributors or from wholesalers or direct",
 * "this area needs marketing request cost of X and its sales is declining, is growing".
 *
 * Every case below is chosen so that the WRONG implementation passes none of them:
 *
 *   - a sum rather than a share cannot answer "half the value came from how many",
 *   - counting a returning customer as a customer inflates "he sells to N",
 *   - a percentage off a zero base reads one small invoice as a doubling,
 *   - dividing spend by an achievement of zero prints infinity as a cost.
 */

const row = (partial: Partial<ReviewSalesDetail> & { value: number }): ReviewSalesDetail => ({
  areaCode: "CA1",
  brickId: "B1",
  brickName: "Brick One",
  channel: "distributor",
  clientCode: "C1",
  clientName: "Customer One",
  period: "2026-07",
  ...partial,
});

export function runBusinessReviewConcentrationTests() {
  // ------------------------------------------------------------------ 1. spread
  {
    const spread = buildConcentration([
      row({ brickId: "B1", brickName: "Tanta", value: 100 }),
      row({ brickId: "B2", brickName: "Mahalla", value: 100 }),
      row({ brickId: "B3", brickName: "Kafr", value: 100 }),
      row({ brickId: "B4", brickName: "Zefta", value: 100 }),
    ]).bricks;
    assert.equal(spread.count, 4, "four bricks carried sales");
    assert.equal(spread.topShare, 25, "evenly spread, so the largest is a quarter");
    assert.equal(spread.halfFrom, 2, "half the value takes two of the four");
    assert.match(describeSpread(spread, "brick"), /^Spread/, "an even spread reads as spread");
  }

  // ------------------------------------------------------------------ 2. one brick
  {
    const spread = buildConcentration([
      row({ brickId: "B1", brickName: "Tanta", value: 900 }),
      row({ brickId: "B2", brickName: "Mahalla", value: 50 }),
      row({ brickId: "B3", brickName: "Kafr", value: 50 }),
    ]).bricks;
    assert.equal(spread.count, 3);
    assert.equal(spread.halfFrom, 1, "one brick alone passes half");
    assert.ok(spread.topShare != null && spread.topShare > 89, `top share was ${spread.topShare}`);
    assert.match(
      describeSpread(spread, "brick"),
      /^Concentrated — Tanta alone carried 90% of 3 bricks\.$/,
      "the headline names the brick and the share, not a score",
    );
  }

  // ------------------------------------------------------------------ 2b. narrow is a FRACTION
  // Half the value from 2 is an EVEN spread when there are four and a warning when there are forty.
  // A `halfFrom <= 2` rule called four evenly-selling bricks narrow — caught here before it rendered.
  {
    const many: ReviewSalesDetail[] = [
      row({ brickId: "BIG1", brickName: "Tanta", value: 300 }),
      row({ brickId: "BIG2", brickName: "Mahalla", value: 260 }),
    ];
    for (let i = 0; i < 38; i += 1) {
      many.push(row({ brickId: `S${i}`, brickName: `Small ${i}`, value: 10 }));
    }
    const spread = buildConcentration(many).bricks;
    assert.equal(spread.count, 40);
    assert.equal(spread.halfFrom, 2, "two of forty carry half");
    assert.match(
      describeSpread(spread, "brick"),
      /^Narrow — half the value came from 2 of 40 bricks\.$/,
      "2 of 40 is narrow, where 2 of 4 is not",
    );
  }

  // ------------------------------------------------------------------ 3. a return is not a customer
  {
    const facts = buildConcentration([
      row({ clientCode: "C1", clientName: "Real", value: 500 }),
      row({ clientCode: "C2", clientName: "Returned it all", value: 200 }),
      row({ clientCode: "C2", clientName: "Returned it all", value: -200 }),
    ]);
    assert.equal(
      facts.customers.count,
      1,
      "a customer whose window nets to zero bought nothing — counting them inflates 'he sells to N'",
    );
    assert.equal(facts.totalValue, 500, "but the value still nets, because the money did move");
  }

  // ------------------------------------------------------------------ 4. channels
  {
    const facts = buildConcentration([
      row({ channel: "distributor", value: 600 }),
      row({ channel: "wholesaler", value: 300 }),
      row({ channel: "direct", value: 100 }),
    ]);
    assert.deepEqual(
      facts.channels,
      { direct: 100, distributor: 600, wholesaler: 300 },
      "three buckets, one per way a pound reached the market",
    );
    assert.equal(
      facts.channels.distributor + facts.channels.wholesaler + facts.channels.direct,
      facts.totalValue,
      "the three must sum to the total, or a pie chart of them lies",
    );
  }

  // ------------------------------------------------------------------ 5. nothing at all
  {
    const facts = buildConcentration([]);
    assert.equal(facts.bricks.topShare, null, "no sales means no share — never 0%, which reads as 'sold nothing to everyone'");
    assert.equal(facts.bricks.halfFrom, null);
    assert.match(describeSpread(facts.bricks, "brick"), /No brick carried sales/);
  }

  // ------------------------------------------------------------------ 5b. one scope, named by its areas
  {
    const rows = [
      row({ areaCode: "CA1", clientCode: "A", value: 100 }),
      row({ areaCode: "CA2", clientCode: "B", value: 200 }),
      row({ areaCode: "GZ3", clientCode: "C", value: 900 }),
    ];
    const district = concentrationForAreas(rows, ["CA1", "CA2"]);
    assert.equal(district.totalValue, 300, "a district is its areas, and nobody else's");
    assert.equal(district.customers.count, 2);

    assert.equal(
      concentrationForAreas(rows, ["ca1", "ca2"]).totalValue,
      300,
      "area codes reach this code from the sheet, the brick master and the organogram, and the three do not agree on case",
    );
    assert.equal(
      concentrationForAreas(rows, []).totalValue,
      0,
      "a scope with no areas gets nothing — never everything, which is the dangerous default",
    );
    assert.equal(concentrationForAreas(rows, [null, "  ", undefined]).totalValue, 0);
  }

  // ------------------------------------------------------------------ 6. spend against the trend
  {
    const grew = areaSpendTrend({
      area: "Tanta 1",
      areaCode: "D14",
      marketingCommitted: 12_000,
      months: ["2026-07", "2026-08"],
      outstationClaimed: 3_000,
      salesByMonth: { "2026-07": 100_000, "2026-08": 130_000 },
    });
    assert.equal(grew.direction, "growing");
    assert.equal(grew.changePct, 30);

    const fell = areaSpendTrend({
      area: "Mahalla",
      areaCode: "D15",
      marketingCommitted: 40_000,
      months: ["2026-07", "2026-08"],
      outstationClaimed: 0,
      salesByMonth: { "2026-07": 200_000, "2026-08": 150_000 },
    });
    assert.equal(fell.direction, "declining", "40,000 EGP of marketing against a falling area is the row worth seeing");
    assert.equal(fell.changePct, -25);

    const oneMonth = areaSpendTrend({
      area: "Assuit",
      areaCode: "UE3",
      marketingCommitted: 5_000,
      months: ["2026-07"],
      outstationClaimed: 0,
      salesByMonth: { "2026-07": 90_000 },
    });
    assert.equal(oneMonth.direction, "unknown", "one month has no direction");
    assert.equal(oneMonth.changePct, null, "and no percentage — a flat 0% would read as 'no change'");

    const fromZero = areaSpendTrend({
      area: "New",
      areaCode: "NEW",
      marketingCommitted: 1_000,
      months: ["2026-07", "2026-08"],
      outstationClaimed: 0,
      salesByMonth: { "2026-07": 0, "2026-08": 4_000 },
    });
    assert.equal(fromZero.changePct, null, "a zero base has no percentage to grow BY");
    assert.equal(fromZero.direction, "growing", "but it did grow, and the direction still says so");
  }

  // ------------------------------------------------------------------ 7. spend per point
  {
    assert.equal(spendPerPoint({ marketingCost: 3_000, outstationCost: 1_000 }, 100), 40);
    assert.equal(
      spendPerPoint({ marketingCost: 3_000, outstationCost: 1_000 }, null),
      null,
      "an ungradeable district has no points to divide by",
    );
    assert.equal(
      spendPerPoint({ marketingCost: 3_000, outstationCost: 1_000 }, 0),
      null,
      "and zero achievement must not print Infinity as a cost",
    );
    assert.equal(
      spendPerPoint({ marketingCost: 0, outstationCost: 0 }, 90),
      0,
      "but spending nothing to reach 90% IS an answer, and it is the best row on the page",
    );
    assert.equal(formatSpendPerPoint({ marketingCost: 3_000, outstationCost: 1_000 }, null), "—");
    assert.equal(formatSpendPerPoint({ marketingCost: 12_345, outstationCost: 0 }, 50), "247");
  }

  // ------------------------------------------------------------------ 8. the screen says STORES
  {
    // Owner, 2026-10-02: "change the word wholesalers with stores". The export says it in the pack
    // model; this is the same channel on the SCREEN, which the pack tests never render.
    const screen = stripComments(readFileSync("src/components/business-review/concentration.client.tsx", "utf8"));
    assert.match(screen, /wholesaler: "Through stores"/, "the channel label on the screen reads Through stores");
    assert.ok(!/Through wholesalers/.test(screen), "and never the old word");
  }
}
