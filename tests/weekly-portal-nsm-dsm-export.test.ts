import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";

import { buildNsmDsmWorkbook } from "../src/lib/sales/weekly/nsm-dsm-workbook.ts";
import type { WeeklyManagerIndex } from "../src/lib/sales/weekly/manager-attribution.ts";
import {
  PORTAL_NSM_DSM_MAX_MONTHS,
  cairoCycleMonthNow,
  isPortalNsmDsmCycleMonth,
  portalNsmDsmExportMonths,
} from "../src/lib/sales/weekly/nsm-dsm-export-months.ts";
import {
  PORTAL_NSM_DSM_EXPORT_ROLES,
  PORTAL_WEEKLY_ROLES,
  mayDownloadPortalNsmDsmExport,
} from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import {
  portalNsmDsmPeriodLabel,
  portalNsmDsmViewerSeat,
} from "../src/lib/sales/weekly/portal-nsm-dsm-export.ts";
import type { WeeklyFactExportRow } from "../src/lib/sales/weekly/types.ts";

// The NSM/DSM workbook, downloaded from the PORTAL by the manager it is about (owner, 2026-10-17:
// "make national sales managers and regional managers able to download the dsm-nsm weekly sales,
// only their scope, they only choose the month in their weekly sales dashboard").
//
// Four claims here, and none of them is about layout:
//   1. WHO. The two seats he named, plus the two accounts that already hold the admin button.
//   2. ONE INPUT. The route reads `month` and nothing else, so no filter on the screen can narrow
//      the book behind the reader's back or collapse its week grid to a single column.
//   3. HIS OWN SCOPE. The builder loads through the access scope AND the own-area narrowing, with
//      excludeUnmapped set, so the book reconciles to the screen he downloaded it from.
//   4. HIS OWN NAME. A regional manager's book is headed by HIS seat. Before `viewerSeat` existed
//      the builder could only count regions, and a regional manager spans several — so his book was
//      headed with the NATIONAL manager's name.

const sourceOf = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");

/**
 * The same text with its `//` comments blanked, for the one assertion below that must say a call is
 * ABSENT. The builder's own comment explains why it does not narrow the fetch, and a bare
 * `doesNotMatch` over the raw source is satisfied — or in that direction, DEFEATED — by the
 * explanation rather than by the code. Line comments only: the file carries no `/*` and a
 * block-comment regex has eaten the declarations it was checking here before.
 */
const withoutLineComments = (source: string) => source.replace(/\/\/[^\r\n]*/g, "");

// ── the fixture: a Greater Cairo DM reporting to a named RSM, who reports to a named NSM ──────────
//
// `resolveWeeklyManager` reads rsmName and nsmName by climbing parent_seat_id from the DM seat, so
// the chain has to be real for the masthead assertions below to mean anything.
const MANAGER_INDEX: WeeklyManagerIndex = {
  ceoName: "The CEO",
  dmByLineRegion: new Map([
    [
      "cns||GC",
      {
        seatId: "SEAT-DM-GC",
        seatTier: "DM",
        lineCode: "cns",
        regionCode: "GC",
        seatLabel: "CNS Greater Cairo",
        occupantHrId: "HR-DM",
        isVacant: false,
        parentSeatId: "SEAT-RSM",
      },
    ],
  ]),
  nameByHrId: new Map([
    ["HR-DM", "Dalia The District Manager"],
    ["HR-RSM", "Rania The Regional Manager"],
    ["HR-NSM", "Nader The National Manager"],
  ]),
  operationalRegionByLineArea: new Map(),
  regionNameByCode: new Map([["GC", "Greater Cairo"], ["DL", "Delta"]]),
  seatsById: new Map([
    [
      "SEAT-RSM",
      {
        seatId: "SEAT-RSM",
        seatTier: "RSM",
        lineCode: "cns",
        regionCode: null,
        seatLabel: "CNS Regional",
        occupantHrId: "HR-RSM",
        isVacant: false,
        parentSeatId: "SEAT-NSM",
      },
    ],
    [
      "SEAT-NSM",
      {
        seatId: "SEAT-NSM",
        seatTier: "NSM",
        lineCode: "cns",
        regionCode: null,
        seatLabel: "CNS National",
        occupantHrId: "HR-NSM",
        isVacant: false,
        parentSeatId: null,
      },
    ],
  ]),
};

function row(overrides: Partial<WeeklyFactExportRow> = {}): WeeklyFactExportRow {
  return {
    areaCode: "C11",
    batchId: "b1",
    branchCode: "BR1",
    branchName: "Cairo Depot",
    cycleMonth: "2026-10",
    distributorCode: "IS",
    distributorName: "Ibn Sina-Sato",
    family: "Tebofortin",
    line: "CNS",
    productCode: "TEB80",
    productName: "Tebofortin 80mg",
    regionCode: "GC",
    regionName: "Greater Cairo",
    salesUnits: 100,
    salesValue: 30_000,
    stockUnits: 10,
    weekNumber: 1,
    weekStart: "2026-10-04",
    ...overrides,
  };
}

/** Two regions, so the builder's own region-count rule reads "all regions" without a viewerSeat. */
const TWO_REGION_ROWS: WeeklyFactExportRow[] = [
  row(),
  row({ areaCode: "D21", branchCode: "BR3", branchName: "Gharbia Depot", regionCode: "DL", regionName: "Delta", weekNumber: 2 }),
];

/** The masthead strip — row 1, column 1 of the first sheet, where the scope line is printed. */
async function masthead(viewerSeat: "nsm" | "rsm" | undefined): Promise<string> {
  const buffer = await buildNsmDsmWorkbook({
    areaNames: new Map([["C11", "Cairo 1"], ["D21", "Gharbia 2"]]),
    areaSplit: null,
    generatedAt: "2026-10-17T09:00:00.000Z",
    lineFilter: ["CNS"],
    managerIndex: MANAGER_INDEX,
    periodLabel: "October 2026",
    productAxis: ["TEB80"],
    regionFilter: [],
    regionNames: new Map([["GC", "Greater Cairo"], ["DL", "Delta"]]),
    rows: TWO_REGION_ROWS,
    viewerSeat,
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  assert.ok(sheet, "the workbook must have a sheet before its masthead can be read");
  return String(sheet.getCell(1, 1).value ?? "");
}

export async function runWeeklyPortalNsmDsmExportTests() {
  // ── 1. WHO may take it ──────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    [...PORTAL_NSM_DSM_EXPORT_ROLES],
    ["National Sales Manager", "Regional Manager"],
    "the owner named two seats on 2026-10-17 — a wider list is a decision, not a tidy-up",
  );
  for (const role of ["National Sales Manager", "Regional Manager", "CEO", "Super Admin"] as const) {
    assert.equal(mayDownloadPortalNsmDsmExport(role), true, `${role} may take the NSM/DSM workbook from the portal`);
  }
  for (const role of [
    "District Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "Medical Rep",
    "Employee",
  ] as const) {
    assert.equal(mayDownloadPortalNsmDsmExport(role), false, `${role} is refused the NSM/DSM workbook`);
  }
  // NARROWER than the page's own role list, deliberately: everyone on that list opens the dashboard.
  assert.ok(
    PORTAL_WEEKLY_ROLES.some((role) => !mayDownloadPortalNsmDsmExport(role)),
    "the download list must be narrower than the dashboard's — otherwise the gate below is decoration",
  );

  // The seat that names the masthead, which is the only thing telling an RSM's book from an NSM's.
  assert.equal(portalNsmDsmViewerSeat("National Sales Manager"), "nsm");
  assert.equal(portalNsmDsmViewerSeat("Regional Manager"), "rsm");
  assert.equal(
    portalNsmDsmViewerSeat("Super Admin"),
    undefined,
    "a company viewer is reading somebody else's scope, so the builder's own rule stands",
  );

  // ── 2. ONE INPUT — the month ─────────────────────────────────────────────────────────────────────
  const route = sourceOf("app/api/employee-portals/weekly-sales/nsm-dsm-export/route.ts");
  assert.match(
    route,
    /await assertPermission\(access,\s*"sales",\s*"read"\)/,
    "the route asserts the sales read permission, as every portal weekly route does",
  );
  assert.match(
    route,
    /if \(!mayDownloadPortalNsmDsmExport\(access\.role\)\)/,
    "and re-asks the role question rather than trusting the flag the page rendered the button from",
  );
  assert.match(
    route,
    /scope: "export:sales:weekly-portal-nsm-dsm"/,
    "its own rate-limit scope, so this book cannot spend a sibling download's budget",
  );
  const searchParamReads = route.match(/searchParams[\s\S]{0,40}?get\("([a-zA-Z]+)"\)/g) ?? [];
  assert.deepEqual(
    searchParamReads.map((hit) => /get\("([a-zA-Z]+)"\)/.exec(hit)?.[1]),
    ["month"],
    "the month is the ONLY query input: a week or region filter reaching this book is the defect",
  );

  // Declared in the access registry, or the required `validate` job goes red on the route's existence.
  assert.match(
    sourceOf("src/lib/security/access-registry.ts"),
    /pattern: "\/api\/employee-portals\/weekly-sales\/nsm-dsm-export"/,
    "every app/api route needs an access-registry declaration",
  );

  // ── 3. HIS OWN SCOPE ────────────────────────────────────────────────────────────────────────────
  const builder = sourceOf("src/lib/sales/weekly/portal-nsm-dsm-export.ts");
  assert.match(builder, /resolveWeeklyAccessScope\(ctx\)/, "the rows are read under the viewer's own access scope");
  assert.match(
    builder,
    /ownAreaShare:? ?[\s\S]{0,200}mayLiftWeeklyGeography/,
    "and through the own-area narrowing, so money placed in another manager's area leaves (owner, 2026-09-17)",
  );
  assert.match(builder, /excludeUnmapped: true/, "every weekly report and export excludes unmapped products");
  assert.match(builder, /allWeeks: true/, "every week of the chosen month, so the weeks add to the month beside them");
  assert.doesNotMatch(
    withoutLineComments(builder),
    /narrowRowsToCycleMonths/,
    "narrowing the fetch would cut the product AXIS down to one month's products, and the axis is what " +
      "makes column three the same product in his book and in the national one",
  );
  assert.match(builder, /regionFilter: \[\]/, "he asked for a month, not a region");
  assert.match(
    builder,
    /Forbidden: /,
    'a viewer with no weekly scope is refused with the "Forbidden:" prefix every weekly route turns into a 403',
  );

  // The period label, which is what the masthead's big date is built from.
  assert.equal(portalNsmDsmPeriodLabel("2026-10-01"), "October 2026");
  assert.equal(portalNsmDsmPeriodLabel("2026-01-01"), "January 2026");
  assert.equal(portalNsmDsmPeriodLabel("whatever"), "whatever", "an unparseable code is never dressed up as a month");

  // ── 4. HIS OWN NAME on the masthead ─────────────────────────────────────────────────────────────
  const rsmStrip = await masthead("rsm");
  assert.ok(
    rsmStrip.includes("Rania The Regional Manager") && rsmStrip.includes("Regional Sales Manager"),
    `a regional manager's book names HIM, not the manager above him — got: ${rsmStrip}`,
  );
  assert.ok(
    !rsmStrip.includes("National Sales Manager"),
    `and never the national manager over his own numbers — got: ${rsmStrip}`,
  );
  assert.ok(
    rsmStrip.includes("Greater Cairo") && rsmStrip.includes("Delta"),
    `his coverage is named region by region rather than as "all regions" — got: ${rsmStrip}`,
  );

  const nsmStrip = await masthead("nsm");
  assert.ok(
    nsmStrip.includes("Nader The National Manager") && nsmStrip.includes("National Sales Manager, all regions"),
    `a national manager's book names him over all regions — got: ${nsmStrip}`,
  );

  // The ADMIN export passes no viewerSeat, and its masthead must be exactly what it was: these same
  // rows span two regions, so the region-count rule names the national manager. A change here is a
  // change to the locked book the owner reviewed on 2026-08-30.
  const adminStrip = await masthead(undefined);
  assert.ok(
    adminStrip.includes("National Sales Manager, all regions"),
    `the admin book's own rule is untouched — got: ${adminStrip}`,
  );

  // ── the control that offers it ──────────────────────────────────────────────────────────────────
  const view = sourceOf("src/components/sales/weekly/portal-weekly-dashboard-impl.tsx");
  assert.match(
    view,
    /scope\.canDownloadNsmDsmExport && monthOptions\.length > 0/,
    "the control is gated on the server's own answer, and needs a month to offer",
  );
  assert.match(
    view,
    /new URLSearchParams\(\{ month \}\)/,
    "and sends the month alone — buildQuery()'s filters must never reach this book",
  );
  assert.match(
    view,
    /selected: selection\.months/,
    "the months come from the page's own Month filter (owner, 2026-10-18: the export ignored it and sent November)",
  );
  assert.doesNotMatch(
    withoutLineComments(view),
    /nsmDsmMonth\b|nsm-dsm-month/,
    "no separate month box beside the button — a second month control is what exported a different month from the filter",
  );

  // ── the months it exports follow the Month filter ───────────────────────────────────────────────
  // November here is real: Finance booked one approved Direct order (Lacto Advanced) to November 2026,
  // so it is offered as the newest month while the sheets everyone else uploads stop in October.
  const AVAILABLE = ["2026-11-01", "2026-10-01", "2026-09-01", "2026-08-01"];
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, mode: "include", selected: ["2026-10-01"] }),
    ["2026-10-01"],
    "October picked → October, never the newest month",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, mode: "include", selected: ["2026-10-01", "2026-09-01"] }),
    ["2026-09-01", "2026-10-01"],
    "September and October picked → both, one workbook each, oldest first",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, mode: "exclude", selected: ["2026-11-01", "2026-08-01"] }),
    ["2026-09-01", "2026-10-01"],
    "an excluding filter exports every month it leaves in",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, currentMonth: "2026-10-01", mode: "include", selected: [] }),
    ["2026-10-01"],
    "nothing picked → the month Cairo is in, never a month Finance booked ahead",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, currentMonth: "2026-12-01", mode: "include", selected: [] }),
    ["2026-11-01"],
    "and when the current month is not offered, the newest offered month before it",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: ["2026-11-01"], currentMonth: "2026-10-01", mode: "include", selected: [] }),
    ["2026-11-01"],
    "when every offered month is ahead, the newest one is used rather than nothing",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, mode: "include", selected: [] }),
    ["2026-11-01"],
    "with no current month supplied the newest offered month is used",
  );
  assert.equal(cairoCycleMonthNow(new Date("2026-10-31T21:30:00Z")), "2026-10-01", "23:30 on 31 October in Cairo is still October");
  assert.equal(cairoCycleMonthNow(new Date("2026-10-31T22:30:00Z")), "2026-11-01", "00:30 on 1 November in Cairo is November");
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, mode: "exclude", selected: AVAILABLE }),
    [],
    "a filter that excludes every month leaves nothing to export",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: [], mode: "include", selected: [] }),
    [],
    "no months at all → no month, never an invented one",
  );
  assert.deepEqual(
    portalNsmDsmExportMonths({ available: AVAILABLE, mode: "include", selected: ["October 2026"] }),
    ["2026-11-01"],
    "a label that is not a cycle month is ignored, never sent to the route",
  );
  assert.equal(isPortalNsmDsmCycleMonth("2026-10-01"), true);
  assert.equal(isPortalNsmDsmCycleMonth("2026-10"), false, "the route takes the stored first-of-month shape only");
  assert.equal(isPortalNsmDsmCycleMonth("October 2026"), false);
  assert.ok(PORTAL_NSM_DSM_MAX_MONTHS <= 10, "each month is a download and the route allows ten a minute");
  assert.match(
    route,
    /!isPortalNsmDsmCycleMonth\(month\)[\s\S]{0,200}status: 400/,
    "a month that is named but unreadable is refused with 400 — it used to fall back to the latest and export November",
  );
  assert.match(
    sourceOf("src/lib/sales/weekly/portal-weekly-dashboard.ts"),
    /canDownloadNsmDsmExport: mayDownloadPortalNsmDsmExport\(scope\.role\)/,
    "the flag is decided on the server from the same predicate the route enforces",
  );
}
