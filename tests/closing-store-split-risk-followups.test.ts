import assert from "node:assert/strict";

import {
  applyDetailFilters,
  buildFilterOptions,
  type ClosingDetailRow,
} from "../src/lib/sales/monthly-closing-details.ts";
import {
  comparisonLeavesFromRows,
  scopeComparisonInput,
  type ComparisonSourceRow,
} from "../src/lib/sales/monthly-closing-comparison.ts";
import {
  applyStoreSplitToChannelBreakdown,
  planChannelBreakdownStoreSplit,
} from "../src/lib/sales/store-split-channel-breakdown.ts";
import {
  customersAlreadySplitAcrossAreas,
  splitStoreSalesAcrossCityAreas,
  type StoreSplitRow,
} from "../src/lib/sales/store-sales-city-split.ts";
import { assembleChannelBreakdown } from "../src/lib/sales/monthly-closing-channel-comparison.ts";

// Three follow-up fixes to the 441164 hand-split fix, each closing a gap the first pass left open.
//
// RISK 1 — the on-screen Details filter and the from-rows Rankings/Gaps/Comparison sheets matched
// on `areaCode` (the brick-resolved area) while the Closing Matrix and the Data sheet had already
// moved to matching on the CLOSING area (the fact one). So a hand-split customer's own drill-down
// disagreed with its own export: filtering Details to Dakahlia 2 hid rows the Matrix credits to
// Dakahlia 2, and the Rankings sheet ranked the customer under Dakahlia 1, an area its Matrix cell
// shows nothing for. Fixed by routing both through the same `closingAreaOf` the export already uses.
//
// RISK 2 — the exemption used to fire on ANY customer whose rows spanned more than one area, with no
// way to tell a deliberate re-allocation from a wholesaler that genuinely trades out of two depots.
// A real two-depot store would have silently stopped splitting the day its second depot's sales grew
// large enough for someone to notice — turned off by data shape, not by a decision. Fixed by requiring
// BOTH a multi-area spread AND at least one row booked away from its own brick (`isRebookedRow`);
// a two-depot store's rows agree with their own bricks everywhere, so it still splits normally.
//
// RISK 3 — the Channel Breakdown's brick grid takes a brick's whole store figure off whenever the
// brick's area gave money up in the split (store-split-channel-breakdown.ts), because it reads the
// grid's own numbers rather than the split's rows. An exempt customer's brick still sits in an area
// that DOES give money up (via some OTHER customer's eligible row), so without telling the brick
// grid which part of that area's movement is exempt, it would debit the exempt customer's own brick
// for money the Matrix never moved. Fixed by reporting exempt store value per brick and holding it
// back before the clamp.

const PERIOD = "2026-07";
const LINE = "Anti Infective";
const AREA_NAMES: Record<string, string> = {
  D21: "Dakahlia 1", D22: "Dakahlia 2", D23: "Dakahlia 3", D26: "Port Said - Damietta",
};
const REUNION_CODE = "441164";
const REUNION_NAME = "ريونيون للتجارةوالاستثمار";

function detailRow(spec: {
  id: number; resolvedArea: string; factArea: string; clientCode: string; clientName: string;
  productCode: string; qty: number; salesValue: number; brickId: string;
}): ClosingDetailRow {
  return {
    areaCode: spec.resolvedArea,
    areaMismatch: spec.factArea.toUpperCase() !== spec.resolvedArea.toUpperCase(),
    areaName: AREA_NAMES[spec.resolvedArea] ?? spec.resolvedArea,
    blockCode: "",
    bonusQty: 0,
    brickId: spec.brickId,
    brickName: `brick ${spec.brickId}`,
    brickUnmapped: false,
    clientAddress: "",
    clientCode: spec.clientCode,
    clientName: spec.clientName,
    discount: 0,
    distributorCode: "IS-S",
    effectiveUnits: spec.qty,
    exclusions: [],
    factoryPrice: spec.salesValue / spec.qty,
    family: "Anti Infective",
    id: spec.id,
    includedInClosing: true,
    invoiceDate: `${PERIOD}-15`,
    invoicePeriod: PERIOD,
    isConfidential: false,
    isDirect: false,
    missingClientCode: false,
    officialLine: LINE,
    productCode: spec.productCode,
    productName: spec.productCode,
    qty: spec.qty,
    regionCode: "D2",
    regionName: "Delta 2",
    operationalRegionCode: "D2",
    operationalRegionName: "Delta 2",
    rowNumber: spec.id,
    salesValue: spec.salesValue,
    sheetAreaCode: spec.factArea,
    sheetAreaName: AREA_NAMES[spec.factArea] ?? spec.factArea,
    sheetRegionCode: "D2",
    sheetRegionName: "Delta 2",
    sheetValue: spec.salesValue,
    validationState: "valid",
  };
}

// The live 441164 shape: one brick (B186-1, master area D21), rows booked at D22 and D26.
const REUNION_ROWS: ClosingDetailRow[] = [
  { factArea: "D22", productCode: "SA001", salesValue: -11_115 },
  { factArea: "D22", productCode: "RO001", salesValue: -6_075 },
  { factArea: "D26", productCode: "RO001", salesValue: -6_075 },
  { factArea: "D26", productCode: "SA001", salesValue: -11_115 },
].map((spec, index) => detailRow({
  brickId: "B186-1", clientCode: REUNION_CODE, clientName: REUNION_NAME, factArea: spec.factArea,
  id: 900 + index, productCode: spec.productCode, qty: -100, resolvedArea: "D21",
  salesValue: spec.salesValue,
}));

export async function runClosingStoreSplitRiskFollowupsTests() {
  // ── RISK 1a: the Details filter agrees with the Matrix ──
  //
  // Filtering to Dakahlia 1 (where the BRICK sits) must show none of 441164 — the Matrix has none
  // of its money there. Filtering to Dakahlia 2 / Port Said must show exactly its own rows.
  const filteredToD21 = applyDetailFilters(REUNION_ROWS, { areaCodes: ["D21"] });
  assert.equal(
    filteredToD21.length,
    0,
    "RISK 1: filtering Details to Dakahlia 1 must show none of 441164 — its Matrix cell there is empty",
  );
  const filteredToD22 = applyDetailFilters(REUNION_ROWS, { areaCodes: ["D22"] });
  assert.equal(filteredToD22.length, 2, "RISK 1: Dakahlia 2 shows exactly 441164's two D22 rows");
  assert.ok(
    filteredToD22.every((row) => row.clientCode === REUNION_CODE),
    "RISK 1: and nothing else, since only 441164 sits there",
  );

  // The area picker must offer Dakahlia 2 / Port Said for this customer, not Dakahlia 1 — a reader
  // choosing from the dropdown can only pick an area the rows can actually be filtered to.
  const options = buildFilterOptions(REUNION_ROWS);
  assert.deepEqual(
    options.areas.map((area) => area.code).sort(),
    ["D22", "D26"],
    "RISK 1: the area filter dropdown offers where 441164's money actually is, not its brick's area",
  );
  assert.equal(
    options.areas.find((area) => area.code === "D26")?.name,
    "Port Said - Damietta",
    "RISK 1: a re-booked row's area option is named from the SHEET, not mislabelled with D21's name",
  );

  // ── RISK 1b: the from-rows Rankings/Gaps/Comparison agree with the Matrix too ──
  //
  // comparisonLeavesFromRows backs the Rankings, Gaps and Distributor Comparison sheets under a
  // row-level filter. It must place 441164 under D22/D26, not D21, or those sheets would rank the
  // customer somewhere its own Matrix cell holds nothing.
  const sourceRows: ComparisonSourceRow[] = REUNION_ROWS.map((row) => ({
    areaCode: row.areaCode,
    brickId: row.brickId,
    brickName: row.brickName,
    clientCode: row.clientCode,
    clientName: row.clientName,
    distributorCode: row.distributorCode,
    includedInClosing: row.includedInClosing,
    productCode: row.productCode,
    productName: row.productName,
    qty: row.qty,
    regionCode: row.regionCode,
    salesValue: row.salesValue,
    sheetAreaCode: row.sheetAreaCode,
  }));
  const leaves = comparisonLeavesFromRows(sourceRows);
  const reunionCustomers = leaves.customerRows.filter((row) => row.clientCode === REUNION_CODE);
  const reunionBricks = leaves.brickRows.filter((row) => row.brickId === "B186-1");
  assert.deepEqual(
    reunionBricks.map((row) => row.areaCode).sort(),
    ["D22", "D26"],
    "RISK 1: the brick leaf agrees too — one physical brick, reported under the areas its sales actually landed in",
  );

  // ── RISK 1c: a SEPARATE bug this test uncovered — the customer leaf's own GRAIN ──
  //
  // `phx_closing_customers` groups by area in SQL: queried live for 441164 it returns TWO rows, one
  // per area (D22 -200/-17,190, D26 -200/-17,190) — verified 2026-08-07. The from-rows path used to
  // key its customer leaf on distributor+client ONLY, no area, so it folded a multi-area customer to
  // ONE row carrying whichever row was visited first. The customer's TOTAL money still summed in
  // correctly, so Rankings/Pareto looked right — but scopeComparisonInput's area filter reads that
  // one stored `areaCode`: filtering to the area that lost the fold silently dropped the customer,
  // and filtering to the area that kept it credited the customer's WHOLE total there. This is the
  // exact family of defect item 9 asked to check for, just one level up from the Details tab.
  assert.deepEqual(
    reunionCustomers.map((row) => row.areaCode).sort(),
    ["D22", "D26"],
    "RISK 1: the customer leaf now carries ONE ROW PER AREA, matching phx_closing_customers' own grain",
  );
  assert.equal(
    reunionCustomers.some((row) => row.areaCode === "D21"),
    false,
    "RISK 1: and never under D21, which is only where its BRICK happens to sit",
  );
  for (const [area, expectedValue] of [["D22", -17_190], ["D26", -17_190]] as const) {
    const row = reunionCustomers.find((entry) => entry.areaCode === area);
    assert.equal(row?.value, expectedValue, `RISK 1: ${AREA_NAMES[area]}'s customer row carries exactly its own half`);
  }

  // A comparison filtered to Dakahlia 2 alone must show 441164 at ITS true D22 value, not the whole
  // -34,380.00 (the old fold-to-first-row bug) and not zero (the fold-to-a-different-row variant).
  const scopedToD22 = scopeComparisonInput(
    { brickRows: leaves.brickRows, customerRows: leaves.customerRows, distProductRows: leaves.distProductRows,
      line: LINE, maps: { areaName: new Map(Object.entries(AREA_NAMES)), areaRegion: new Map(), distributorName: new Map(), regionName: new Map() },
      masterAreas: [], masterBricks: [], period: PERIOD },
    { areaCodes: ["D22"] },
  );
  const scopedReunion = scopedToD22.customerRows.filter((row) => row.clientCode === REUNION_CODE);
  assert.equal(scopedReunion.length, 1, "RISK 1: a Dakahlia-2-filtered comparison keeps exactly 441164's D22 row");
  assert.equal(scopedReunion[0]?.value, -17_190, "RISK 1: at its true half, never the whole return");

  // And filtered to Dakahlia 1 (the brick's own area), which never held any of this money, 441164
  // must vanish completely rather than surviving at whichever area the fold happened to keep.
  const scopedToD21 = scopeComparisonInput(
    { brickRows: leaves.brickRows, customerRows: leaves.customerRows, distProductRows: leaves.distProductRows,
      line: LINE, maps: { areaName: new Map(Object.entries(AREA_NAMES)), areaRegion: new Map(), distributorName: new Map(), regionName: new Map() },
      masterAreas: [], masterBricks: [], period: PERIOD },
    { areaCodes: ["D21"] },
  );
  assert.equal(
    scopedToD21.customerRows.some((row) => row.clientCode === REUNION_CODE),
    false,
    "RISK 1: a Dakahlia-1-filtered comparison shows none of 441164 — its Matrix cell there is empty",
  );

  // ── RISK 2: a genuine two-depot wholesaler must keep splitting ──
  //
  // Real depots, not a hand re-allocation: each row's fact area matches its OWN brick's resolved
  // area — D21's row sits on a D21 brick, D23's row sits on a D23 brick. Spanning two areas alone
  // must not exempt it, or a real wholesaler stops splitting the moment it opens a second depot.
  const TWO_DEPOT_CODE = "W-TWO-DEPOT";
  const TWO_DEPOT_NAME = "مخزن دمياط للتجارة";
  const twoDepotRows: ClosingDetailRow[] = [
    detailRow({
      brickId: "BR-D21", clientCode: TWO_DEPOT_CODE, clientName: TWO_DEPOT_NAME, factArea: "D21",
      id: 810, productCode: "RO001", qty: 200, resolvedArea: "D21", salesValue: 60_000,
    }),
    detailRow({
      brickId: "BR-D23", clientCode: TWO_DEPOT_CODE, clientName: TWO_DEPOT_NAME, factArea: "D23",
      id: 811, productCode: "RO001", qty: 100, resolvedArea: "D23", salesValue: 30_000,
    }),
  ];
  assert.equal(
    customersAlreadySplitAcrossAreas(twoDepotRows).has(TWO_DEPOT_CODE),
    false,
    "RISK 2: two genuine depots in two areas is not a hand-split — the exemption must not fire",
  );
  const twoDepotSplit = splitStoreSalesAcrossCityAreas(twoDepotRows);
  assert.equal(twoDepotSplit.splitRowCount, 2, "RISK 2: BOTH of the wholesaler's rows still split");
  const twoDepotOut = twoDepotSplit.rows.filter((row) => row.clientCode === TWO_DEPOT_CODE);
  assert.equal(twoDepotOut.length, 6, "RISK 2: 2 source rows x 3 Dakahlia areas = 6 shares");
  assert.equal(
    Number(twoDepotOut.reduce((sum, row) => sum + row.salesValue, 0).toFixed(2)),
    90_000,
    "RISK 2: value is preserved across the split",
  );

  // And 441164 alongside it in the SAME run must still be exempt — the two customers do not
  // interfere with each other's classification.
  const mixedExempt = customersAlreadySplitAcrossAreas([...REUNION_ROWS, ...twoDepotRows]);
  assert.ok(mixedExempt.has(REUNION_CODE), "RISK 2: 441164 stays exempt alongside a real wholesaler");
  assert.equal(mixedExempt.has(TWO_DEPOT_CODE), false, "RISK 2: the real wholesaler stays eligible");

  // ── RISK 3: the Channel Breakdown brick grid does not debit an exempt customer's brick ──
  //
  // 441164's whole month, both legs (D22 and D26), alongside one genuine wholesaler in D22
  // (different brick, same city). Feeding only PART of 441164 would make it look single-area again
  // — the exact fixture mistake this test caught the first time it was written, so the whole
  // customer goes in, matching what the export route actually hands the split (the WHOLE month).
  const OTHER_STORE_D22 = detailRow({
    brickId: "BR-OTHER-D22", clientCode: "W-OTHER", clientName: "مخزن أخرى", factArea: "D22",
    id: 812, productCode: "RO001", qty: 90, resolvedArea: "D22", salesValue: 27_000,
  });
  const gridRows = [...REUNION_ROWS, OTHER_STORE_D22];
  const { movements, exemptStoreValueByBrick } = splitStoreSalesAcrossCityAreas(
    gridRows as unknown as (StoreSplitRow & { brickId: string })[],
  );
  // Only the D22 leg counts: D26 (Port Said - Damietta) is a ONE-area city, so isSplitEligible is
  // false for it regardless of the customer's exemption — there is no split for it to be exempt
  // FROM. This is what proves the exemption and eligibility gates compose correctly. Keyed by
  // brick+area, not brick alone — see the field doc on exemptStoreValueByBrick.
  assert.equal(
    exemptStoreValueByBrick.get("B186-1|D22"),
    -17_190,
    "RISK 3: only 441164's D22 leg was ever split-eligible, so only that (brick, area) pair is held back",
  );
  assert.equal(
    exemptStoreValueByBrick.has("B186-1|D26"),
    false,
    "RISK 3: the ineligible D26 leg never enters the map at all — there is nothing to hold back",
  );

  // The 'brick' dimension groups purely by brick_id in the real RPC (verified live 2026-08-07 via
  // phx_closing_channel_breakdown's SQL) — it does NOT split by area. So B186-1's grid figure is its
  // WHOLE month, both legs together, exactly as production would report it.
  const STORE_ON_B186_D22 = -17_190; // 441164's D22 leg: -11,115 + -6,075
  const STORE_ON_B186_D26 = -17_190; // 441164's D26 leg: -6,075 + -11,115
  const STORE_ON_B186_WHOLE = STORE_ON_B186_D22 + STORE_ON_B186_D26; // -34,380
  const STORE_ON_OTHER_D22 = 27_000;
  const breakdown = assembleChannelBreakdown({
    line: LINE,
    period: PERIOD,
    restrictedProductsIncluded: false,
    rows: [
      { dimension: "area", hospital: 0, key: "D22", label: "", pharmacy: 0, store: STORE_ON_B186_D22 + STORE_ON_OTHER_D22, total: STORE_ON_B186_D22 + STORE_ON_OTHER_D22 },
      { dimension: "area", hospital: 0, key: "D21", label: "", pharmacy: 0, store: 0, total: 0 },
      { dimension: "area", hospital: 0, key: "D23", label: "", pharmacy: 0, store: 0, total: 0 },
      { dimension: "area", hospital: 0, key: "D26", label: "", pharmacy: 0, store: STORE_ON_B186_D26, total: STORE_ON_B186_D26 },
      { dimension: "rep", hospital: 0, key: "HR-D22", label: "Mansoura Rep", pharmacy: 0, store: STORE_ON_B186_D22 + STORE_ON_OTHER_D22, total: STORE_ON_B186_D22 + STORE_ON_OTHER_D22 },
      { dimension: "rep", hospital: 0, key: "HR-D26", label: "Port Said Rep", pharmacy: 0, store: STORE_ON_B186_D26, total: STORE_ON_B186_D26 },
      // The WHOLE brick, both legs — matching the real RPC's brick_id-only grouping.
      { dimension: "brick", hospital: 0, key: "B186-1", label: "", pharmacy: 0, store: STORE_ON_B186_WHOLE, total: STORE_ON_B186_WHOLE },
      { dimension: "brick", hospital: 0, key: "BR-OTHER-D22", label: "", pharmacy: 0, store: STORE_ON_OTHER_D22, total: STORE_ON_OTHER_D22 },
      { dimension: "product", hospital: 0, key: "RO001", label: "Royafloxacin", pharmacy: 0, store: -6_075 - 6_075 + STORE_ON_OTHER_D22, total: -6_075 - 6_075 + STORE_ON_OTHER_D22 },
      { dimension: "product", hospital: 0, key: "SA001", label: "Sanofur", pharmacy: 0, store: -11_115 - 11_115, total: -11_115 - 11_115 },
      { dimension: "area_rep", hospital: 0, key: "D21", label: "Dakahlia 1 Rep", pharmacy: 0, rep_key: "HR-D21", store: 0, total: 0 },
      { dimension: "area_rep", hospital: 0, key: "D22", label: "Mansoura Rep", pharmacy: 0, rep_key: "HR-D22", store: 0, total: 0 },
      { dimension: "area_rep", hospital: 0, key: "D23", label: "Dakahlia 3 Rep", pharmacy: 0, rep_key: "HR-D23", store: 0, total: 0 },
      { dimension: "area_rep", hospital: 0, key: "D26", label: "Port Said Rep", pharmacy: 0, rep_key: "HR-D26", store: 0, total: 0 },
      // brick_area IS per-area, matching the real RPC's `group by brick_key, area_key` — this is
      // where each of 441164's two legs is reported separately.
      { dimension: "brick_area", area_key: "D22", hospital: 0, key: "B186-1", label: "", pharmacy: 0, store: STORE_ON_B186_D22, total: STORE_ON_B186_D22 },
      { dimension: "brick_area", area_key: "D26", hospital: 0, key: "B186-1", label: "", pharmacy: 0, store: STORE_ON_B186_D26, total: STORE_ON_B186_D26 },
      { dimension: "brick_area", area_key: "D22", hospital: 0, key: "BR-OTHER-D22", label: "", pharmacy: 0, store: STORE_ON_OTHER_D22, total: STORE_ON_OTHER_D22 },
      { dimension: "population", hospital: 0, key: "TOTAL", label: "", pharmacy: 0, store: STORE_ON_B186_WHOLE + STORE_ON_OTHER_D22, total: STORE_ON_B186_WHOLE + STORE_ON_OTHER_D22 },
    ],
  });

  const before = STORE_ON_B186_WHOLE + STORE_ON_OTHER_D22;
  const plan = planChannelBreakdownStoreSplit(breakdown, movements, exemptStoreValueByBrick);
  const after = applyStoreSplitToChannelBreakdown(breakdown, plan);
  const brickValue = (key: string) => after.byDimension.brick.find((row) => row.key === key)?.store ?? 0;

  // THE HEADLINE ASSERTION. Before this fix, D22 gave money up in the split (OTHER_STORE_D22 is
  // eligible there), so planChannelBreakdownStoreSplit's un-adjusted outByBrick took B186-1's WHOLE
  // D22-leg figure off it — -17,190 debited from a brick the Matrix never touched.
  assert.equal(
    brickValue("B186-1"),
    STORE_ON_B186_WHOLE,
    "RISK 3: 441164's brick keeps its FULL month, both legs — the Matrix never moved this "
      + "customer's money, so the grid must not debit it either",
  );
  assert.equal(
    brickValue("BR-OTHER-D22"),
    0,
    "RISK 3: the ELIGIBLE brick in the same area is still fully debited — the exemption is per "
      + "customer, not per area",
  );
  const shared = after.byDimension.brick.find((row) => row.key === "__STORE_SPLIT__");
  assert.equal(
    shared?.store,
    STORE_ON_OTHER_D22,
    "RISK 3: the shared-money row carries only the eligible wholesaler's share, never 441164's",
  );

  // Total preservation still holds with the exemption in play — every dimension sums to the same
  // month before and after, exactly as when nothing is exempt.
  for (const dimension of ["area", "rep", "brick", "product"] as const) {
    const total = after.byDimension[dimension].reduce((sum, row) => sum + row.store, 0);
    assert.equal(
      Number(total.toFixed(2)),
      Number(before.toFixed(2)),
      `RISK 3: the ${dimension} grid still totals the month with an exempt customer's brick in the mix`,
    );
  }
  assert.equal(after.storeSplit?.applied, true, "RISK 3: the breakdown records that the split reached it");

  // ── RISK 3b: an exempt customer with TWO eligible legs, one sharing a brick with a stranger ──
  //
  // 441164's own money is a RETURN, so on its brick alone `applyStoreSplitToChannelBreakdown`'s
  // `if (take <= 0) continue` guard already throws away any debit before the exemption logic gets a
  // chance to matter — that guard exists for an unrelated reason (a "take" can only ever be a
  // positive amount actually sold), but it means the 441164 fixture above cannot, by itself, prove
  // the hold-back fires at all. This block uses POSITIVE money so the mechanism is genuinely
  // exercised, and it is the one that catches keying the hold-back by brick alone: an exempt
  // customer with eligible legs in TWO areas of the SAME brick, only one of which shares that
  // brick+area with an unrelated eligible seller.
  const EXEMPT_POS_CODE = "EX-POS-9001";
  const EXEMPT_POS_NAME = "الشركة المتحدة للأدوية";
  const exemptPosRows: ClosingDetailRow[] = [
    detailRow({
      brickId: "B-SHARED", clientCode: EXEMPT_POS_CODE, clientName: EXEMPT_POS_NAME, factArea: "D22",
      id: 820, productCode: "RO001", qty: 200, resolvedArea: "D21", salesValue: 20_000,
    }),
    detailRow({
      brickId: "B-SHARED", clientCode: EXEMPT_POS_CODE, clientName: EXEMPT_POS_NAME, factArea: "D23",
      id: 821, productCode: "RO001", qty: 150, resolvedArea: "D21", salesValue: 15_000,
    }),
  ];
  // A completely unrelated wholesaler sharing the SAME physical brick in D22 — this is the pairing
  // the grid's brick_area figure pools together, and the one the fix must tell apart.
  const ELIGIBLE_SHARER = detailRow({
    brickId: "B-SHARED", clientCode: "EL-SHARE-9002", clientName: "مخزن الشرقية", factArea: "D22",
    id: 822, productCode: "RO001", qty: 300, resolvedArea: "D22", salesValue: 30_000,
  });

  assert.ok(
    customersAlreadySplitAcrossAreas([...exemptPosRows, ELIGIBLE_SHARER]).has(EXEMPT_POS_CODE),
    "RISK 3b: two re-booked legs in two areas — this customer is exempt",
  );

  const { movements: posMovements, exemptStoreValueByBrick: posExempt } = splitStoreSalesAcrossCityAreas(
    [...exemptPosRows, ELIGIBLE_SHARER] as unknown as (StoreSplitRow & { brickId: string })[],
  );
  assert.equal(posExempt.get("B-SHARED|D22"), 20_000, "RISK 3b: the D22 leg is held back at its own pair");
  assert.equal(posExempt.get("B-SHARED|D23"), 15_000, "RISK 3b: the D23 leg is held back at ITS pair, separately");

  // The grid pools both legs plus the stranger's row into B-SHARED's figures, exactly as the real
  // RPC would: D22 combines 20,000 (exempt) + 30,000 (eligible) = 50,000; D23 carries the exempt
  // customer's other leg alone, 15,000, untouched by anything in D22.
  const posBreakdown = assembleChannelBreakdown({
    line: LINE,
    period: PERIOD,
    restrictedProductsIncluded: false,
    rows: [
      { dimension: "area", hospital: 0, key: "D22", label: "", pharmacy: 0, store: 50_000, total: 50_000 },
      { dimension: "area", hospital: 0, key: "D21", label: "", pharmacy: 0, store: 0, total: 0 },
      { dimension: "area", hospital: 0, key: "D23", label: "", pharmacy: 0, store: 15_000, total: 15_000 },
      { dimension: "rep", hospital: 0, key: "HR-D22", label: "Mansoura Rep", pharmacy: 0, store: 50_000, total: 50_000 },
      { dimension: "rep", hospital: 0, key: "HR-D23", label: "Dakahlia 3 Rep", pharmacy: 0, store: 15_000, total: 15_000 },
      { dimension: "brick", hospital: 0, key: "B-SHARED", label: "", pharmacy: 0, store: 65_000, total: 65_000 },
      { dimension: "product", hospital: 0, key: "RO001", label: "Royafloxacin", pharmacy: 0, store: 65_000, total: 65_000 },
      { dimension: "area_rep", hospital: 0, key: "D21", label: "Dakahlia 1 Rep", pharmacy: 0, rep_key: "HR-D21", store: 0, total: 0 },
      { dimension: "area_rep", hospital: 0, key: "D22", label: "Mansoura Rep", pharmacy: 0, rep_key: "HR-D22", store: 0, total: 0 },
      { dimension: "area_rep", hospital: 0, key: "D23", label: "Dakahlia 3 Rep", pharmacy: 0, rep_key: "HR-D23", store: 0, total: 0 },
      { dimension: "brick_area", area_key: "D22", hospital: 0, key: "B-SHARED", label: "", pharmacy: 0, store: 50_000, total: 50_000 },
      { dimension: "brick_area", area_key: "D23", hospital: 0, key: "B-SHARED", label: "", pharmacy: 0, store: 15_000, total: 15_000 },
      { dimension: "population", hospital: 0, key: "TOTAL", label: "", pharmacy: 0, store: 65_000, total: 65_000 },
    ],
  });

  const posPlan = planChannelBreakdownStoreSplit(posBreakdown, posMovements, posExempt);
  const posAfter = applyStoreSplitToChannelBreakdown(posBreakdown, posPlan);
  const posBrick = posAfter.byDimension.brick.find((row) => row.key === "B-SHARED")?.store;

  // THE HEADLINE ASSERTION. A per-BRICK hold-back (summing both the D22 and D23 legs to 35,000, then
  // subtracting that whole sum from D22's pooled 50,000) leaves 15,000 — UNDER-debiting the eligible
  // wholesaler by 15,000 that belongs to no one's exemption at all. The correct debit is exactly the
  // eligible wholesaler's own 30,000: B-SHARED starts at 65,000 and must end at 65,000 - 30,000.
  assert.equal(
    posBrick,
    65_000 - 30_000,
    "RISK 3b: only the genuinely eligible 30,000 leaves the shared brick — the exempt customer's "
      + "other-area leg (D23, 15,000) must not shrink a debit it was never part of",
  );
  const posShared = posAfter.byDimension.brick.find((row) => row.key === "__STORE_SPLIT__");
  assert.equal(posShared?.store, 30_000, "RISK 3b: the shared row receives exactly the eligible seller's share");
  for (const dimension of ["area", "rep", "brick", "product"] as const) {
    assert.equal(
      Number(posAfter.byDimension[dimension].reduce((sum, row) => sum + row.store, 0).toFixed(2)),
      65_000,
      `RISK 3b: the ${dimension} grid still totals 65,000 with a shared brick in the mix`,
    );
  }
}
