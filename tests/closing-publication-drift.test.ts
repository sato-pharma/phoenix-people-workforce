import assert from "node:assert/strict";
import {
  mergePublicationDrift,
  publicationDriftProvenClean,
  type PublicationCellDrift,
} from "../src/lib/sales/closing-publication-drift.ts";
import { closingPublicationDriftItems } from "../src/lib/needs-you/sources.ts";

// The publication drift check answers in three numbers, and the two that read like a verdict are
// SUMS over the drifted cells — so a redistribution between areas cancels to zero in both and the
// summary reads as "nothing happened". Measured on production 2026-10-09, Anti Infective 2026-09:
// 27 drifted cells, net units 0.000000, net value 0.000000, while Menoufia 2 had lost 1,111.50 EGP
// and Giza Centers had gained 858.45. Every assertion below is built around that one fact, plus the
// worse half: the store-split layer, which no snapshot of the fact rollup can see at all.

const CLEAN_CELLS: PublicationCellDrift = {
  acknowledged: false,
  acknowledgedBy: null,
  cells: 0,
  unitsDelta: 0,
  valueDelta: 0,
  verdict: "clean",
};

function cancellingCells(cells: number): PublicationCellDrift {
  // The real production shape: cells drifted, both net deltas exactly zero.
  return { acknowledged: false, acknowledgedBy: null, cells, unitsDelta: 0, valueDelta: 0, verdict: "unreviewed" };
}

export function runClosingPublicationDriftTests() {
  // ── 1. THE REGRESSION: cells drifted, both net deltas zero, and the areas are still reported ──
  const cancelled = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: [],
    factAreaMoves: new Map([[
      "Anti Infective",
      [
        { areaCode: "D13", cells: 1, unitsDelta: -10, valueDelta: -1111.5 },
        { areaCode: "GZ1", cells: 2, unitsDelta: 5, valueDelta: 858.45 },
        { areaCode: "CA6", cells: 1, unitsDelta: 7, valueDelta: 253.05 },
      ],
    ]]),
    period: "2026-09",
    publishedLines: ["Anti Infective"],
    split: { byArea: [] },
    statuses: new Map([["Anti Infective", cancellingCells(27)]]),
  });

  const antiInfective = cancelled.lines[0];
  assert.equal(
    antiInfective?.areaValueMoved,
    1111.5,
    "the published month moved 1,111.50 EGP onto other areas and the report must say so — this is "
      + "the figure the net unit and net value deltas both cancel away to zero",
  );
  assert.equal(
    cancelled.netDeltasReadAsClean,
    true,
    "every drifted line's net deltas are zero, so the publication check's own summary reads as "
      + "nothing happened — the report must flag that out loud",
  );
  assert.equal(antiInfective?.areasMoved, 3, "three areas hold a different figure than what was published");
  assert.equal(
    antiInfective?.areaMoves[0]?.areaCode,
    "D13",
    "the biggest absolute movement comes first, whichever direction it went",
  );

  // ── 2. areaValueMoved counts the RECEIVERS only ───────────────────────────────────────────────
  // Every movement has a giver and a receiver. Summing absolute deltas would report 2,223.00 for a
  // 1,111.50 movement and overstate every month by exactly double.
  assert.equal(
    cancelled.areaValueMoved,
    1111.5,
    "the money that ends up somewhere else is the sum of the POSITIVE deltas — counting the giver "
      + "as well would double every figure",
  );

  // ── 3. THE 839k CLASS: a line the publication check calls clean while the split moved money ──
  const splitOnly = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: [],
    period: "2026-09",
    publishedLines: ["Pedia"],
    split: {
      byArea: [
        { areaCode: "D11", cells: 2, lineCode: "pedia", qtyDelta: -40, valueDelta: -624623.51 },
        { areaCode: "D14", cells: 2, lineCode: "pedia", qtyDelta: 20, valueDelta: 59182.83 },
      ],
    },
    statuses: new Map([["Pedia", CLEAN_CELLS]]),
  });

  assert.equal(
    splitOnly.lines[0]?.drifted,
    true,
    "a published line whose store-split net no longer matches the rule HAS drifted, even though "
      + "the publication check reports zero drifted cells for it",
  );
  assert.deepEqual(
    splitOnly.splitOnlyLines,
    ["Pedia"],
    "a line that drifted ONLY in the store-split layer must be named, because that is precisely "
      + "the class the publication check reported as clean",
  );
  assert.equal(
    splitOnly.lines[0]?.areaValueMoved,
    59182.83,
    "the split half is measured in money that ends up on a different area, like the rollup half",
  );

  // ── 4. EVERY MOVEMENT NAMES ITS LAYER ────────────────────────────────────────────────────────
  // A reader has to know which layer to go and look at: the fact rollup is re-imported, the split
  // is rebuilt through the backfill. Collapsing them loses the only actionable part.
  const bothLayers = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: [],
    factAreaMoves: new Map([["CNS", [{ areaCode: "D21", cells: 5, unitsDelta: -3, valueDelta: -500 }]]]),
    period: "2026-09",
    publishedLines: ["CNS"],
    split: { byArea: [{ areaCode: "D22", cells: 5, lineCode: "cns", qtyDelta: 3, valueDelta: 10823.22 }] },
    statuses: new Map([["CNS", cancellingCells(5)]]),
  });
  assert.deepEqual(
    bothLayers.lines[0]?.areaMoves.map((move) => `${move.areaCode}:${move.layer}`),
    ["D22:store-split", "D21:fact-rollup"],
    "each area movement carries the layer it came from, ordered by size across both layers",
  );

  // ── 5. AN UNPUBLISHED LINE IS NOT REPORTED ───────────────────────────────────────────────────
  // Only a published line has an announced number to drift away from. Reporting an unpublished one
  // would turn a month that is simply still being worked on into a permanent alarm.
  const onlyPublished = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: [],
    period: "2026-09",
    publishedLines: ["Anti Infective"],
    split: {
      byArea: [
        { areaCode: "D11", cells: 2, lineCode: "pedia", qtyDelta: -40, valueDelta: -624623.51 },
        { areaCode: "D14", cells: 2, lineCode: "pedia", qtyDelta: 20, valueDelta: 59182.83 },
      ],
    },
    statuses: new Map([["Anti Infective", CLEAN_CELLS]]),
  });
  assert.deepEqual(
    onlyPublished.lines.map((line) => line.line),
    ["Anti Infective"],
    "Pedia is not published for this period, so its split drift is not an announced number that moved",
  );

  // ── 6. BUT A FROZEN, UNPUBLISHED LINE IS REPORTED APART — THE OTHER DIRECTION OF THE FREEZE ──
  // Publishing ONE line freezes the split for EVERY line in the month, so an unpublished line's
  // frozen net can go stale with nothing announced yet. Dropping it would hide the exposure that
  // the month gets published onto the wrong geography — measured 839,283.83 EGP on Pedia 2026-09.
  assert.deepEqual(
    onlyPublished.frozenNotPublished.map((line) => line.line),
    ["Pedia"],
    "Pedia's split is frozen by Anti Infective's publication and no longer matches the rule — that "
      + "is reported apart from the announced lines, never dropped and never mixed in with them",
  );
  assert.equal(
    onlyPublished.frozenNotPublishedValueMoved,
    59182.83,
    "with the money that would be published onto the wrong area named, not just the fact of it",
  );
  assert.equal(
    onlyPublished.drifted,
    true,
    "and the period does NOT report clean: a stale frozen net is why a month is published onto the "
      + "wrong geography, even though nothing has been announced for that line yet",
  );

  // ── 7. THE CLEAN-SUMMARY FLAG MEANS WHAT IT SAYS ─────────────────────────────────────────────
  // It must not fire when a net delta is genuinely non-zero: that is a restatement the existing
  // numbers DO show, and claiming otherwise would discredit the flag.
  const realNetMove = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: [],
    factAreaMoves: new Map([["CNS", [{ areaCode: "D21", cells: 1, unitsDelta: 12, valueDelta: 1500 }]]]),
    period: "2026-09",
    publishedLines: ["CNS"],
    split: { byArea: [] },
    statuses: new Map([[
      "CNS",
      { acknowledged: false, acknowledgedBy: null, cells: 1, unitsDelta: 12, valueDelta: 1500, verdict: "unreviewed" },
    ]]),
  });
  assert.equal(
    realNetMove.netDeltasReadAsClean,
    false,
    "when the net deltas are non-zero the existing summary already shows the move — the flag must "
      + "stay off so it keeps meaning the summary is unreadable",
  );
  // ── 8. A PARTIAL READ IS NEVER A CLEAN VERDICT ───────────────────────────────────────────────
  // The store-split layer costs 17,282 ms measured on production against ~1.5 s for the rest, so the
  // Needs You board reads the cheap layers only. An empty `split.byArea` and a split that genuinely
  // did not move produce the SAME report, so without this flag a caller would take the partial for
  // the whole and print a month as clean on the strength of a layer it never read.
  const partial = mergePublicationDrift({
    splitLayerRead: false,
    linesNotRead: [],
    factAreaMoves: new Map(),
    period: "2026-09",
    publishedLines: ["Anti Infective"],
    split: { byArea: [] },
    statuses: new Map([["Anti Infective", CLEAN_CELLS]]),
  });
  assert.equal(partial.drifted, false, "nothing moved in the layers it DID read");
  assert.equal(
    publicationDriftProvenClean(partial),
    false,
    "but the period is NOT provably clean: the expensive layer was never read, and `!report.drifted` "
      + "is exactly the assertion that would turn an unread layer into a calm month",
  );
  const whole = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: [],
    factAreaMoves: new Map(),
    period: "2026-09",
    publishedLines: ["Anti Infective"],
    split: { byArea: [] },
    statuses: new Map([["Anti Infective", CLEAN_CELLS]]),
  });
  assert.equal(
    publicationDriftProvenClean(whole),
    true,
    "the same empty report IS provably clean once both layers were actually read — otherwise the "
      + "flag would make every month unprovable and mean nothing",
  );

  // ── 9. A PLACEHOLDER SPLIT THAT CARRIES ROWS IS A CALLER BUG, NOT A PARTIAL ───────────────────
  assert.throws(
    () => mergePublicationDrift({
      splitLayerRead: false,
      linesNotRead: [],
      period: "2026-09",
      publishedLines: ["Anti Infective"],
      split: { byArea: [{ areaCode: "D21", cells: 1, lineCode: "AI", qtyDelta: 3, valueDelta: 900 }] as never },
      statuses: new Map([["Anti Infective", CLEAN_CELLS]]),
    }),
    /splitLayerRead is false but split\.byArea carries rows/,
    "a real read mislabelled as a partial would understate the report's own coverage — it is "
      + "refused rather than quietly accepted",
  );

  // ── 10. THE NEEDS YOU ROW: NO EGP, AND IT ADMITS THE LAYER IT SKIPPED ────────────────────────
  // The whole reason this reached the board is that nothing in the product asked the question. The
  // row must not repeat the failure it exists to fix — a row that claimed to be a whole-month
  // verdict would be the same under-report one step removed.
  const boardRows = closingPublicationDriftItems([
    mergePublicationDrift({
      splitLayerRead: false,
      linesNotRead: [],
      factAreaMoves: new Map([[
        "Anti Infective",
        [
          { areaCode: "D21", cells: 1, unitsDelta: 0, valueDelta: -1111.5 },
          { areaCode: "D07", cells: 2, unitsDelta: 0, valueDelta: 858.45 },
        ],
      ]]),
      period: "2026-09",
      publishedLines: ["Anti Infective"],
      split: { byArea: [] },
      statuses: new Map([["Anti Infective", cancellingCells(27)]]),
    }),
  ]);
  assert.equal(boardRows.length, 1, "one row per drifted published line");
  const [row] = boardRows;
  assert.equal(row.lane, "yours", "an unacknowledged published month that moved is his decision");
  assert.equal(row.count, 2, "the count is AREAS holding a difference, which is the thing to open");
  assert.match(
    row.label,
    /Anti Infective 2026-09 was published and has since moved across 2 areas/,
    "the line is NAMED, never a code (AGENTS.md §4)",
  );
  assert.match(
    String(row.note),
    /net unit and value deltas both read zero/,
    "and the note says the existing check's summary reads clean — the fact that made this invisible",
  );
  assert.match(
    String(row.note),
    /check-closing-publication-drift\.ts for the store-split half/,
    "a partial row names the script that reads both halves, so it is never taken for the whole",
  );
  for (const field of [row.label, String(row.note)]) {
    assert.ok(
      !/1,?111|858\.45|EGP/.test(field),
      `no money reaches this board (the payroll row's rule): ${JSON.stringify(field)}`,
    );
  }

  // ── 11. AN ACKNOWLEDGED LINE IS NOT WAITING ON HIM, AND IS NOT DROPPED EITHER ─────────────────
  const acknowledgedRows = closingPublicationDriftItems([
    mergePublicationDrift({
      splitLayerRead: false,
      linesNotRead: [],
      factAreaMoves: new Map([[
        "Anti Infective",
        [{ areaCode: "D21", cells: 1, unitsDelta: 0, valueDelta: -1111.5 }],
      ]]),
      period: "2026-09",
      publishedLines: ["Anti Infective"],
      split: { byArea: [] },
      statuses: new Map([[
        "Anti Infective",
        { acknowledged: true, acknowledgedBy: "B-10", cells: 27, unitsDelta: 0, valueDelta: 0, verdict: "accepted" },
      ]]),
    }),
  ]);
  assert.equal(acknowledgedRows.length, 1, "it is still reported — the movement has not gone away");
  assert.equal(
    acknowledgedRows[0].lane,
    "worth-knowing",
    "but it has been adjudicated, so it leaves the lane the empty-state sentence is gated on",
  );
  assert.ok(
    !/B-10/.test(String(acknowledgedRows[0].note)),
    "and the acknowledger is not printed as an HR id — names never codes, so this row names nobody",
  );
  // ── 12. A LINE WHOSE READ FAILED IS NAMED, AND BLOCKS THE CLEAN VERDICT ──────────────────────
  // `phx_closing_drift_status` times out on some line × period pairs — CNS 2026-07 and 2026-08 both
  // answered `canceling statement due to statement timeout` on production 2026-10-09. The loader
  // used to swallow that into `cellDrift: null`, which is ALSO what a line with no publication row
  // looks like, so the failure arrived as a row one sentence shorter and otherwise identical.
  const unreadable = mergePublicationDrift({
    splitLayerRead: true,
    linesNotRead: ["CNS"],
    factAreaMoves: new Map(),
    period: "2026-08",
    publishedLines: ["CNS", "Pedia"],
    split: { byArea: [] },
    statuses: new Map([["Pedia", CLEAN_CELLS]]),
  });
  assert.deepEqual(
    unreadable.linesNotRead,
    ["CNS"],
    "the line that could not be read is NAMED on the report, not dropped out of it",
  );
  assert.equal(
    unreadable.drifted,
    false,
    "nothing drifted in what WAS read — which is exactly why the next assertion matters",
  );
  assert.equal(
    publicationDriftProvenClean(unreadable),
    false,
    "and the period is still not provably clean: a read that failed is not a line that matches, and "
      + "`!report.drifted` on its own would print this month as calm",
  );
}
