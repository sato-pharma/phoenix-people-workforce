import assert from "node:assert/strict";

import {
  aggregateCoverage,
  canonicalSourceKey,
  classifyCoverage,
  isDirectModuleSourced,
  previousPeriod,
  type CoverageFactRow,
} from "../src/lib/sales/source-coverage.ts";

function factRow(overrides: Partial<CoverageFactRow>): CoverageFactRow {
  return {
    distributorCode: "PS",
    regionCode: "",
    isDirect: false,
    productCode: "LA001",
    period: "2026-07",
    totalQty: 0,
    effectiveUnits: 0,
    directValue: 0,
    ...overrides,
  };
}

export function runSourceCoverageTests() {
  // ── previousPeriod ─────────────────────────────────────────────────────────
  assert.equal(previousPeriod("2026-07"), "2026-06");
  assert.equal(previousPeriod("2026-01"), "2025-12", "January compares against December of the year before");
  assert.equal(previousPeriod("2026-13"), null, "an impossible month is rejected, never wrapped into next year");
  assert.equal(previousPeriod("2026-7"), null, "only the canonical YYYY-MM form the batch table stores is accepted");
  assert.equal(previousPeriod(null), null);

  // ── aggregateCoverage — a July-shaped month ───────────────────────────────
  // Prev month has Overseas + Ibn Sina + Direct in two regions; current month has Overseas and
  // only ONE of the Direct regions — the exact shape of the July 2026 incident.
  const prices = new Map([["LA001", 100]]);
  const rows: CoverageFactRow[] = [
    factRow({ period: "2026-06", distributorCode: "PS", totalQty: 10, effectiveUnits: 8 }),
    factRow({ period: "2026-06", distributorCode: "IS", totalQty: 5, effectiveUnits: 5 }),
    factRow({ period: "2026-06", distributorCode: "Direct", isDirect: true, regionCode: "GZ", totalQty: 3, directValue: 300 }),
    factRow({ period: "2026-06", distributorCode: "Direct", isDirect: true, regionCode: "D2", totalQty: 2, directValue: 200 }),
    factRow({ period: "2026-07", distributorCode: "PS", totalQty: 7, effectiveUnits: 7 }),
    factRow({ period: "2026-07", distributorCode: "Direct", isDirect: true, regionCode: "GZ", totalQty: 1, directValue: 90 }),
    // Outside the compared window — must not count anywhere.
    factRow({ period: "2026-05", distributorCode: "RM", totalQty: 99, effectiveUnits: 99 }),
    // Confidential — both closing RPCs skip LA003/LA004/SS001, so coverage must too.
    factRow({ period: "2026-06", distributorCode: "PS", productCode: "LA003", totalQty: 50, effectiveUnits: 50 }),
    // A product with no factory price values at 0 but still proves the source showed up.
    factRow({ period: "2026-06", distributorCode: "MC", productCode: "XX999", totalQty: 4, effectiveUnits: 4 }),
  ];
  const aggregates = aggregateCoverage(rows, {
    period: "2026-07",
    prevPeriod: "2026-06",
    factoryPriceByProduct: prices,
  });

  assert.equal(aggregates.sourcesPrev.get("PS")?.value, 800, "distributor rows are valued effective units × factory price — the matrix RPC's own basis");
  assert.equal(aggregates.sourcesPrev.get("PS")?.units, 10, "the confidential LA003 row bumps neither units nor value — it is outside the closing headline");
  assert.equal(aggregates.sourcesPrev.get("DIRECTREQ")?.value, 500, "direct rows carry their submitted value, never a factory-price recompute — the key is upper-cased like resolvers.ts and folded onto the Direct channel's surviving code");
  assert.equal(aggregates.sourcesPrev.get("MC")?.value, 0, "an unpriced product contributes 0, matching the RPC's coalesce(factory_price, 0)");
  assert.equal(aggregates.sourcesPrev.get("MC")?.rows, 1, "…but its rows still count, so the source reads present rather than missing");
  assert.equal(aggregates.sourcesPrev.has("RM"), false, "a row outside the two compared months is ignored entirely");
  assert.equal(aggregates.directPrev.get("D2")?.value, 200);
  assert.equal(aggregates.directCur.has("D2"), false, "the region the Direct sheet dropped shows up only on the prev side");

  // ── classifyCoverage over the aggregates ──────────────────────────────────
  const sources = classifyCoverage(
    aggregates.sourcesPrev,
    aggregates.sourcesCur,
    (key) => (key === "PS" ? "Overseas" : key),
  );
  const sourceByKey = new Map(sources.map((entry) => [entry.key, entry]));
  assert.equal(sourceByKey.get("IS")?.status, "missing", "rows last month and none this month is exactly what 'missing' means");
  assert.equal(sourceByKey.get("PS")?.status, "present");
  assert.equal(sourceByKey.get("PS")?.name, "Overseas", "human names resolve through the lookup — a code never surfaces when a name exists");
  assert.equal(sources[0]?.key, "PS", "entries sort by last-month value, biggest first, so the largest hole leads");

  const regions = classifyCoverage(aggregates.directPrev, aggregates.directCur, (key) => key);
  const regionByKey = new Map(regions.map((entry) => [entry.key, entry]));
  assert.equal(regionByKey.get("D2")?.status, "missing", "a Direct region absent this month is reported even though the Direct file itself arrived");
  assert.equal(regionByKey.get("GZ")?.status, "present");

  // ── presence is decided on rows, not value ────────────────────────────────
  const prevCredit = new Map([["SF-T", { rows: 2, units: -21, value: -722.93 }]]);
  const curCredit = new Map([
    ["SF-T", { rows: 1, units: -3, value: -100 }],
    ["EPX", { rows: 4, units: 9, value: 90 }],
  ]);
  const creditEntries = classifyCoverage(prevCredit, curCredit, (key) => key);
  const creditByKey = new Map(creditEntries.map((entry) => [entry.key, entry]));
  assert.equal(creditByKey.get("SF-T")?.status, "present", "a credit-note-only source (negative value) still has rows and must not read as missing");
  assert.equal(creditByKey.get("SF-T")?.prevValue, -722.93, "values keep their sign and 2dp rounding");
  assert.equal(creditByKey.get("EPX")?.status, "new", "rows this month with none last month is 'new', not 'present'");

  // ── case-variant distributor codes must read as ONE source, not two ──────
  // The actual 2026-07 production bug: Anti Infective kept posting "DIRECT" while Pedia's July
  // Direct rows arrived as "Direct" — same channel, different casing, on different lines. An
  // un-normalized key made the sheet report "DIRECT" as MISSING (understating every total) and
  // "Direct" as a brand-new, unexplained source, when the channel never actually stopped
  // reporting anything.
  const caseVariantRows: CoverageFactRow[] = [
    factRow({ period: "2026-06", distributorCode: "DIRECT", isDirect: true, regionCode: "GZ", totalQty: 5, directValue: 500 }),
    factRow({ period: "2026-07", distributorCode: "Direct", isDirect: true, regionCode: "GZ", totalQty: 4, directValue: 400 }),
  ];
  const caseVariantAggregates = aggregateCoverage(caseVariantRows, {
    period: "2026-07",
    prevPeriod: "2026-06",
    factoryPriceByProduct: prices,
  });
  assert.equal(caseVariantAggregates.sourcesPrev.size, 1, "DIRECT and Direct must collapse into a single aggregate key");
  assert.equal(caseVariantAggregates.sourcesCur.get("DIRECTREQ")?.value, 400, "the normalized key is upper-case, and the whole Direct channel folds onto the module's code");
  const caseVariantSources = classifyCoverage(caseVariantAggregates.sourcesPrev, caseVariantAggregates.sourcesCur, (key) => key);
  assert.equal(caseVariantSources.length, 1, "one logical source must produce one row, not a false 'missing' plus an unrelated false 'new'");
  assert.equal(caseVariantSources[0]?.status, "present", "a mid-month case change must read as the same source continuing, never as one source vanishing while a stranger appears");

  // ── the Direct channel changed SOURCE, not identity ───────────────────────
  // Owner, 2026-09-04: "no more direct that will be uploaded like this - the source of direct
  // sales is the direct request module." Until 2026-07 direct sales arrived as an uploaded
  // "Direct (Company)" sheet (code DIRECT); from 2026-08 they come from the module (DirectReq).
  // Read as two codes, every month from August onward reports the retired sheet as a source that
  // vanished - Anti Infective August 2026 was flagged "missing 1 of the 4 sources that fed
  // 2026-07 ... Totals are understated" while holding all four of its sources.
  assert.equal(canonicalSourceKey("DIRECT"), "DIRECTREQ", "the retired upload code folds onto the module's");
  assert.equal(canonicalSourceKey("DirectReq"), "DIRECTREQ");
  assert.equal(canonicalSourceKey("Direct"), "DIRECTREQ", "the fold survives the case drift the previous case pinned");
  assert.equal(canonicalSourceKey("PS"), "PS", "no other distributor is folded");
  assert.equal(canonicalSourceKey("  "), "", "an empty code stays empty for the caller's own fallback");

  const channelSwitchRows: CoverageFactRow[] = [
    factRow({ period: "2026-07", distributorCode: "PS", totalQty: 10, effectiveUnits: 10 }),
    factRow({ period: "2026-07", distributorCode: "DIRECT", isDirect: true, regionCode: "D1", totalQty: 5, directValue: 500 }),
    factRow({ period: "2026-07", distributorCode: "DIRECT", isDirect: true, regionCode: "D2", totalQty: 4, directValue: 400 }),
    factRow({ period: "2026-08", distributorCode: "PS", totalQty: 9, effectiveUnits: 9 }),
    factRow({ period: "2026-08", distributorCode: "DirectReq", isDirect: true, regionCode: "D1", totalQty: 6, directValue: 600 }),
  ];
  const switched = aggregateCoverage(channelSwitchRows, {
    period: "2026-08",
    prevPeriod: "2026-07",
    factoryPriceByProduct: prices,
  });
  const switchedSources = classifyCoverage(switched.sourcesPrev, switched.sourcesCur, (key) => key);
  assert.equal(
    switchedSources.filter((entry) => entry.status === "missing").length,
    0,
    "swapping the uploaded Direct sheet for the Direct Request module must lose NO source - this is the whole point of the fold",
  );
  assert.equal(
    switchedSources.filter((entry) => entry.status === "new").length,
    0,
    "and the module must not read as a stranger arriving either",
  );
  const directEntry = switchedSources.find((entry) => entry.key === "DIRECTREQ");
  assert.equal(directEntry?.status, "present", "one continuing channel, one row");
  assert.equal(directEntry?.prevValue, 900, "the retired sheet's value stays attached to the folded channel");
  assert.equal(directEntry?.curValue, 600);

  // The per-region drop-out warning reads "The Direct sheet has nothing yet from <region>. Totals
  // are understated until these arrive." Once the module is the source there is no sheet to wait
  // for - a region simply raised no direct request - so the alarm must not fire.
  assert.equal(isDirectModuleSourced(channelSwitchRows, "2026-08"), true, "August's direct rows all carry the module's code");
  assert.equal(isDirectModuleSourced(channelSwitchRows, "2026-07"), false, "July's came from the uploaded sheet");
  assert.equal(
    isDirectModuleSourced(channelSwitchRows.filter((row) => !row.isDirect), "2026-08"),
    false,
    "a month with NO direct rows at all is not module-sourced - absence must never silence the warning by itself",
  );
  assert.equal(
    isDirectModuleSourced(
      [...channelSwitchRows, factRow({ period: "2026-08", distributorCode: "DIRECT", isDirect: true, regionCode: "D2", totalQty: 1, directValue: 100 })],
      "2026-08",
    ),
    false,
    "one uploaded row in the month means a sheet IS still in play, and the region warning must stay armed",
  );

  // The region aggregate itself keeps working across the switch, so the Source Coverage sheet can
  // still show D2 dropping out - what changes is only whether it is reported as an awaited file.
  const switchedRegions = classifyCoverage(switched.directPrev, switched.directCur, (key) => key);
  assert.equal(switchedRegions.find((entry) => entry.key === "D2")?.status, "missing", "the per-region table still records the drop-out; only the alarm is suppressed");
  assert.equal(switchedRegions.find((entry) => entry.key === "D1")?.status, "present");
}
