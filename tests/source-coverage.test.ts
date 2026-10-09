import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildProductPeriodPrices } from "../src/lib/sales/product-period-price.ts";
import { maskSourceCoverage } from "../src/lib/sales/closing-source-mask.ts";
import {
  aggregateCoverage,
  canonicalSourceKey,
  classifyCoverage,
  isDirectModuleSourced,
  partitionAbsentSources,
  previousPeriod,
  type CoverageFactRow,
  type SourceCoverageEntry,
} from "../src/lib/sales/source-coverage.ts";
import { quietSourcesSentence, sourceQuietIn } from "../src/lib/sales/source-quiet-periods.ts";

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
  // One price in every month (no override), so these cases read exactly as they did with a flat map.
  const prices = buildProductPeriodPrices(new Map([["LA001", 100]]), new Map());
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
    prices,
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
    prices,
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
    prices,
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

  // ── each month at ITS OWN price (2026-10-01) ──────────────────────────────
  // Saginko is 111.15 through 2026-09 and 170.52 from 2026-10 (owner, 2026-09-28) while the product
  // master stays 111.15, and the Closing Matrix prices every month through phx_factory_price(code,
  // f.period). Until 2026-10-01 this module valued both columns with ONE flat master-price map, so the
  // first October file would have shown Saginko at 111.15 here beside a Matrix at 170.52 — 177,100.71
  // short at August 2026's 2,983 units — and November's "last month" column the same way.
  const repriced = buildProductPeriodPrices(
    new Map([["SA001", 111.15]]),
    new Map([["SA001", [{ effectivePeriod: "2026-10", factoryPrice: 170.52 }]]]),
  );
  const acrossTheReprice = aggregateCoverage(
    [
      factRow({ period: "2026-09", distributorCode: "PS", productCode: "SA001", totalQty: 2_983, effectiveUnits: 2_983 }),
      factRow({ period: "2026-10", distributorCode: "PS", productCode: "SA001", totalQty: 2_983, effectiveUnits: 2_983 }),
      factRow({ period: "2026-10", distributorCode: "DirectReq", isDirect: true, regionCode: "D1", productCode: "SA001", totalQty: 570, directValue: 66_960 }),
    ],
    { period: "2026-10", prevPeriod: "2026-09", prices: repriced },
  );
  assert.equal(
    Number(acrossTheReprice.sourcesCur.get("PS")?.value.toFixed(2)),
    508_661.16,
    "October's Saginko is valued at 170.52 — the price the Closing Matrix gives that month, never the master's 111.15",
  );
  assert.equal(
    Number(acrossTheReprice.sourcesPrev.get("PS")?.value.toFixed(2)),
    331_560.45,
    "September, in the column beside it, keeps 111.15 — each row is priced at its OWN month, not the month being viewed",
  );
  assert.equal(
    acrossTheReprice.sourcesCur.get("DIRECTREQ")?.value,
    66_960,
    "a direct order keeps its deal value whatever the factory price is",
  );

  // The loader has to hand it those prices, and the behaviour above cannot see what the loader passes.
  // A flat read of the product master here is exactly what valued October at 111.15.
  const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const MASTER_TABLE_READ = /\.from\(\s*["']source_of_sales_products["']\s*\)/;
  const loaderSource = stripComments(
    readFileSync(new URL("../src/lib/sales/source-coverage.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    /\bloadProductPeriodPrices\(\)/.test(loaderSource),
    "loadMonthlySourceCoverage reads the period prices (product master + dated overrides)",
  );
  assert.ok(
    !MASTER_TABLE_READ.test(loaderSource),
    "Source Coverage must not read the product master's flat price itself — it values October's Saginko at 111.15",
  );
  assert.ok(
    MASTER_TABLE_READ.test(`supabase.from("source_of_sales_products").select("product_code,factory_price").eq("active", true)`),
    "control: the detector fires on the exact read it replaced",
  );

  // ── A source the owner declared quiet is absent, but not OWED ──────────────────────────────
  //
  // Owner, 2026-10-09: "fix the closing banner that still calls epda and mec a hole". September
  // CNS read "missing 2 of the 13 sources that fed 2026-08 — epda, mec … Totals are understated
  // until these arrive" on a month he had already said was finished, promising two books that are
  // never coming. The declaration existed; nothing read it — `sourceQuietIn` had zero callers.
  assert.ok(sourceQuietIn("EP", "2026-09"), "epda is declared quiet in September 2026");
  assert.ok(sourceQuietIn("MC", "2026-09"), "mec is declared quiet in September 2026");
  assert.ok(sourceQuietIn("ep", "2026-09"), "the code is compared folded, as every other source key is");
  assert.equal(
    sourceQuietIn("EP", "2026-10"),
    null,
    "period-scoped, never a retirement — October expects epda's file again",
  );
  assert.equal(
    sourceQuietIn("EP-BK", "2026-09"),
    null,
    "EPDA-BULK is a SEPARATE source that did file in September — a declaration must never reach it by prefix",
  );
  assert.equal(sourceQuietIn("", "2026-09"), null, "an empty code matches nothing");

  const absentEntry = (key: string, name: string, prevValue: number): SourceCoverageEntry => ({
    key,
    name,
    prevUnits: 10,
    prevValue,
    curUnits: 0,
    curValue: 0,
    status: "missing",
  });
  const septemberShape: SourceCoverageEntry[] = [
    absentEntry("EP", "epda", 1_900.5),
    absentEntry("MC", "mec", 618.59),
    { ...absentEntry("EP-BK", "EPDA-BULK", 5_000), curUnits: 11_398, curValue: 500_000, status: "present" },
  ];
  const september = partitionAbsentSources(septemberShape, "2026-09");
  assert.equal(september.missing.length, 0, "September owes nothing — its only absences are the two he declared");
  assert.deepEqual(
    september.quiet.map((entry) => entry.name),
    ["epda", "mec"],
    "both declared sources are held apart by NAME, so the banner can still say which books are not coming",
  );
  assert.ok(
    !september.quiet.some((entry) => entry.key === "EP-BK"),
    "a source that FILED is present and reaches neither list — the data outvotes the declaration",
  );

  const october = partitionAbsentSources(
    septemberShape.map((entry) => ({ ...entry })),
    "2026-10",
  );
  assert.deepEqual(
    october.missing.map((entry) => entry.name),
    ["epda", "mec"],
    "the very same absences ARE holes in October — the carve-out expires with its period",
  );
  assert.equal(october.quiet.length, 0, "and nothing is explained away there");

  const withUndeclared = partitionAbsentSources(
    [...septemberShape, absentEntry("IS", "Ibn Sina", 40_000)],
    "2026-09",
  );
  assert.deepEqual(
    withUndeclared.missing.map((entry) => entry.name),
    ["Ibn Sina"],
    "an undeclared absence is still a hole in a month that has declared ones — the carve-out is per source",
  );

  // ── The sentence he actually reads ────────────────────────────────────────────────────────
  //
  // The defect was never the arithmetic: it was "Totals are understated until these arrive" on a
  // month he had declared finished. This pins the replacement, because a wording regression here
  // is invisible to every test of the partition above.
  const sentence = quietSourcesSentence("2026-09", september.quiet);
  assert.equal(
    sentence,
    "epda and mec file nothing in 2026-09 by the owner's instruction, so they are not counted as missing.",
  );
  assert.ok(!/arrive/i.test(sentence), "it must never promise an arrival — that promise IS the defect");
  assert.ok(!/missing \d/.test(sentence), "and it must not call them a hole");
  assert.equal(
    quietSourcesSentence("2026-09", [{ name: "mec" }]),
    "mec files nothing in 2026-09 by the owner's instruction, so it is not counted as missing.",
    "one source reads as one source — a bare plural on a single name is how these sentences rot",
  );
  assert.equal(quietSourcesSentence("2026-10", []), "", "nothing declared, nothing said");

  // The banner names these sources, so they mask exactly like the ones beside them. A field that
  // carries a distributor name and is rendered to the viewer, but is missed by the mask, is a leak
  // that no test of the other two fields can see.
  const masked = maskSourceCoverage(
    {
      missingSources: [],
      quietSources: [{ key: "QM", name: "El Qema" }],
      sources: [{ key: "QM", name: "El Qema" }],
    },
    { role: "Medical Rep", scope: "own" } as never,
  );
  assert.equal(
    masked.quietSources[0]?.name,
    masked.sources[0]?.name,
    "a masked distributor is relabelled in quietSources exactly as it is in the per-source table",
  );
  assert.notEqual(masked.quietSources[0]?.name, "El Qema", "and the real name does not survive the mask");
}
