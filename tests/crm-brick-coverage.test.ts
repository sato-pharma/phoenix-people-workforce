import assert from "node:assert/strict";

import { computeBrickCoverage } from "../src/lib/crm/brick-coverage";

// The two honesty rules of the Brick Coverage board, pinned.
//
// Both exist because the obvious implementation is wrong in a way that reads as a finding rather
// than a bug, and both are about how real people are judged on live HR data:
//
//   1. Coverage is weighted by SELLING UNITS, not by brick count. Territories are full of bricks
//      that sell nothing; counting them makes a diligent rep look negligent.
//   2. A rep with no GPS check-in in the month is NOT scored zero — he is excluded from every
//      total and listed separately. `ireports360_checkins` is a partial feed: in July 2026 four
//      reps logged 378/248/131/119 visits with zero check-ins.
//
// If either regresses, the board starts making false accusations, so these assertions are the
// point of the file — not the arithmetic around them.

type Territory = Parameters<typeof computeBrickCoverage>[0]["territories"][number];

const MONTH = "2026-07";

function territory(over: Partial<Territory> & { hrId: string; repKey: string }): Territory {
  return {
    areaCodes: ["A1"],
    areaNames: ["Alpha Area"],
    line: "cns",
    repName: over.repKey,
    ...over,
  };
}

const BRICK_NAMES = new Map([
  ["B1", { areaName: "Alpha Area", brickName: "Big Brick" }],
  ["B2", { areaName: "Alpha Area", brickName: "Quiet Brick" }],
  ["B3", { areaName: "Alpha Area", brickName: "Empty Brick" }],
]);

export function runCrmBrickCoverageTests() {
  // ── Rule 1: units, not brick count ───────────────────────────────────────────────────────────
  // Rania holds three selling bricks and visited only ONE — but that one carries 900 of her 1,000
  // units. By brick count she is at 33%; by units she is at 90%. The board must report 90.
  {
    const board = computeBrickCoverage({
      brickNames: BRICK_NAMES,
      checkinsByRep: new Map([["rania", 12]]),
      month: MONTH,
      sales: [
        { areaCode: "A1", brickId: "B1", lineFolded: "cns", units: 900 },
        { areaCode: "A1", brickId: "B2", lineFolded: "cns", units: 60 },
        { areaCode: "A1", brickId: "B3", lineFolded: "cns", units: 40 },
      ],
      scopeLabel: "test",
      territories: [territory({ hrId: "R-1", repKey: "rania", repName: "Rania" })],
      visitedByRep: new Map([["rania", new Map([["B1", 12]])]]),
    });

    const row = board.repRows[0];
    assert.equal(
      row.salesCoveragePct,
      90,
      "Coverage must be weighted by selling units, not brick count — visiting the brick that carries 90% of the units is 90% coverage",
    );
    assert.equal(row.brickCoveragePct, 33, "brick count coverage is still reported alongside, as context");
    assert.equal(board.totals.salesCoveragePct, 90, "the headline total must use the units weighting too");
    assert.equal(row.bricksWithSales, 3);
    assert.equal(row.bricksCovered, 1);

    // The two bricks she missed are named, biggest first, so the gap is actionable.
    assert.deepEqual(
      board.blindSpots.map((spot) => spot.brickName),
      ["Quiet Brick", "Empty Brick"],
      "unvisited selling bricks must be listed biggest-first",
    );
    assert.equal(board.blindSpots[0].pctOfRepSales, 6);
  }

  // A brick that sold NOTHING must never enter the denominator — otherwise every rep is punished
  // for not walking bricks that produce no business.
  {
    const board = computeBrickCoverage({
      brickNames: BRICK_NAMES,
      checkinsByRep: new Map([["rania", 4]]),
      month: MONTH,
      sales: [{ areaCode: "A1", brickId: "B1", lineFolded: "cns", units: 500 }],
      scopeLabel: "test",
      territories: [territory({ hrId: "R-1", repKey: "rania", repName: "Rania" })],
      visitedByRep: new Map([["rania", new Map([["B1", 4]])]]),
    });
    assert.equal(board.repRows[0].bricksWithSales, 1, "only bricks with sales this month count");
    assert.equal(board.repRows[0].salesCoveragePct, 100);
    assert.equal(board.blindSpots.length, 0, "a fully covered rep has no blind spots");
  }

  // ── Rule 2: a missing GPS feed is never a zero ───────────────────────────────────────────────
  // Hany has a real territory and real sales but no check-in at all this month. He must NOT appear
  // as a scored rep at 0%, must NOT drag the company total down, and must be named as unscored.
  {
    const board = computeBrickCoverage({
      brickNames: BRICK_NAMES,
      checkinsByRep: new Map([["rania", 10]]),
      month: MONTH,
      sales: [
        { areaCode: "A1", brickId: "B1", lineFolded: "cns", units: 100 },
        { areaCode: "A2", brickId: "B2", lineFolded: "cns", units: 5_000 },
      ],
      scopeLabel: "test",
      territories: [
        territory({ hrId: "R-1", repKey: "rania", repName: "Rania" }),
        territory({ areaCodes: ["A2"], areaNames: ["Beta Area"], hrId: "H-1", repKey: "hany", repName: "Hany" }),
      ],
      visitedByRep: new Map([["rania", new Map([["B1", 10]])]]),
    });

    assert.deepEqual(
      board.repRows.map((row) => row.repKey),
      ["rania"],
      "a rep with no check-in in the month must not appear as a scored row",
    );
    assert.deepEqual(
      board.unmeasured.map((row) => row.repKey),
      ["hany"],
      "…he must be listed as not-scored instead, so he is never silently dropped either",
    );
    assert.equal(board.totals.unmeasuredReps, 1);
    assert.equal(board.totals.measuredReps, 1);
    assert.equal(
      board.totals.unitsInTerritory,
      100,
      "an unscored rep's units must stay OUT of the denominator — including them would let a feed outage read as a company-wide coverage collapse",
    );
    assert.equal(board.totals.salesCoveragePct, 100);
    assert.equal(
      board.blindSpots.length,
      0,
      "an unscored rep must not generate blind spots either — we do not know where he went",
    );
  }

  // ── Line identity is folded, never compared raw ──────────────────────────────────────────────
  // The seat model writes `anti_infective`; the sales fact writes `Anti Infective`. A raw string
  // comparison silently yields an empty territory, which renders as a rep with no sales rather
  // than as an error — so the fold is load-bearing, not cosmetic.
  {
    const board = computeBrickCoverage({
      brickNames: BRICK_NAMES,
      checkinsByRep: new Map([["omar", 3]]),
      month: MONTH,
      sales: [{ areaCode: "A1", brickId: "B1", lineFolded: "antiinfective", units: 200 }],
      scopeLabel: "test",
      territories: [territory({ hrId: "O-1", line: "anti_infective", repKey: "omar", repName: "Omar" })],
      visitedByRep: new Map([["omar", new Map([["B1", 3]])]]),
    });
    assert.equal(
      board.repRows[0].unitsInTerritory,
      200,
      "`anti_infective` (seat model) must match `Anti Infective` (sales fact) after folding",
    );
    assert.equal(board.repRows[0].salesCoveragePct, 100);
  }

  // A brick visited that carries none of the rep's sales is counted as spill, not as coverage.
  {
    const board = computeBrickCoverage({
      brickNames: BRICK_NAMES,
      checkinsByRep: new Map([["rania", 6]]),
      month: MONTH,
      sales: [{ areaCode: "A1", brickId: "B1", lineFolded: "cns", units: 300 }],
      scopeLabel: "test",
      territories: [territory({ hrId: "R-1", repKey: "rania", repName: "Rania" })],
      visitedByRep: new Map([["rania", new Map([["B1", 3], ["B9", 3]])]]),
    });
    assert.equal(board.repRows[0].offTerritoryBricks, 1, "a visited brick carrying none of his sales is off-territory spill");
    assert.equal(board.repRows[0].salesCoveragePct, 100, "…and must not change his coverage either way");
  }

  // Scope label is passed through verbatim — the owner's standing rule that a viewer always sees
  // whose numbers are on screen.
  {
    const board = computeBrickCoverage({
      brickNames: BRICK_NAMES,
      checkinsByRep: new Map(),
      month: MONTH,
      sales: [],
      scopeLabel: "SFE Manager · all lines",
      territories: [],
      visitedByRep: new Map(),
    });
    assert.equal(board.scopeLabel, "SFE Manager · all lines");
    assert.equal(board.monthLabel, "July 2026");
    assert.equal(board.totals.salesCoveragePct, 0, "an empty board reports 0, never NaN");
  }
}
