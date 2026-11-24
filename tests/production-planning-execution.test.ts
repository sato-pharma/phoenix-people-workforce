import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  coerceCountTiming,
  coerceRunStage,
  countAgainstProduction,
  deductionRowDate,
  executedYield,
  measuredWaste,
  netFormulaQty,
  planDeduction,
  runTeachesTheLearner,
  spreadFactoryBalance,
  type DeductibleLot,
} from "@/lib/production-planning/execution.ts";
import type { RunGeometry } from "@/lib/production-planning/geometry.ts";
import { measuredConsumptionByProduct } from "@/lib/production-planning/learning.ts";
import { formatQty, parseQty, QTY_SCALE } from "@/lib/production-planning/rules.ts";
import { STOCK_SOURCES } from "@/lib/production-planning/stock.ts";

/**
 * The EXECUTION phase of the Production Planner (owner, 2026-11-24).
 *
 * His words: "تم انتاج ٢٢١٣٠ علبه ساجنكو و٦٩٨٥ عينه عايزه اشوف ادخلهم فين علشان يديني الستوك وخليه ما
 * يحسبش نسبة هادر. بعد كام يوم حاجيب الرصيد من المصنع ونبقى نحسب كمية الهادر ساعتها يحسب على الactual
 * only." So a produced count takes the NET formula off stock — no overage — and the waste is only
 * measured once the factory's own balance is in. Every figure below is his own Saginkgo example,
 * worked by hand from the product's geometry and formula lines as production holds them.
 */

/** Saginkgo as production holds it: 300 mg capsules, 30 a box, a 1,500 mg sample in its own box, 3 strips. */
const SAGINKGO: RunGeometry = {
  runVolumeMl: BigInt(9_000_000),
  doseMl: BigInt(300),
  goodUnitMl: BigInt(300),
  sampleUnitMl: BigInt(1_500),
  wholeRunsOnly: true,
  unitsPerBox: BigInt(30),
  sampleInOwnBox: true,
  stripsPerBox: BigInt(3),
};

const lot = (locationId: string, qty: string, expiryDate: string | null, asOfDate = "2026-11-03"): DeductibleLot => ({
  locationId,
  expiryDate,
  qty: parseQty(qty),
  asOfDate,
});

export function runProductionPlanningExecutionTests() {
  // ── What 22,130 boxes and 6,985 samples come to ─────────────────────────────────────────────────
  const produced = executedYield(SAGINKGO, { saleableBoxes: BigInt(22_130), sampleUnits: BigInt(6_985) });
  assert.equal(produced.goodUnits, BigInt(663_900), "22,130 boxes of 30 capsules");
  assert.equal(produced.totalDoses, BigInt(698_825), "663,900 capsules + 6,985 samples of 5 = 698,825 doses");
  assert.equal(produced.stripCount, BigInt(73_375), "22,130 boxes × 3 strips + one strip per sample box");
  assert.equal(produced.perBoxCount, BigInt(22_130), "the saleable box count, for the per-box carton line");
  assert.equal(formatQty(produced.exactRunsMicro), "23.294167", "a produced count is not a whole number of batches");
  assert.equal(produced.runs, BigInt(24), "the whole-number column takes the batches rounded up");
  assert.throws(
    () => executedYield(SAGINKGO, { saleableBoxes: BigInt(0), sampleUnits: BigInt(0) }),
    /Nothing produced/,
    "nothing produced is nothing to record",
  );

  // ── The NET formula, no overage ("خليه ما يحسبش نسبة هادر") ─────────────────────────────────────
  assert.equal(
    formatQty(netFormulaQty({ basis: "per_dose", qtyPerBasis: parseQty("0.12"), unitKind: "mass" }, produced)),
    "83859",
    "ginkgo extract: 0.12 g a dose × 698,825 doses = 83,859 g, with NO 3% on top",
  );
  assert.equal(
    formatQty(netFormulaQty({ basis: "per_strip", qtyPerBasis: parseQty("0.761667"), unitKind: "mass" }, produced)),
    "55887.316125",
    "the blister foil: 0.761667 g a strip × 73,375 strips",
  );
  assert.equal(
    formatQty(netFormulaQty({ basis: "per_sample_unit", qtyPerBasis: parseQty("1"), unitKind: "count" }, produced)),
    "6985",
    "one sample box per sample",
  );
  assert.equal(
    formatQty(netFormulaQty({ basis: "per_good_unit", qtyPerBasis: parseQty("0.5"), unitKind: "count" }, executedYield(SAGINKGO, { saleableBoxes: BigInt(1), sampleUnits: BigInt(1) }))),
    "15",
    "a count material is rounded UP to a whole piece — 30 × 0.5 = 15 exactly",
  );

  // ── Which lots it comes off: the factory first, soonest expiry first, never below zero ─────────
  const plan = planDeduction({
    factoryLocationId: "factory",
    needQty: parseQty("1000"),
    lots: [
      lot("sato", "800", "2027-01-31"),
      lot("factory", "150", "2028-06-30"),
      lot("factory", "100", "2027-03-31"),
      lot("sato", "50", "2026-12-31"),
    ],
  });
  assert.deepEqual(
    plan.takes.map((take) => [take.lot.locationId, take.lot.expiryDate, formatQty(take.take), formatQty(take.remaining)]),
    [
      ["factory", "2027-03-31", "100", "0"],
      ["factory", "2028-06-30", "150", "0"],
      ["sato", "2026-12-31", "50", "0"],
      ["sato", "2027-01-31", "700", "100"],
    ],
    "the factory's store is drawn on first, then Sato's own stores, each soonest expiry first",
  );
  assert.equal(formatQty(plan.fromFactory), "250");
  assert.equal(formatQty(plan.fromSatoStores), "750");
  assert.equal(plan.unrecorded, BigInt(0));
  assert.equal(formatQty(plan.heldAtFactoryBefore), "250");

  const short = planDeduction({
    factoryLocationId: "factory",
    needQty: parseQty("83859"),
    lots: [lot("factory", "0", "2027-03-31"), lot("sato", "1000", null)],
  });
  assert.equal(formatQty(short.unrecorded), "82859", "what no recorded lot holds is reported, never written negative");
  assert.ok(
    short.takes.every((take) => take.remaining >= BigInt(0)) && short.takes.length === 1,
    "a lot already at zero is skipped, and no take leaves a lot below zero",
  );

  // ── The row date never falls behind the report it replaces ─────────────────────────────────────
  assert.equal(deductionRowDate("2026-11-24", lot("sato", "1", null, "2026-11-03")), "2026-11-24");
  assert.equal(
    deductionRowDate("2026-11-20", lot("sato", "1", null, "2026-11-22")),
    "2026-11-22",
    "a deduction dated behind its lot's newer report would lose to it on the next read and silently not happen",
  );

  // ── The factory's one figure, spread over its lots: latest expiry keeps what is left ───────────
  assert.deepEqual(
    spreadFactoryBalance({
      reportedQty: parseQty("120"),
      fallbackExpiryDate: null,
      lots: [
        { expiryDate: "2027-03-31", qty: parseQty("100"), asOfDate: "2026-11-24" },
        { expiryDate: "2028-06-30", qty: parseQty("80"), asOfDate: "2026-11-24" },
      ],
    }).map((piece) => [piece.expiryDate, formatQty(piece.qty)]),
    [
      ["2028-06-30", "80"],
      ["2027-03-31", "40"],
    ],
    "the run drew the soonest-expiring first, so what is left is taken to be the latest lot",
  );
  assert.deepEqual(
    spreadFactoryBalance({
      reportedQty: parseQty("500"),
      fallbackExpiryDate: "2027-03-31",
      lots: [],
    }).map((piece) => [piece.expiryDate, formatQty(piece.qty)]),
    [["2027-03-31", "500"]],
    "with no lot at the factory, the factory's figure opens one on the lot the run drew from",
  );
  assert.deepEqual(
    spreadFactoryBalance({
      reportedQty: parseQty("300"),
      fallbackExpiryDate: null,
      lots: [{ expiryDate: null, qty: parseQty("200"), asOfDate: "2026-11-24" }],
    }).map((piece) => formatQty(piece.qty)),
    ["300"],
    "a balance above the records goes on the latest lot rather than being dropped",
  );

  // ── The waste, on the actual only ──────────────────────────────────────────────────────────────
  const waste = measuredWaste({
    openingQty: parseQty("10000"),
    deliveredQty: parseQty("80000"),
    closingQty: parseQty("3624"),
    formulaQty: parseQty("83859"),
  });
  assert.equal(formatQty(waste.consumedQty), "86376", "consumed = opening + delivered − the factory's balance");
  assert.equal(formatQty(waste.wasteQty), "2517", "waste = consumed − formula");
  assert.equal(waste.wastePctScaled, BigInt(30_015), "2,517 ÷ 83,859 = 3.0015%, in 1/10,000ths of a percent");
  assert.equal(
    measuredWaste({ openingQty: BigInt(0), deliveredQty: parseQty("5"), closingQty: BigInt(0), formulaQty: null }).wastePctScaled,
    null,
    "no formula, no percentage — never a division by zero",
  );

  // ── Only a balanced run teaches the learner ────────────────────────────────────────────────────
  assert.equal(runTeachesTheLearner("balanced"), true);
  assert.equal(runTeachesTheLearner("awaiting_balance"), false, "the waste is not known until the factory's balance");
  assert.equal(runTeachesTheLearner("cancelled"), false);
  assert.equal(coerceRunStage("awaiting_balance"), "awaiting_balance");
  assert.equal(coerceRunStage(undefined), "balanced", "a run recorded the old way, with its closing balances, is balanced");

  // ── The per-batch consumption divides by the EXACT batches ─────────────────────────────────────
  const measured = measuredConsumptionByProduct([
    {
      runId: "r1",
      productId: "saginkgo",
      materialId: "foil",
      consumedQty: parseQty("57000"),
      theoreticalQty: null,
      runsCount: BigInt(24),
      exactRunsMicro: produced.exactRunsMicro,
      isExcludedFromLearning: false,
    },
  ]).get("saginkgo/foil");
  assert.equal(
    formatQty(measured?.perRunQty ?? BigInt(0)),
    "2446.964513",
    "57,000 g over 23.294167 batches, not over the rounded 24 (which would read 2,375 g a batch)",
  );
  const whole = measuredConsumptionByProduct([
    {
      runId: "r2",
      productId: "ivyronc",
      materialId: "ivy",
      consumedQty: parseQty("900"),
      theoreticalQty: null,
      runsCount: BigInt(9),
      isExcludedFromLearning: false,
    },
  ]).get("ivyronc/ivy");
  assert.equal(formatQty(whole?.perRunQty ?? BigInt(0)), "100", "a whole-count run divides exactly as it always did");
  assert.equal(whole?.runsCounted, BigInt(9));
  assert.equal(QTY_SCALE, BigInt(1_000_000));

  // ── The form asks for BOXES and SAMPLES, never tablets (owner, 2026-11-24) ────────────────────
  // His words on the live tab: "why trablets recorded … i want to put number of boxes or numebr
  // samples". The field fed `saleableBoxes` under the old run form's "Tablets actually produced"
  // label, so a tablet count typed as asked would have been read as that many BOXES.
  const workspace = readFileSync("src/components/production-planning/production-planning-workspace.tsx", "utf8");
  const runTab = workspace.slice(workspace.indexOf("export function RunTab("), workspace.indexOf("function RunHeadline("));
  assert.ok(runTab.includes("label={t.execBoxesProduced}"), "the first field is labelled as boxes produced");
  assert.ok(runTab.includes("label={t.execSamplesProduced}"), "the second field is labelled as samples produced");
  assert.ok(!runTab.includes("S.runActualLabel("), "the execution form never takes the tablets/capsules/sachets label");
  const headline = workspace.slice(workspace.indexOf("function RunHeadline("), workspace.indexOf("function ExecutionPreviewTable("));
  assert.ok(
    headline.includes("run.saleableBoxes ? t.execBoxesWord : saleableWord"),
    "a recorded production reads its count as boxes, not as tablets",
  );

  // ── A count typed AFTER a production must say whether it is from before it (owner, 2026-11-24) ──
  // Production, 24 Nov 2026 Cairo: 65,300 Saginkgo boxes counted at Med Care Badr at 16:00, the run
  // took 22,130 at 16:16 (43,170 left), and 76,600 — the corrected count from BEFORE the run — was
  // typed at 16:19. A count replaces the balance, so the 22,130 came back and the stock read 76,600.
  const before = countAgainstProduction({
    typedQty: BigInt(76_600),
    timing: "before_production",
    movedQty: BigInt(22_130),
    standingQty: BigInt(43_170),
  });
  assert.equal(before.storedQty, BigInt(54_470), "a count from before the run has the run's take come off it again");
  assert.equal(before.openingDelta, BigInt(11_300), "the run's opening moves from 65,300 to 76,600");
  const after = countAgainstProduction({
    typedQty: BigInt(76_600),
    timing: "after_production",
    movedQty: BigInt(22_130),
    standingQty: BigInt(43_170),
  });
  assert.equal(after.storedQty, BigInt(76_600), "a count from after the run is what the lot holds now");
  assert.equal(after.openingDelta, BigInt(0));
  assert.throws(
    () => countAgainstProduction({ typedQty: BigInt(20_000), timing: "before_production", movedQty: BigInt(22_130), standingQty: BigInt(43_170) }),
    /cannot be smaller than what the production took/,
    "the run cannot have taken more than was there before it",
  );
  assert.equal(coerceCountTiming("before_production"), "before_production");
  assert.equal(coerceCountTiming("whenever"), null, "an unknown timing is no answer, never a default");

  const service = readFileSync("src/lib/production-planning/service.ts", "utf8");
  const recordStock = service.slice(
    service.indexOf("export async function addStockEntry("),
    service.indexOf("export async function changeStockLotExpiry("),
  );
  assert.ok(
    recordStock.includes('lot.data?.source === "production" && lot.data.run_id') &&
      recordStock.includes('coerceRunStage(run.data.stage) === "awaiting_balance"') &&
      recordStock.includes("errorsFor(body).countTimingRequired"),
    "a replacing count on a lot standing on a production that waits for the factory's balance is refused until it says before or after",
  );
  assert.ok(
    recordStock.includes("savedQty = counted.storedQty;") && !recordStock.includes("qty: formatQty(storedQty),"),
    "the count's before/after answer is what gets stored, not the figure as typed",
  );
  const stockTab = workspace.slice(workspace.indexOf("export function StockTab("), workspace.indexOf("export function RunTab("));
  assert.ok(
    stockTab.includes('value="before_production"') && stockTab.includes('value="after_production"'),
    "the stock form offers both answers",
  );

  // ── The table agrees: 'production' is a source only an execution writes ────────────────────────
  const migration = readFileSync("supabase/migrations/20261124145502_production_planning_execution.sql", "utf8");
  assert.ok(migration.includes("'production'::text"), "the stock source CHECK must allow a production deduction");
  assert.ok(
    migration.includes("source <> 'production' or (run_id is not null and moved_qty is not null)"),
    "a production row must name its run and what it took, so a cancel can give it back lot by lot",
  );
  assert.ok(
    !(STOCK_SOURCES as readonly string[]).includes("production"),
    "the stock form never offers 'production' — only an execution writes one, with its run",
  );
}
