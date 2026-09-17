import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AccessContext, PhoenixRole } from "../src/lib/auth/permissions.ts";
import { liftWeeklyGeography, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { buildWeeklyAreaSplitIndex } from "../src/lib/sales/weekly/branch-area-split.ts";
import { depotWeekGaps } from "../src/lib/sales/weekly/decumulate.ts";
import {
  admitWeeklyStockRows,
  mayLiftWeeklyGeography,
  resolveWeeklyOwnAreaKeys,
  weeklyFieldForceGeography,
  weeklyScopeOwnAreaKeys,
  weeklyStockProductPredicate,
  withExtraWeeklyOptions,
} from "../src/lib/sales/weekly/own-area-scope.ts";
import {
  buildPortalWeeklyFieldForce,
  fieldForceKey,
  selectFieldForceSeats,
  type FieldForceSeatRow,
  type PortalWeeklyFieldForce,
} from "../src/lib/sales/weekly/portal-weekly-field-force.ts";
import type { WeeklyStockSourceRow } from "../src/lib/sales/weekly/stock-dashboard.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// Weekly rows are depot data, and a depot row keeps the region label it was mapped with. The
// organogram moved on: Anti Infective's Upper Egypt is now Upper Egypt 1 and Upper Egypt 2, and
// Delta (3) was carved out on 2026-09-01, but nearly all of that money still says "UE" and not one row
// says Delta (3). A territory viewer was bounded by his OWN region code, so an Upper Egypt 2 manager
// never even loaded the "UE" rows the owner's depot-split rule shares with his areas: his reps read
// low on the Field Force tab, a rep's month-pace strip read about zero, and Weekly Stock was nearly
// empty (found 2026-09-16, building the medical rep's own Weekly Sales page).
//
// The fix lifts the region bound for the LOAD only and narrows straight back:
//   1. a row the viewer's own scope admits counts whole, exactly as before;
//   2. any other row counts only where the depot split places it in one of HIS areas;
//   3. nothing another district owns is added, and nothing he saw before is taken away.

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The body of one top-level function, so a wiring check cannot be satisfied by a sibling. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const AI = "Anti Infective";

// Anti Infective's Upper Egypt as production maps it: Assiut is Upper Egypt 2 on this line.
const AREA_ROWS = [
  ["UE1", "Minia 1"], ["UE2", "Minia 2"], ["UE3", "Assuit 1"], ["UE4", "Assuit 2"],
  ["UE5", "Sohag1"], ["UE6", "Sohag2"], ["UE7", "Qena 1"], ["UE8", "Qena 2"], ["UE9", "Beni Suef"],
].map(([area_code, area_name]) => ({ area_code, area_name }));

const MAP_ROWS = [
  ...[["UE1", "UE-1"], ["UE2", "UE-1"], ["UE9", "UE-1"],
      ["UE3", "UE-2"], ["UE4", "UE-2"], ["UE5", "UE-2"], ["UE6", "UE-2"], ["UE7", "UE-2"], ["UE8", "UE-2"]]
    .map(([area_code, operational_region_code]) => ({
      line_code: "anti_infective",
      area_code,
      operational_region_code,
      effective_from: "2026-07-13",
      effective_to: null,
    })),
];

const SPLIT = buildWeeklyAreaSplitIndex(MAP_ROWS, AREA_ROWS, "2026-09-16");

/** "Minia and Assiut": 25% to each of UE1 and UE2 (Upper Egypt 1) and UE3 and UE4 (Upper Egypt 2). */
const MINYA_ASSIUT = "ك.ع.المنيا واسيوط";
/** Sohag: half to UE5, half to UE6, both Upper Egypt 2. */
const SOHAG = "ك.عملاء سوهاج";
/** A warehouse is never spread down to reps. */
const WAREHOUSE = "Assiut 2 Warehouse";

const repSeat = (area: string, region: string, occupant: string | null, extra: Partial<FieldForceSeatRow> = {}) => ({
  seat_id: `SEAT-AI-REP-${area}`,
  seat_tier: "REP",
  line_code: "anti_infective",
  line_name: AI,
  region_code: region,
  region_name: region === "UE-1" ? "Upper Egypt 1" : "Upper Egypt 2",
  area_code: area,
  area_name: AREA_ROWS.find((row) => row.area_code === area)?.area_name ?? area,
  occupant_hr_id: occupant,
  is_vacant: occupant === null,
  parent_seat_id: region === "UE-1" ? "SEAT-AI-DM-UE1" : "SEAT-AI-DM-UE2",
  ...extra,
});

const SEATS: FieldForceSeatRow[] = [
  { seat_id: "SEAT-AI-DM-UE1", seat_tier: "DM", line_code: "anti_infective", line_name: AI, region_code: "UE-1", occupant_hr_id: "A-901", is_vacant: false },
  { seat_id: "SEAT-AI-DM-UE2", seat_tier: "DM", line_code: "anti_infective", line_name: AI, region_code: "UE-2", occupant_hr_id: "A-902", is_vacant: false },
  repSeat("UE1", "UE-1", "A-101"),
  repSeat("UE2", "UE-1", "A-102"),
  repSeat("UE9", "UE-1", null),
  repSeat("UE3", "UE-2", "A-103"),
  repSeat("UE4", "UE-2", "A-104"),
  repSeat("UE5", "UE-2", "A-105"),
  repSeat("UE6", "UE-2", "A-106"),
  // A seat the organogram still spells with the rep's older HR id.
  repSeat("UE8", "UE-2", "LEGACY-105"),
  // Occupied on paper but flagged vacant: nobody may claim it.
  repSeat("UE7", "UE-2", "A-107", { is_vacant: true }),
  // The same person also seated on another line — never his on an Anti Infective screen.
  { ...repSeat("UE5", "UE", "A-105"), seat_id: "SEAT-CNS-REP-UE5", line_code: "cns", line_name: "CNS", parent_seat_id: null },
];

const NAMES: Record<string, string> = {
  "a-101": "Hany Lotfy",
  "a-102": "Mona Saber",
  "a-103": "Tarek Hassan",
  "a-104": "Dina Farouk",
  "a-105": "Samir Nabil",
  "a-106": "Rania Fawzy",
  "legacy-105": "Samir Nabil",
  "a-901": "Adel Mansour",
  "a-902": "Heba Ragab",
};
const INDEX = selectFieldForceSeats(SEATS, (hrId) => (hrId ? (NAMES[hrId] ?? null) : null));

const UE2_DM_SCOPE = {
  tier: "territory" as const,
  allowedLineNames: new Set([AI]),
  allowedRegionCodes: new Set(["UE-2"]),
  allowedAreaCodes: new Set(["UE3", "UE4", "UE5", "UE6", "UE7", "UE8"]),
  canViewHeadOffice: false,
};

/** A medical rep's scope carries his region and no area bound. */
const UE2_REP_SCOPE = {
  tier: "territory" as const,
  allowedLineNames: new Set([AI]),
  allowedRegionCodes: new Set(["UE-2"]),
  allowedAreaCodes: null,
  canViewHeadOffice: false,
};

/** A signed-in viewer. resolveWeeklyOwnAreaKeys reads only his HR id and his role. */
const viewer = (hrId: string, role: PhoenixRole = "Medical Rep"): AccessContext => ({
  hrId,
  role,
  scope: role === "Medical Rep" ? "self" : "team",
  source: "session",
});

function factRow(overrides: Partial<WeeklyFactExportRow>): WeeklyFactExportRow {
  return {
    distributorCode: "IBS",
    distributorName: "Ibn Sina",
    productCode: "AI01",
    productName: "Royafloxacin 500mg",
    line: AI,
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: null,
    branchCode: "BR",
    branchName: MINYA_ASSIUT,
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-01",
    batchId: "batch-1",
    family: "Royafloxacin",
    salesValue: 0,
    salesUnits: 0,
    stockUnits: 0,
    ...overrides,
  };
}

// What a lifted load hands back for one month: the viewer's own rows AND the rows his region bound
// used to hide.
const OWN_SOHAG = factRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: SOHAG, salesValue: 1000, salesUnits: 10 });
const UE_MINYA_ASSIUT = factRow({ salesValue: 4000, salesUnits: 40 });
const UE_PINNED_UE5 = factRow({ areaCode: "UE5", branchName: "Sohag hand-mapped", weekNumber: 2, salesValue: 700, salesUnits: 7 });
const UE_PINNED_UE1 = factRow({ areaCode: "UE1", branchName: "Minia hand-mapped", weekNumber: 2, salesValue: 300, salesUnits: 3 });
const UE_WAREHOUSE = factRow({ branchName: WAREHOUSE, weekNumber: 2, salesValue: 900, salesUnits: 9 });
const OWN_WAREHOUSE = factRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: WAREHOUSE, weekNumber: 2, salesValue: 250, salesUnits: 2 });
const UE_WEEK3_OTHER = factRow({ areaCode: "UE2", branchName: "Minia hand-mapped", weekNumber: 3, salesValue: 50, salesUnits: 1 });

const LIFTED_ROWS = [OWN_SOHAG, UE_MINYA_ASSIUT, UE_PINNED_UE5, UE_PINNED_UE1, UE_WAREHOUSE, OWN_WAREHOUSE, UE_WEEK3_OTHER];
/** The rows the region-bound load returned before the fix. */
const DM_BOUND_ROWS = [OWN_SOHAG, UE_PINNED_UE5, OWN_WAREHOUSE];

const byArea = (grid: PortalWeeklyFieldForce) =>
  Object.fromEntries(grid.reps.filter((rep) => rep.areaCode).map((rep) => [rep.areaCode as string, rep.value]));
const residue = (grid: PortalWeeklyFieldForce) =>
  grid.reps.filter((rep) => rep.kind === "unattributed").reduce((sum, rep) => sum + rep.value, 0);

function stockRow(overrides: Partial<WeeklyStockSourceRow>): WeeklyStockSourceRow {
  return {
    distributorCode: "IBS",
    distributorName: "Ibn Sina",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: null,
    branchCode: "BR",
    branchName: MINYA_ASSIUT,
    productCode: "AI01",
    productName: "Royafloxacin 500mg",
    line: AI,
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-01",
    netUnits: 12,
    stockUnits: 60,
    factoryPrice: 40,
    ...overrides,
  };
}

export async function runWeeklyOwnAreaLiftTests() {
  // ── 1. the Field Force grid of an Upper Egypt 2 district manager ───────────────────────────
  {
    const ownAreaKeys = weeklyScopeOwnAreaKeys(UE2_DM_SCOPE);
    const before = buildPortalWeeklyFieldForce({ rows: DM_BOUND_ROWS, areaSplit: SPLIT, seatIndex: INDEX });
    const after = buildPortalWeeklyFieldForce({
      rows: LIFTED_ROWS,
      areaSplit: SPLIT,
      seatIndex: INDEX,
      geography: weeklyFieldForceGeography(LIFTED_ROWS, UE2_DM_SCOPE, ownAreaKeys),
    });

    // HEADLINE — the "UE" Minia+Assiut depot pays his two Assiut reps their quarter each.
    assert.equal(byArea(after).UE3, 1000, "Assuit 1 receives its 25% of the UE-labelled depot the region bound used to hide");
    assert.equal(byArea(after).UE4, 1000, "Assuit 2 receives its 25% of the same depot");

    // HEADLINE — nothing from another district. The other half of that depot is Upper Egypt 1's.
    assert.equal(byArea(after).UE1, undefined, "Minia 1's share of a lifted row never reaches an Upper Egypt 2 grid");
    assert.equal(byArea(after).UE2, undefined, "nor Minia 2's — neither the split share nor its hand-mapped row");

    // HEADLINE — nothing he saw before is taken away or changed.
    assert.equal(byArea(after).UE5, 1200, "his own Sohag half (500) and the row pinned to his area (700) both stay whole");
    assert.equal(byArea(after).UE6, 500, "the other Sohag half is unchanged");
    assert.equal(residue(after), 250, "the residue of a row his own scope admits is still reported, never dropped");
    assert.equal(residue(after), residue(before), "and the lift adds no residue from rows he could not see");
    assert.equal(after.totals.unattributedValue, 250, "a lifted warehouse outside his scope is not his residue");
    for (const [area, value] of Object.entries(byArea(before))) {
      const gained = area === "UE3" || area === "UE4" ? 1000 : 0;
      assert.equal(byArea(after)[area], value + gained, `${area} gains exactly its own-area share and nothing else`);
    }
    assert.equal(after.totals.value, before.totals.value + 2000, "the lift adds exactly the two Assiut shares");

    const ue5 = after.reps.find((rep) => rep.areaCode === "UE5");
    assert.equal(ue5?.exactValue, 700, "a hand-mapped row stays EXACT after the lift");
    assert.equal(ue5?.allocatedValue, 500, "and a name-read share stays ALLOCATED");
    assert.equal(after.reps.find((rep) => rep.areaCode === "UE3")?.allocatedValue, 1000, "a lifted split share is an allocation");

    // A week is a column only where a row that counts for him carries it. Week 3 is carried by Minia 2's
    // hand-mapped row alone, which the narrowing drops, so it is not his column.
    assert.deepEqual(after.weekNumbers, [1, 2], "a week only another district's row carries is never a column on his grid");
    assert.deepEqual(after.weekNumbers, before.weekNumbers, "the lift adds no week his own rows and shares do not carry");
  }

  // ── 2. a medical rep's own seat (the month-pace strip) ─────────────────────────────────────
  {
    const repKeys = await resolveWeeklyOwnAreaKeys(viewer("A-105"), UE2_REP_SCOPE, INDEX.seats);
    const before = buildPortalWeeklyFieldForce({ rows: [OWN_SOHAG, OWN_WAREHOUSE], areaSplit: SPLIT, seatIndex: INDEX });
    const after = buildPortalWeeklyFieldForce({
      rows: LIFTED_ROWS,
      areaSplit: SPLIT,
      seatIndex: INDEX,
      geography: weeklyFieldForceGeography(LIFTED_ROWS, UE2_REP_SCOPE, repKeys),
    });
    assert.equal(byArea(before).UE5, 500, "region-bound, the Sohag 1 rep saw only his half of the UE-2 depot");
    assert.equal(byArea(after).UE5, 1200, "lifted, the UE-labelled row pinned to his own area reaches him too");
    assert.equal(byArea(after).UE3, undefined, "a lifted row's share in a colleague's area is not a rep's");
    assert.equal(byArea(after).UE4, undefined, "nor the other colleague's");
  }

  // ── 3. whose areas are whose ───────────────────────────────────────────────────────────────
  {
    const keys = weeklyScopeOwnAreaKeys(UE2_DM_SCOPE);
    assert.deepEqual(
      [...keys].sort(),
      ["UE3", "UE4", "UE5", "UE6", "UE7", "UE8"].map((area) => fieldForceKey(AI, area)),
      "a manager's own keys are his lines × his seat areas, keyed as the grid keys a seat",
    );
    assert.equal(mayLiftWeeklyGeography(UE2_DM_SCOPE, keys), true, "a region-bound manager with known areas lifts");
    assert.equal(
      weeklyScopeOwnAreaKeys({ ...UE2_DM_SCOPE, allowedLineNames: null }).size,
      0,
      "no line bound = no key to narrow by, so the load must not lift",
    );
    assert.equal(
      mayLiftWeeklyGeography({ ...UE2_DM_SCOPE, allowedRegionCodes: null }, keys),
      false,
      "a viewer with no region bound has nothing to lift",
    );
    assert.equal(mayLiftWeeklyGeography(UE2_REP_SCOPE, new Set()), false, "unknown own areas never lift");
    assert.equal(weeklyScopeOwnAreaKeys(UE2_REP_SCOPE).size, 0, "a rep's scope has no area bound — his keys come from his seats");
    const full: WeeklyAccessScope = { tier: "full", canViewRestricted: true, canViewHeadOffice: true };
    const product: WeeklyAccessScope = { tier: "product", productCodes: new Set(["AI01"]), canViewHeadOffice: false };
    assert.equal(mayLiftWeeklyGeography(full, keys), false, "a company-wide viewer never lifts");
    assert.equal(mayLiftWeeklyGeography(product, keys), false, "a product-scoped viewer never lifts");

    // A medical rep's keys are his own filled seats, picked by his own Weekly Sales screen's selector.
    const seats = INDEX.seats;
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-105"), UE2_REP_SCOPE, seats))],
      [fieldForceKey(AI, "UE5")],
      "a seat on a line outside his scope is never his — his CNS seat stays off an Anti Infective screen",
    );
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-105"), { ...UE2_REP_SCOPE, allowedLineNames: null }, seats))].sort(),
      [fieldForceKey("CNS", "UE5"), fieldForceKey(AI, "UE5")].sort(),
      "with no line bound every line he is seated on counts",
    );
    const [occupied] = selectFieldForceSeats([repSeat("UE7", "UE-2", "A-107")], () => null).seats;
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-107"), UE2_REP_SCOPE, [occupied]))],
      [fieldForceKey(AI, "UE7")],
      "an occupied seat is its occupant's",
    );
    assert.equal(
      (await resolveWeeklyOwnAreaKeys(viewer("A-107"), UE2_REP_SCOPE, [{ ...occupied, isVacant: true }])).size,
      0,
      "a seat flagged vacant is nobody's, even while it still names an occupant",
    );
    assert.equal((await resolveWeeklyOwnAreaKeys(viewer("Z-404"), UE2_REP_SCOPE, seats)).size, 0, "an unknown viewer owns nothing");
    assert.equal(
      (await resolveWeeklyOwnAreaKeys(viewer("A-105", "Regional Manager"), UE2_REP_SCOPE, seats)).size,
      0,
      "only a medical rep's own seats stand in for an area bound",
    );
    assert.deepEqual(
      [...(await resolveWeeklyOwnAreaKeys(viewer("A-902", "District Manager"), UE2_DM_SCOPE, seats))].sort(),
      [...keys].sort(),
      "a manager's own keys come from his seat's areas",
    );
    assert.equal(
      (await resolveWeeklyOwnAreaKeys(viewer("A-105"), { ...UE2_REP_SCOPE, allowedRegionCodes: null }, seats)).size,
      0,
      "with no region bound there is nothing to lift, so no own keys are resolved",
    );
    assert.equal((await resolveWeeklyOwnAreaKeys(viewer("A-105"), full, seats)).size, 0, "a company-wide viewer resolves no own keys");
  }

  // ── 4. the lift itself ─────────────────────────────────────────────────────────────────────
  {
    const lifted = liftWeeklyGeography(UE2_DM_SCOPE);
    assert.notEqual(lifted, UE2_DM_SCOPE, "a region-bound territory scope comes back lifted");
    assert.equal(lifted.tier === "territory" ? lifted.allowedRegionCodes : "not territory", null, "the region bound is gone");
    assert.equal(lifted.tier === "territory" ? lifted.allowedAreaCodes : "not territory", null, "the area bound is gone");
    assert.equal(
      lifted.tier === "territory" ? lifted.allowedLineNames : null,
      UE2_DM_SCOPE.allowedLineNames,
      "the LINE bound stays — a lift never reaches another line",
    );
    assert.equal(lifted.canViewHeadOffice, false, "and Head Office stays out");
    assert.equal(UE2_DM_SCOPE.allowedRegionCodes.size, 1, "the viewer's own scope is not mutated");
    const full: WeeklyAccessScope = { tier: "full", canViewRestricted: false, canViewHeadOffice: false };
    assert.equal(liftWeeklyGeography(full), full, "every other tier comes back as the same object");
    const unbound: WeeklyAccessScope = { ...UE2_DM_SCOPE, allowedRegionCodes: null, allowedAreaCodes: null };
    assert.equal(liftWeeklyGeography(unbound), unbound, "a scope with nothing to lift comes back as the same object");
  }

  // ── 5. Weekly Stock keeps a depot WHOLE when it serves one of his areas ────────────────────
  {
    const ownSohag = stockRow({ regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: SOHAG, branchCode: "S1" });
    const ueMinyaAssiut = stockRow({ branchCode: "M1" });
    const ueSohag = stockRow({ branchName: SOHAG, branchCode: "S2" });
    const uePinnedUe1 = stockRow({ areaCode: "UE1", branchName: "Minia hand-mapped", branchCode: "P1" });
    const ueWarehouse = stockRow({ branchName: WAREHOUSE, branchCode: "W1" });
    const rows = [ownSohag, ueMinyaAssiut, ueSohag, uePinnedUe1, ueWarehouse];

    const dm = admitWeeklyStockRows(rows, {
      bound: UE2_DM_SCOPE,
      ownAreaKeys: weeklyScopeOwnAreaKeys(UE2_DM_SCOPE),
      areaSplit: SPLIT,
    });
    // HEADLINE — the depots that stock his areas are on his screen, and no other.
    assert.deepEqual(dm, [ownSohag, ueMinyaAssiut, ueSohag], "his own depot, and the UE depots serving Assiut and Sohag");
    assert.equal(dm[1], ueMinyaAssiut, "the depot row itself, never a share of a shelf");
    assert.equal(dm[1].stockUnits, 60, "a shelf's stock is one stock — never cut by area");
    assert.ok(!dm.includes(uePinnedUe1), "a depot pinned to Upper Egypt 1 stays Upper Egypt 1's");
    assert.ok(!dm.includes(ueWarehouse), "a warehouse is never spread, so it reaches him only through his own scope");

    const rep = admitWeeklyStockRows(rows, {
      bound: UE2_REP_SCOPE,
      ownAreaKeys: await resolveWeeklyOwnAreaKeys(viewer("A-105"), UE2_REP_SCOPE, INDEX.seats),
      areaSplit: SPLIT,
    });
    assert.deepEqual(rep, [ownSohag, ueSohag], "the Sohag 1 rep gains the UE depot serving Sohag, not the Minia+Assiut one");
    assert.deepEqual(
      admitWeeklyStockRows(rows, { bound: UE2_REP_SCOPE, ownAreaKeys: new Set(), areaSplit: SPLIT }),
      [ownSohag],
      "with no own areas nothing beyond his own scope is admitted",
    );
  }

  // ── 5b. a lifted Weekly Stock load filters products after the narrowing ────────────────────
  {
    const rows = [{ productCode: "AI01" }, { productCode: " ai02 " }, { productCode: "AI03" }];
    const keep = (filters: Parameters<typeof weeklyStockProductPredicate>[0]) =>
      rows.filter(weeklyStockProductPredicate(filters)).map((row) => row.productCode.trim().toUpperCase());
    assert.deepEqual(
      keep({ productCodes: [" ai02", "AI03"] }),
      ["AI02", "AI03"],
      "include keeps only the chosen products, codes compared the way the load compares them",
    );
    assert.deepEqual(keep({ productCodes: ["AI02"], productFilterMode: "exclude" }), ["AI01", "AI03"], "exclude drops the chosen products");
    assert.deepEqual(keep({ productCodes: ["  "], productFilterMode: "include" }), ["AI01", "AI02", "AI03"], "no real code keeps everything");
    assert.deepEqual(keep({}), ["AI01", "AI02", "AI03"], "no filter keeps everything");

    const own = [{ code: "IBS", name: "Ibn Sina" }];
    assert.equal(
      withExtraWeeklyOptions(own, [{ code: " ibs ", name: "Ibn Sina Pharma" }]),
      own,
      "nothing new = the same list, untouched",
    );
    assert.deepEqual(
      withExtraWeeklyOptions(own, [
        { code: "ucp", name: "United Company" },
        { code: "UCP", name: "a second spelling" },
        { code: " ", name: "a row with no code" },
        { code: "ALX", name: "Alexandria Pharma" },
      ]),
      [
        { code: "ALX", name: "Alexandria Pharma" },
        { code: "IBS", name: "Ibn Sina" },
        { code: "UCP", name: "United Company" },
      ],
      "every code his narrowed depots carry is offered once, named from its first row, the whole list sorted by name",
    );
  }

  // ── 6. a lifted grid's upload-gap flags are per depot, over the money that counts for him ─────
  // Measured 2026-09-17 on Delta (3)'s Anti Infective August tab: Ibn Sina-Sato and Overseas sent no
  // week-2 sheet, while a POS return landed in one of her areas in week 2. Pooled over the lifted load,
  // every week looked uploaded, so week 3, which held two weeks of those two depots' sales, had no flag.
  {
    const sheet = (distributorCode: string, weekNumber: number, overrides: Partial<WeeklyFactExportRow> = {}) =>
      factRow({ distributorCode, weekNumber, weekStart: `2026-09-0${weekNumber}`, ...overrides });
    const ownSohag = { regionCode: "UE-2", regionName: "Upper Egypt 2", branchName: SOHAG };
    const rows = [
      // Ibn Sina-Sato and Overseas skipped week 2. Their UE Minia+Assiut books give each Assiut area a quarter.
      sheet("IS-S", 1, { salesValue: 4000, salesUnits: 40 }),
      sheet("IS-S", 3, { salesValue: 8000, salesUnits: 80 }),
      sheet("IS-S", 4, { salesValue: 4000, salesUnits: 40 }),
      sheet("PS", 1, { salesValue: 2000, salesUnits: 20 }),
      sheet("PS", 3, { salesValue: 2000, salesUnits: 20 }),
      // POS sent weeks 1 to 3. Its week 2 is a return, and a quarter of it lands in each Assiut area.
      sheet("POS", 1, { salesValue: 800, salesUnits: 8 }),
      sheet("POS", 2, { salesValue: -888, salesUnits: -8 }),
      sheet("POS", 3, { salesValue: 800, salesUnits: 8 }),
      // Ibn Sina's Sohag book is his own region's, admitted whole, and it skipped nothing.
      sheet("IBS", 1, { ...ownSohag, salesValue: 1000, salesUnits: 10 }),
      sheet("IBS", 2, { ...ownSohag, salesValue: 1000, salesUnits: 10 }),
      sheet("IBS", 3, { ...ownSohag, salesValue: 1000, salesUnits: 10 }),
      // EGD's first sheet of the month is week 5, so it holds weeks 1 to 5, but it reaches Minia 2 alone.
      sheet("EG", 5, { areaCode: "UE2", branchName: "Minia hand-mapped", salesValue: 500, salesUnits: 5 }),
    ];
    const ownAreaKeys = weeklyScopeOwnAreaKeys(UE2_DM_SCOPE);
    const grid = (loaded: WeeklyFactExportRow[]) =>
      buildPortalWeeklyFieldForce({
        rows: loaded,
        areaSplit: SPLIT,
        seatIndex: INDEX,
        depotWeekGaps: depotWeekGaps(loaded),
        geography: weeklyFieldForceGeography(loaded, UE2_DM_SCOPE, ownAreaKeys),
      });
    const flagsByArea = (built: PortalWeeklyFieldForce) =>
      Object.fromEntries(built.reps.filter((rep) => rep.areaCode).map((rep) => [rep.areaCode as string, rep.gapWeekNumbers]));

    assert.deepEqual(
      depotWeekGaps(rows).map((gap) => `${gap.distributorCode} week ${gap.weekNumber}`),
      ["EG week 5", "IS-S week 3", "PS week 3"],
      "fixture: three depot weeks span a gap",
    );
    const dm = grid(rows);

    // HEADLINE: week 3 is flagged, although POS's sheet means some depot sent every week before it.
    assert.deepEqual(dm.gapWeekNumbers, [3], "a week is flagged when a depot whose money counts for him skipped the week before");
    assert.equal(dm.reps.find((rep) => rep.areaCode === "UE3")?.valueByWeek[2], -222, "fixture: POS's return is money in his area in week 2");

    // HEADLINE: each row carries its own depots' flags, never the grid's.
    assert.deepEqual(
      flagsByArea(dm),
      { UE3: [3], UE4: [3], UE5: [], UE6: [] },
      "Assiut's week 3 holds the skipping depots' money; Sohag's depot skipped nothing, so Sohag is not flagged",
    );

    // HEADLINE: a week no counting row carries is not a column, and a gap there is not his.
    assert.deepEqual(dm.weekNumbers, [1, 2, 3, 4], "EGD's week 5 reaches only Minia 2, so it is no column on his grid");

    // A gapped depot row that moves no money cannot make a figure read high.
    const stockOnly = sheet("RM", 4, { ...ownSohag, stockUnits: 60 });
    assert.deepEqual(
      depotWeekGaps([...rows, stockOnly]).filter((gap) => gap.distributorCode === "RM").map((gap) => gap.weekNumber),
      [4],
      "fixture: ramco's first sheet of the month is week 4",
    );
    assert.deepEqual(grid([...rows, stockOnly]).gapWeekNumbers, [3], "a stock-only row from a gapped depot week flags nothing");

    // The same first sheet with sales in his areas holds weeks 1 to 4, and is flagged where it lands.
    const sold = grid([...rows, { ...stockOnly, salesValue: 600, salesUnits: 6 }]);
    assert.deepEqual(sold.gapWeekNumbers, [3, 4], "a depot's first sheet after week 1 is flagged once its money reaches him");
    assert.deepEqual(flagsByArea(sold), { UE3: [3], UE4: [3], UE5: [4], UE6: [4] }, "on the rows it reached, and no others");
  }

  // ── 7. the wiring — each surface loads lifted and narrows before a figure is built ─────────
  {
    const portal = readSource("../src/lib/sales/weekly/portal-weekly-dashboard.ts");
    const tab = functionBody(portal, "getPortalWeeklyDashboard");
    assert.match(tab, /liftRowGrainGeography:\s*liftGrain/, "the Field Force tab loads its row grain lifted");
    assert.match(tab, /mayLiftWeeklyGeography\(/, "only when there is a region bound to lift and own areas to narrow to");
    assert.match(tab, /geography:[\s\S]*?weeklyFieldForceGeography\(/, "and hands the narrowing to the grid");
    assert.match(tab, /factRowDepotWeekGaps:\s*_factRowDepotWeekGaps/, "the depot gap list never reaches the browser");
    assert.match(tab, /depotWeekGaps:\s*data\.factRowDepotWeekGaps \?\? \[\],/, "the grid is flagged per depot, lifted or not");

    const month = functionBody(portal, "getPortalWeeklyMonthFieldForce");
    assert.match(month, /resolveWeeklyOwnAreaKeys\(/, "the month grid resolves a medical rep's own seats");
    assert.match(month, /liftRowGrainGeography:\s*liftGrain/, "and loads lifted");
    assert.match(month, /geography:[\s\S]*?weeklyFieldForceGeography\(/, "and narrows");
    assert.match(month, /depotWeekGaps:\s*data\.factRowDepotWeekGaps \?\? \[\],/, "and flags per depot");
    assert.match(
      readSource("../src/lib/sales/weekly/portal-weekly-rep.ts"),
      /depotWeekGaps:\s*dashboard\.factRowDepotWeekGaps \?\? \[\],/,
      "a medical rep's line-wide grid is flagged per depot too",
    );
    assert.match(month, /excludeUnmapped:\s*true/, "owner rule: every weekly report leaves unmapped products out");

    const pace = readSource("../src/lib/sales/sos-month-pace-loader.ts");
    assert.match(pace, /getPortalWeeklyMonthFieldForce\(/, "the month-pace strip reads the lifted month grid");
    assert.doesNotMatch(pace, /getPortalWeeklyDashboard\(/, "never the region-bound dashboard again");

    const stock = readSource("../src/lib/sales/weekly/stock-dashboard-service.ts");
    const stockLoad = functionBody(stock, "loadWeeklyStockDashboard");
    assert.match(stockLoad, /liftRowGrainGeography:\s*liftGrain/, "Weekly Stock loads its depots lifted");
    assert.match(stockLoad, /admitWeeklyStockRows\(/, "and narrows them to the depots serving his own areas");
    assert.match(stockLoad, /buildWeeklyStockView\(stockRows,/, "before the view is built");
    assert.match(
      stockLoad,
      /productCodes:\s*productFilterInLoad \? filters\.productCodes : undefined/,
      "a lifted load does not filter products inside the load",
    );
    assert.match(
      stockLoad,
      /scopedStockRows\.filter\(weeklyStockProductPredicate\(filters\)\)/,
      "it filters them after the narrowing instead",
    );
    assert.match(
      stockLoad,
      /withExtraWeeklyOptions\(\s*scopedProducts,\s*scopedStockRows\.map/,
      "and reads the product list before that filter, so choosing one product never hides the others",
    );

    const service = readSource("../src/lib/sales/weekly/service.ts");
    assert.match(service, /factRows: filters\?\.includeFactRows\s*\?\s*grainWeekRowsAdj\.map/, "factRows come from the grain the caller asked for");
    assert.match(service, /stockRows: filters\?\.includeStockRows\s*\?\s*grainScopedRows\.map/, "and so do stockRows");
    assert.match(
      service,
      /const depotGaps = depotWeekGaps\(allRows\);[\s\S]*factRowDepotWeekGaps: filters\?\.includeFactRows \? depotGaps : undefined,/,
      "depot calendars are read over every loaded row, the set de-cumulation subtracted from, never a scoped grain",
    );
    assert.match(
      service,
      /applyWeeklyAccessScope\(realRows, grainScope\)[\s\S]{0,120}\.filter\(passesRowFilters\)/,
      "a lifted grain passes exactly the filters the viewer's own rows pass",
    );
  }
}
