import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveEmployeeIdentityId } from "../src/lib/auth/permissions.ts";
import { sharedIdentityKeys } from "../src/lib/auth/identity-aliases.ts";
import { resolveEmployeePortalNavVisibility } from "../src/lib/employee-portal/navigation.ts";
import { applyWeeklyTerritoryScope, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { isPortalWeeklyRole } from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import {
  buildPortalWeeklyFieldForce,
  selectFieldForceSeats,
  type FieldForceSeatRow,
} from "../src/lib/sales/weekly/portal-weekly-field-force.ts";
import {
  emptyRepWeeklySales,
  isPortalWeeklyRepRole,
  pickRepWeeklyMonth,
  repWeeklyLoadScope,
  repWeeklyMonthLabel,
  repWeeklyScopeIsEmpty,
  selectOwnRepSeats,
  selectRepWeeklySales,
} from "../src/lib/sales/weekly/portal-weekly-rep.ts";
import type { WeeklyDashboard, WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// Weekly Sales for a MEDICAL REP (owner, 2026-09-16: "in medical rep accounts show weekly sales").
//
// The rep's screen is built from the same line-wide field-force grid his managers read, then cut down
// to his own seat. Three things about that are load-bearing and none is visible when it breaks:
//
//   1. THE CUT IS THE PRIVACY BOUNDARY. The grid holds every rep on the line and the residue nobody
//      was credited with; the rep's payload must hold none of it — no other name, no other number.
//   2. HIS LOAD LIFTS GEOGRAPHY BUT KEEPS THE LINE. An Upper Egypt rep sits in UE-1 or UE-2 while the
//      depot rows still say "UE"; bounded by his region those rows never load and he reads a confident,
//      false zero. Lifting the line bound instead would load other lines' money.
//   3. THE MANAGERS' DASHBOARD, API AND EXPORT STILL REFUSE HIM. He reaches weekly figures through
//      this one path and no other.

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SEATS: FieldForceSeatRow[] = [
  {
    seat_id: "SEAT-AI-DM-UE1",
    seat_tier: "DM",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    occupant_hr_id: "D-300",
    is_vacant: false,
  },
  // The viewer. The org tree spells the line "Anti infective"; the weekly rows say "Anti Infective".
  {
    seat_id: "SEAT-AI-REP-UE3",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE3",
    area_name: "Minia 1",
    occupant_hr_id: "B-135",
    is_vacant: false,
    parent_seat_id: "SEAT-AI-DM-UE1",
  },
  // His second area on the same line, stored in another casing. It sells nothing in the fixture month.
  {
    seat_id: "SEAT-AI-REP-UE5",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE5",
    area_name: "Assuit 1",
    occupant_hr_id: "b-135",
    is_vacant: false,
    parent_seat_id: "SEAT-AI-DM-UE1",
  },
  // Another rep, same line, same region, same district manager — the person he must never see.
  {
    seat_id: "SEAT-AI-REP-UE4",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE4",
    area_name: "Minia 2",
    occupant_hr_id: "P-200",
    is_vacant: false,
    parent_seat_id: "SEAT-AI-DM-UE1",
  },
  {
    seat_id: "SEAT-AI-REP-UE6",
    seat_tier: "REP",
    line_code: "anti_infective",
    line_name: "Anti infective",
    region_code: "UE-1",
    region_name: "Upper Egypt 1",
    area_code: "UE6",
    area_name: "Beni Suef",
    occupant_hr_id: null,
    is_vacant: true,
    parent_seat_id: "SEAT-AI-DM-UE1",
  },
  // The same person holds a seat on a line his sales scope does not include.
  {
    seat_id: "SEAT-CNS-REP-AB1",
    seat_tier: "REP",
    line_code: "cns",
    line_name: "CNS",
    region_code: "AB",
    region_name: "Alex-BHR",
    area_code: "AB1",
    area_name: "Alex East",
    occupant_hr_id: "B-135",
    is_vacant: false,
  },
];

const NAMES: Record<string, string> = {
  "b-135": "Mahmoud Fathy",
  "p-200": "Nourhan Adel",
  "d-300": "Karim Selim",
};
const nameOf = (hrId: string | null) => (hrId ? (NAMES[hrId] ?? null) : null);

function factRow(overrides: Partial<WeeklyFactExportRow>): WeeklyFactExportRow {
  return {
    distributorCode: "POS",
    distributorName: "POS",
    productCode: "P1",
    productName: "Augmentin 1g",
    line: "Anti Infective",
    regionCode: "UE",
    regionName: "Upper Egypt",
    areaCode: null,
    branchCode: "BR1",
    branchName: "Minia Branch",
    cycleMonth: "2026-09-01",
    weekNumber: 1,
    weekStart: "2026-09-06",
    batchId: "batch-1",
    family: "Augmentin",
    salesValue: 0,
    salesUnits: 0,
    stockUnits: 0,
    ...overrides,
  };
}

const ROWS: WeeklyFactExportRow[] = [
  // His area.
  factRow({ areaCode: "UE3", weekNumber: 1, salesValue: 1000, salesUnits: 10 }),
  factRow({ areaCode: "UE3", weekNumber: 2, salesValue: 1500, salesUnits: 15 }),
  factRow({ areaCode: "UE3", productCode: "P2", productName: "Flagyl 500mg", family: "Flagyl", weekNumber: 2, salesValue: 500, salesUnits: 5 }),
  // Another rep's area, a vacant area, a depot that reached nobody, and his own seat on another line.
  factRow({ areaCode: "UE4", weekNumber: 1, salesValue: 98765, salesUnits: 987 }),
  factRow({ areaCode: "UE6", weekNumber: 3, salesValue: 33333, salesUnits: 333 }),
  factRow({ areaCode: null, branchName: "UE Key Accounts", weekNumber: 1, salesValue: 43210, salesUnits: 432 }),
  factRow({ line: "CNS", regionCode: "AB", areaCode: "AB1", productCode: "C9", productName: "Tegretol 200mg", weekNumber: 1, salesValue: 55555, salesUnits: 555 }),
];

type WeekEntry = WeeklyDashboard["weekComparison"][number];
const week = (cycleMonth: string, weekNumber: number, spansGap: boolean): WeekEntry => ({
  cycleMonth,
  weekNumber,
  weekStart: null,
  salesValue: spansGap ? null : 0,
  salesUnits: spansGap ? null : 0,
  stockUnits: 0,
  deltaValuePct: null,
  spansGap,
  depotSpansGap: spansGap,
});

const WEEKS: WeekEntry[] = [
  week("2026-09-01", 1, false),
  week("2026-09-01", 2, false),
  week("2026-09-01", 3, false),
  // Week 5 was uploaded after a missing week 4, and he sold nothing in it: still a column, but none of his
  // money is in it, so it cannot read high for him.
  week("2026-09-01", 5, true),
  // Another month's calendar must never leak into this one.
  week("2026-08-01", 4, true),
];

const SEPTEMBER = { code: "2026-09-01", name: "September 2026" };
const MONTHS = [SEPTEMBER, { code: "2026-08-01", name: "August 2026" }];
const ANTI_INFECTIVE_ONLY = new Set(["Anti Infective"]);

export function runWeeklySalesRepViewTests() {
  const index = selectFieldForceSeats(SEATS, nameOf);
  const viewerKeys = sharedIdentityKeys(resolveEmployeeIdentityId({ hrId: "B-135", loginId: null }));

  // ── 1. his own seats ───────────────────────────────────────────────────────────────────────
  const ownSeats = selectOwnRepSeats(index.seats, viewerKeys, ANTI_INFECTIVE_ONLY);
  assert.deepEqual(
    ownSeats.map((seat) => seat.areaName),
    ["Assuit 1", "Minia 1"],
    "the viewer's filled seats on his line are found in whatever casing the org tree stored his HR id, sorted by area name",
  );
  assert.deepEqual(
    selectOwnRepSeats(index.seats, viewerKeys, null).map((seat) => seat.areaName),
    ["Assuit 1", "Minia 1", "Alex East"],
    "with no line bound every seat he holds is his, grouped by line",
  );
  assert.deepEqual(
    selectOwnRepSeats(index.seats, viewerKeys, ANTI_INFECTIVE_ONLY).some((seat) => seat.areaCode === "AB1"),
    false,
    "a seat on a line his sales scope does not include is dropped — fail closed, as the rest of his scope does",
  );
  assert.deepEqual(
    selectOwnRepSeats(index.seats, viewerKeys, new Set()),
    [],
    "an EMPTY line bound (no line on his record) yields no seat at all, never every seat",
  );
  assert.deepEqual(
    selectOwnRepSeats(index.seats, sharedIdentityKeys("Z-404"), ANTI_INFECTIVE_ONLY),
    [],
    "a person who holds no seat gets none — never the vacant seat, never a neighbour's",
  );
  assert.deepEqual(
    selectOwnRepSeats(index.seats, new Set(), null),
    [],
    "a viewer with no resolvable HR id matches nothing, not the seats whose occupant is also blank",
  );
  // The one declared alias group: the Super Admin console account is the same human as B-10. A seat
  // stored under either id is that person's seat — the plumbing a rep with a re-issued id relies on.
  const aliasIndex = selectFieldForceSeats(
    [{ ...SEATS[1], seat_id: "SEAT-ALIAS", area_code: "UE9", area_name: "Qena 1", occupant_hr_id: "B-10" }],
    () => "Alias Holder",
  );
  assert.equal(
    selectOwnRepSeats(aliasIndex.seats, sharedIdentityKeys(resolveEmployeeIdentityId({ hrId: "PHX-1", loginId: null })), null)
      .length,
    1,
    "a seat stored under a person's canonical HR id is found when he signs in with a declared alias",
  );

  // ── 2. the privacy boundary ────────────────────────────────────────────────────────────────
  const fieldForce = buildPortalWeeklyFieldForce({ rows: ROWS, areaSplit: null, seatIndex: index });
  // The grid really does hold the neighbour, the vacancy and the residue — otherwise the cut below proves nothing.
  assert.ok(fieldForce.reps.some((rep) => rep.repName === "Nourhan Adel"), "fixture: the line-wide grid names the other rep");
  assert.ok(fieldForce.reps.some((rep) => rep.kind === "unattributed"), "fixture: the line-wide grid carries the residue bucket");
  assert.ok(fieldForce.reps.some((rep) => rep.kind === "vacant"), "fixture: the line-wide grid carries a vacant area");

  const mine = selectRepWeeklySales({
    fieldForce,
    ownSeats,
    month: SEPTEMBER,
    months: MONTHS,
    weekComparison: WEEKS,
  });
  const payload = JSON.stringify(mine);
  for (const leak of [
    "Nourhan Adel",
    "p-200",
    "Minia 2",
    "UE4",
    "98765",
    "Beni Suef",
    "33333",
    "Not attributed",
    "unattributed",
    "43210",
    "Alex East",
    "55555",
    "Tegretol",
    "Karim Selim",
    "b-135",
  ]) {
    assert.equal(
      payload.includes(leak),
      false,
      `the rep's payload never carries "${leak}" — no other rep, vacancy, residue, other line, manager or HR id`,
    );
  }
  assert.equal(mine.status, "ok");
  assert.equal(mine.repName, "Mahmoud Fathy", "his own name, from his own seat");
  assert.equal(mine.totals.value, 3000, "his month total is exactly his own rows");
  assert.deepEqual(mine.totals.valueByWeek, { 1: 1000, 2: 2000 }, "his week totals are exactly his own rows, in EGP");
  assert.equal(mine.totals.exactValue, 3000, "hand-mapped rows are reported as exact");
  assert.equal(mine.totals.allocatedValue, 0, "nothing was spread from a depot name, so nothing is labelled allocated");
  assert.equal("units" in mine.totals, false, "there is no unit total: units of different products are never added (owner rule)");
  assert.deepEqual(
    mine.products.map((product) => [product.productName, product.units, product.value]),
    [
      ["Augmentin 1g", 25, 2500],
      ["Flagyl 500mg", 5, 500],
    ],
    "units stay per product, ranked by value",
  );
  assert.deepEqual(mine.products[0].unitsByWeek, { 1: 10, 2: 15 }, "each product keeps its own week columns in units");

  // ── 3. every one of his seats is on screen, even one that sold nothing ───────────────────────
  assert.deepEqual(
    mine.areas.map((area) => [area.areaName, area.lineName, area.regionName, area.value]),
    [
      ["Assuit 1", "Anti Infective", "Upper Egypt 1", 0],
      ["Minia 1", "Anti Infective", "Upper Egypt 1", 3000],
    ],
    "a seat with no sales is a zero row labelled from HIS seat (canonical line name), not a missing one",
  );
  assert.deepEqual(mine.areas[0].valueByWeek, {}, "the empty seat carries no invented weeks");

  // ── 4. the week axis is the month's upload calendar; the flags are his own depots' ───────────
  assert.deepEqual(
    mine.weeks,
    [
      { weekNumber: 1, spansGap: false },
      { weekNumber: 2, spansGap: false },
      { weekNumber: 3, spansGap: false },
      { weekNumber: 5, spansGap: false },
    ],
    "weeks he sold nothing in stay as columns, another month's weeks never appear, and the line-wide gap flag is never copied",
  );

  // His loader flags the grid per depot. A week reads high for him only when a depot whose money
  // reached HIS seats skipped the week before; another rep's depot skipping a week says nothing about him.
  const gapRows: WeeklyFactExportRow[] = [
    ...ROWS,
    // Overseas skipped week 2, and its week 3 reached his area.
    factRow({ distributorCode: "PS", distributorName: "Overseas", areaCode: "UE3", weekNumber: 3, salesValue: 800, salesUnits: 8 }),
    // Ibn Sina-Sato's first sheet is week 2: it reached his neighbour with sales and him with stock only.
    factRow({ distributorCode: "IS-S", distributorName: "Ibn Sina-Sato", areaCode: "UE4", weekNumber: 2, salesValue: 400, salesUnits: 4 }),
    factRow({ distributorCode: "IS-S", distributorName: "Ibn Sina-Sato", areaCode: "UE3", weekNumber: 2, stockUnits: 30 }),
  ];
  const perDepot = buildPortalWeeklyFieldForce({
    rows: gapRows,
    areaSplit: null,
    seatIndex: index,
    depotWeekGaps: [
      { distributorCode: "IS-S", cycleMonth: "2026-09-01", weekNumber: 2 },
      { distributorCode: "PS", cycleMonth: "2026-09-01", weekNumber: 3 },
    ],
  });
  assert.deepEqual(perDepot.gapWeekNumbers, [2, 3], "fixture: the line-wide grid flags both weeks");
  const flaggedForHim = selectRepWeeklySales({ fieldForce: perDepot, ownSeats, month: SEPTEMBER, months: MONTHS, weekComparison: WEEKS });
  assert.deepEqual(
    flaggedForHim.weeks.filter((entry) => entry.spansGap).map((entry) => entry.weekNumber),
    [3],
    "his week 3 holds a skipping depot's money and is flagged; his week-2 money is all POS's, whatever his neighbour's depot skipped",
  );

  // ── 5. the same product across two of his areas is still one product ───────────────────────
  const twoAreas = selectRepWeeklySales({
    fieldForce: buildPortalWeeklyFieldForce({
      rows: [...ROWS, factRow({ areaCode: "UE5", weekNumber: 2, salesValue: 200, salesUnits: 2 })],
      areaSplit: null,
      seatIndex: index,
    }),
    ownSeats,
    month: SEPTEMBER,
    months: MONTHS,
    weekComparison: WEEKS,
  });
  assert.deepEqual(
    twoAreas.products.map((product) => [product.productCode, product.units, product.value]),
    [
      ["P1", 27, 2700],
      ["P2", 5, 500],
    ],
    "one product code across his areas merges into one row; different products never do",
  );
  assert.deepEqual(twoAreas.products[0].unitsByWeek, { 1: 10, 2: 17 }, "merged week columns add the same product only");
  assert.equal(twoAreas.totals.value, 3200, "the month total covers both of his areas");

  // ── 6. no seat, no numbers ─────────────────────────────────────────────────────────────────
  const noSeat = selectRepWeeklySales({ fieldForce, ownSeats: [], month: SEPTEMBER, months: MONTHS, weekComparison: WEEKS });
  assert.equal(noSeat.status, "no_seat", "a viewer with no seat is told so, never shown a zero month");
  assert.deepEqual([noSeat.areas, noSeat.products, noSeat.totals.value], [[], [], 0], "and receives nothing from the grid");
  assert.equal(JSON.stringify(noSeat).includes("Nourhan Adel"), false, "not even a neighbour's name");

  // ── 7. his load lifts geography and keeps the line ─────────────────────────────────────────
  const repScope: Extract<WeeklyAccessScope, { tier: "territory" }> = {
    tier: "territory",
    allowedLineNames: new Set(["Anti Infective"]),
    allowedRegionCodes: new Set(["UE-1"]),
    allowedAreaCodes: new Set(["UE3", "UE5"]),
    canViewHeadOffice: false,
  };
  const depotRows = [
    { officialLine: "Anti Infective", regionCode: "UE", areaCode: null },
    { officialLine: "CNS", regionCode: "UE", areaCode: null },
  ];
  assert.equal(
    applyWeeklyTerritoryScope(depotRows, repScope).length,
    0,
    "bounded by his region, the 'UE' depot row his share comes from never loads — the false zero this screen exists to avoid",
  );
  const lifted = repWeeklyLoadScope(repScope);
  assert.equal(lifted.tier, "territory");
  if (lifted.tier !== "territory") return;
  assert.equal(lifted.allowedRegionCodes, null, "the region bound is lifted for the load");
  assert.equal(lifted.allowedAreaCodes, null, "the area bound is lifted for the load");
  assert.deepEqual([...(lifted.allowedLineNames ?? [])], ["Anti Infective"], "the LINE bound is kept");
  assert.deepEqual(
    applyWeeklyTerritoryScope(depotRows, lifted).map((row) => row.officialLine),
    ["Anti Infective"],
    "the lifted load reads his line's depot rows and never another line's",
  );
  assert.ok(repScope.allowedRegionCodes?.has("UE-1"), "the caller's scope object is not mutated");
  const fullScope: WeeklyAccessScope = { tier: "full", canViewRestricted: false, canViewHeadOffice: false };
  assert.equal(repWeeklyLoadScope(fullScope), fullScope, "a scope with no geography passes through untouched");

  // ── 8. a scope that can read nothing is refused before anything loads ───────────────────────
  assert.equal(repWeeklyScopeIsEmpty({ tier: "none", canViewHeadOffice: false }), true, "the none tier is empty");
  assert.equal(
    repWeeklyScopeIsEmpty({ ...repScope, allowedLineNames: new Set() }),
    true,
    "a territory scope with an empty line set is empty (no line on his employee record)",
  );
  assert.equal(
    repWeeklyScopeIsEmpty({ tier: "product", productCodes: new Set(), canViewHeadOffice: false }),
    true,
    "a product scope with no products is empty",
  );
  assert.equal(repWeeklyScopeIsEmpty(repScope), false, "a rep with a line is not empty");
  assert.equal(repWeeklyScopeIsEmpty(fullScope), false, "full access is not empty");

  // ── 9. months ──────────────────────────────────────────────────────────────────────────────
  assert.equal(pickRepWeeklyMonth("2026-08-01", MONTHS)?.name, "August 2026", "a requested month that exists is honoured");
  assert.equal(pickRepWeeklyMonth(" 2026-08-01 ", MONTHS)?.code, "2026-08-01", "the request is trimmed");
  assert.equal(pickRepWeeklyMonth("2031-01-01", MONTHS)?.code, "2026-09-01", "an unknown month falls back to the newest");
  assert.equal(pickRepWeeklyMonth(null, MONTHS)?.code, "2026-09-01", "no request means the newest month");
  assert.equal(pickRepWeeklyMonth("2026-09-01", []), null, "no validated upload means no month");
  assert.equal(repWeeklyMonthLabel("2026-09-01"), "September 2026", "a month reads as a name, never a code");
  assert.equal(repWeeklyMonthLabel("2026-01-01"), "January 2026");
  const noData = emptyRepWeeklySales("no_data", { repName: "Mahmoud Fathy" });
  assert.deepEqual(
    [noData.status, noData.repName, noData.weeks, noData.products, noData.totals.value, noData.allocationUnavailable],
    ["no_data", "Mahmoud Fathy", [], [], 0, false],
    "an empty state carries no figures",
  );

  // ── 10. the gates ──────────────────────────────────────────────────────────────────────────
  assert.equal(isPortalWeeklyRepRole("Medical Rep"), true, "a Medical Rep gets his own Weekly Sales screen");
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "Marketing Manager", "Employee", "CEO"] as const) {
    assert.equal(isPortalWeeklyRepRole(role), false, `${role} does not get the rep's screen`);
  }
  assert.equal(isPortalWeeklyRole("Medical Rep"), false, "the managers' dashboard role list still refuses a rep");
  for (const route of [
    "../app/api/employee-portals/weekly-sales/route.ts",
    "../app/api/employee-portals/weekly-sales/export/route.ts",
  ]) {
    const source = readSource(route);
    assert.match(
      source,
      /if \(!mayReadManagersWeeklySales\(access\.role\)\)/,
      `${route} still gates on the managers' role list`,
    );
    assert.doesNotMatch(source, /portal-weekly-rep|isPortalWeeklyRepRole/, `${route} has no rep path — no region-level data or export for a rep`);
  }
  const page = readSource("../app/employee-portals/weekly-sales/page.tsx");
  const repBranch = page.indexOf("if (isRep) {");
  const managerFilters = page.indexOf("const filters = parseFilters(params);");
  assert.ok(repBranch > 0 && managerFilters > repBranch, "the page returns a rep's own screen before the managers' filters are ever built");
  const repPath = page.slice(repBranch, managerFilters);
  assert.match(repPath, /<PortalWeeklyRepContent /, "a rep is rendered his own screen");
  assert.doesNotMatch(repPath, /<PortalWeeklyContent |getPortalWeeklyDashboard/, "a rep never reaches the managers' dashboard");
  assert.match(
    page,
    /if \(!isRep && !isPortalWeeklyRole\(access\.role\)\) \{\s*redirect\(/,
    "every other role outside the managers' list is still sent away",
  );

  const view = readSource("../src/components/sales/weekly/portal-weekly-rep-view.tsx");
  assert.match(
    view,
    /import type \{[^}]*\} from "@\/lib\/sales\/weekly\/portal-weekly-rep";/,
    "the client screen imports only TYPES from the loader, so no server code reaches the browser bundle",
  );
  assert.doesNotMatch(view, /\brounded\b|\brounded-/, "square edges (owner golden rule)");
  assert.doesNotMatch(view, /\btruncate\b|text-ellipsis/, "no ellipsis truncation (owner rule)");
  assert.doesNotMatch(view, /overflow-x-auto|min-w-\[/, "no horizontal scroll and no width floor (owner golden rule)");

  const nav = (role: string) => resolveEmployeePortalNavVisibility(role, role);
  assert.equal(nav("Medical Rep").showWeeklyTab, true, "the Medical Rep sidebar shows Weekly Sales");
  assert.equal(nav("Employee").showWeeklyTab, false, "a plain employee still does not");
  assert.match(
    readSource("../src/config/system-navigation.ts"),
    /href: "\/employee-portals\/weekly-sales"[^\n]*roles: \[[^\]]*"Medical Rep"/,
    "the portal catalog lists Medical Rep for Weekly Sales, in step with the nav flag",
  );
}
