import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DIRECT_ORDER_REPORT_STATUS_OPTIONS,
  describeDirectOrderReportFilters,
  filterDirectOrderReportRows,
  parseDirectOrderReportFilters,
} from "../src/lib/direct-orders/report-filters.ts";
import type { DirectOrderReportRow } from "../src/lib/direct-orders/types.ts";
import type { CompanyVacationReportRow } from "../src/lib/vacation/company-vacation-report.ts";
import {
  companyVacationReportFilterParams,
  describeCompanyVacationReportFilters,
  filterCompanyVacationReportRows,
  parseCompanyVacationReportFilters,
  NO_COMPANY_VACATION_REPORT_FILTERS,
} from "../src/lib/vacation/company-vacation-report-filters.ts";

const directOrdersExportRouteSource = readFileSync(
  new URL("../app/api/direct-orders/report/export/route.ts", import.meta.url),
  "utf8",
);
const vacationExportRouteSource = readFileSync(
  new URL("../app/api/vacation/company-report/export/route.ts", import.meta.url),
  "utf8",
);
const directOrdersWorkspaceSource = readFileSync(
  new URL("../src/components/direct-orders/direct-order-report-workspace.tsx", import.meta.url),
  "utf8",
);
const directOrdersPortalSource = readFileSync(
  new URL("../src/components/employee-portal/direct-order-portal-report.tsx", import.meta.url),
  "utf8",
);
const vacationTableSource = readFileSync(
  new URL("../src/components/vacation/company-vacation-report-table.tsx", import.meta.url),
  "utf8",
);

function directOrder(overrides: Partial<DirectOrderReportRow> & { id: string }): DirectOrderReportRow {
  return {
    activeStepLabel: "Regional Manager",
    activeStepOrder: 1,
    areaCode: "A-01",
    areaName: "Nasr City",
    heldAt: null,
    bonus: 0,
    bonusOverrideReason: null,
    brickId: "B-01",
    brickName: "Nasr City East",
    collectionDate: null,
    createdAt: "2026-07-01T09:00:00.000Z",
    dealType: "bonus",
    decidedAt: null,
    discountPct: null,
    distributorCodesText: "Ibn Sina: 0000000123",
    doctorName: "Dr. Sameh",
    line: "Pedia",
    marketingRequestId: null,
    paidAmount: 0,
    paymentDate: null,
    pharmacyAddress: "1 Test Street",
    pharmacyCode: "PH-1",
    pharmacyName: "Test Pharmacy",
    pharmacyPriceSnapshot: 120,
    productCode: "P-1",
    productName: "Test Product",
    publicPriceSnapshot: null,
    qty: 10,
    regionCode: "R-01",
    regionName: "Cairo",
    remainingAmount: 0,
    requesterHrId: "HR-100",
    requesterName: "Mona Adel",
    requesterRole: "District Manager",
    reversalOfRequestId: null,
    reversedByRequestId: null,
    salesMonth: null,
    salesValue: 1200,
    sosBatchId: null,
    status: "pending_approval",
    ...overrides,
  };
}

function vacationRow(overrides: Partial<CompanyVacationReportRow> & { hrId: string }): CompanyVacationReportRow {
  return {
    balanceAfterDays: null,
    balanceBeforeDays: null,
    dayPart: null,
    detail: "Annual leave",
    employeeName: "Mona Adel",
    endDate: "2026-03-10",
    hasBalance: null,
    jobTitle: "Medical Rep",
    lineName: "Pedia",
    requestId: null,
    source: "HR Approved",
    startDate: "2026-03-10",
    workingDays: 1,
    ...overrides,
  };
}

export function runExportFollowsScreenFiltersTests() {
  // ── Direct Orders: the file must answer the same question as the KPI cards ────────────────
  //
  // The export re-loads its rows server-side, so the ONLY thing keeping the workbook equal to
  // the Rows / Pending / Total value / Approved value cards is both sides running this filter.
  const directOrders = [
    directOrder({ id: "d1", salesValue: 1000, status: "approved" }),
    directOrder({ id: "d2", salesValue: 2000, status: "approved" }),
    directOrder({ id: "d3", salesValue: 400, status: "pending_approval" }),
    directOrder({ id: "d4", salesValue: 700, status: "rejected", requesterName: "Karim Fouad" }),
  ];

  const approvedOnly = filterDirectOrderReportRows(directOrders, { search: "", statuses: ["approved"] });
  assert.deepEqual(
    approvedOnly.map((row) => row.id),
    ["d1", "d2"],
    "a status chip must narrow the exported population, not just the screen",
  );
  assert.equal(
    approvedOnly.reduce((sum, row) => sum + row.salesValue, 0),
    3000,
    "Total value in the file must equal the KPI card's total over the same filtered rows (3000, not the unfiltered 4100)",
  );
  assert.equal(
    filterDirectOrderReportRows(directOrders, { search: "", statuses: [] }).length,
    4,
    "no status chip selected still means every row — an empty filter must never narrow",
  );

  const searched = filterDirectOrderReportRows(directOrders, { search: "karim", statuses: [] });
  assert.deepEqual(
    searched.map((row) => row.id),
    ["d4"],
    "the search box matches the requester name case-insensitively, and the export honours it",
  );
  assert.equal(
    filterDirectOrderReportRows(directOrders, { search: "karim", statuses: ["approved"] }).length,
    0,
    "search and status compose (AND), so a contradictory pair exports nothing rather than everything",
  );

  // A status that is not a real one must match NO row. Dropping it instead would widen a
  // tampered export past what the requester could see on screen.
  const unknownStatus = parseDirectOrderReportFilters({ search: "", statuses: ["not_a_status"] });
  assert.deepEqual(unknownStatus.statuses, ["not_a_status"], "an unrecognised status is kept, never discarded");
  assert.equal(
    filterDirectOrderReportRows(directOrders, unknownStatus).length,
    0,
    "an unrecognised status narrows to nothing — the safe direction, since discarding it would export every row",
  );

  const parsedGarbage = parseDirectOrderReportFilters({ search: 42, statuses: "approved" });
  assert.deepEqual(
    parsedGarbage,
    { search: "", statuses: [] },
    "a malformed body degrades to 'no filter' rather than throwing, so Export never fails on a bad request shape",
  );
  assert.deepEqual(
    parseDirectOrderReportFilters(undefined),
    { search: "", statuses: [] },
    "an absent body is the unfiltered export the button used to always send",
  );

  // The cover stamp names statuses the way the chips do — the standing rule is human-readable
  // names, never raw codes.
  assert.equal(
    describeDirectOrderReportFilters({ search: "", statuses: [] }),
    null,
    "an unfiltered export carries no filter stamp, so it does not claim to be a slice",
  );
  const directNote = describeDirectOrderReportFilters({ search: " Cairo ", statuses: ["approved", "pending_approval"] });
  assert.equal(
    directNote,
    'Filtered export — this workbook covers only: Status: Pending, Approved · Search: "Cairo".',
    "the stamp names the statuses in chip order using their labels, and quotes the trimmed search term",
  );
  assert.ok(
    directNote != null && !directNote.includes("pending_approval"),
    "the stamp must never leak the raw status code into a file the owner reads",
  );
  assert.deepEqual(
    DIRECT_ORDER_REPORT_STATUS_OPTIONS.map((option) => option.key),
    ["pending_approval", "approved", "returned", "rejected", "reversed", "draft", "held", "expired", "cancelled"],
    "both report screens render these chips from this one list, so it fixes the stamp's ordering too",
  );
  // The three held-lane statuses were absent from this list until 2026-08-05, and
  // describeDirectOrderReportFilters falls back to the RAW key for a status it does not recognise.
  // So filtering the report by Held used to stamp the literal "held" into a workbook the owner
  // reads — the exact raw-code leak the assertion above this one exists to prevent. Naming them
  // here means the fallback branch can never quietly start covering a real status again.
  assert.equal(
    describeDirectOrderReportFilters({ search: "", statuses: ["held", "expired", "cancelled"] }),
    "Filtered export — this workbook covers only: Status: Held, Expired, Cancelled.",
    "every real status must stamp its human-readable label; hitting the unknown-status fallback means a raw code reached the owner's file",
  );

  // ── Company Vacation Report: every on-screen filter must reach the workbook ───────────────
  const vacationRows = [
    vacationRow({ hrId: "HR-1", source: "HR Approved", hasBalance: true, lineName: "Pedia", startDate: "2026-03-01", endDate: "2026-03-03", workingDays: 3 }),
    vacationRow({ hrId: "HR-2", source: "HR Rejected", hasBalance: null, lineName: "CNS", startDate: "2026-05-04", endDate: "2026-05-04" }),
    vacationRow({ hrId: "HR-3", source: "CRM Signal — Vacation", hasBalance: null, lineName: "Pedia", startDate: "2026-07-20", endDate: "2026-07-20", employeeName: "Karim Fouad" }),
  ];

  assert.deepEqual(
    filterCompanyVacationReportRows(vacationRows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, source: "HR Rejected" }).map((row) => row.hrId),
    ["HR-2"],
    "the Source dropdown must reach the file — the old export always shipped the whole year",
  );
  assert.deepEqual(
    filterCompanyVacationReportRows(vacationRows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, lineName: "Pedia" }).map((row) => row.hrId),
    ["HR-1", "HR-3"],
    "the Line advanced filter narrows the file the same way it narrows the table",
  );
  assert.deepEqual(
    filterCompanyVacationReportRows(vacationRows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, hasBalance: "N/A" }).map((row) => row.hrId),
    ["HR-2", "HR-3"],
    "Has Balance = N/A selects exactly the rows that never went through the balance engine",
  );
  assert.deepEqual(
    filterCompanyVacationReportRows(vacationRows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, query: "karim" }).map((row) => row.hrId),
    ["HR-3"],
    "the search box narrows the file, so the row count in the workbook matches the counter beside the button",
  );
  assert.equal(
    filterCompanyVacationReportRows(vacationRows, { ...NO_COMPANY_VACATION_REPORT_FILTERS }).length,
    3,
    "an untouched filter bar still exports the full requested range",
  );

  // From/To narrow by overlap: a request straddling the boundary is partly inside the window
  // the reader asked for, so it must survive rather than be hidden.
  const straddling = vacationRow({ hrId: "HR-4", startDate: "2026-02-26", endDate: "2026-03-04" });
  assert.deepEqual(
    filterCompanyVacationReportRows([straddling], { ...NO_COMPANY_VACATION_REPORT_FILTERS, fromDate: "2026-03-01", toDate: "2026-03-31" }).map((row) => row.hrId),
    ["HR-4"],
    "a request that starts before the From date but runs into the window is real leave inside it and must not be dropped",
  );
  assert.equal(
    filterCompanyVacationReportRows([straddling], { ...NO_COMPANY_VACATION_REPORT_FILTERS, fromDate: "2026-04-01" }).length,
    0,
    "a request that ends before the From date is genuinely outside the window",
  );

  // An unrecognised value must narrow to nothing rather than fall back to the default, because
  // the fallback direction is the one that silently widens the file.
  assert.equal(
    filterCompanyVacationReportRows(vacationRows, { ...NO_COMPANY_VACATION_REPORT_FILTERS, source: "HR Invented" }).length,
    0,
    "an unknown Source narrows to nothing — falling back to 'All' would export every row the reader had filtered away",
  );

  // The link is a GET, so the params it writes and the params the route reads must be one
  // round trip; a key spelled differently on either side re-creates the whole defect silently.
  const roundTrip = { fromDate: "2026-03-01", hasBalance: "Yes", lineName: "Pedia", query: "mona", source: "HR Approved", toDate: "2026-03-31" };
  assert.deepEqual(
    parseCompanyVacationReportFilters(companyVacationReportFilterParams(roundTrip)),
    roundTrip,
    "every filter the link writes must be readable back by the route with the same key and value",
  );
  assert.equal(
    companyVacationReportFilterParams(NO_COMPANY_VACATION_REPORT_FILTERS).toString(),
    "",
    "an unfiltered export keeps its plain startDate/endDate URL — no filter keys are invented",
  );
  assert.deepEqual(
    parseCompanyVacationReportFilters(new URLSearchParams("startDate=2026-01-01&endDate=2026-08-04")),
    NO_COMPANY_VACATION_REPORT_FILTERS,
    "a bookmarked pre-fix URL with no filter keys still means the full range",
  );

  assert.equal(
    describeCompanyVacationReportFilters(NO_COMPANY_VACATION_REPORT_FILTERS),
    null,
    "an unfiltered vacation workbook carries no stamp",
  );
  assert.equal(
    describeCompanyVacationReportFilters({ ...NO_COMPANY_VACATION_REPORT_FILTERS, lineName: "Pedia", source: "HR Approved" }),
    "Filtered export — this workbook covers only: Source: HR Approved · Line: Pedia.",
    "a filtered vacation workbook says which slice it is, since it gets forwarded without the screen it came from",
  );

  // ── Contract: the routes and screens are DB-bound, so guard the wiring itself ─────────────
  assert.match(
    directOrdersExportRouteSource,
    /filterDirectOrderReportRows\(visibleRows, filters\)/,
    "the direct-orders export must narrow its server-loaded rows by the posted filter, not ship everything the viewer may see",
  );
  assert.match(
    directOrdersExportRouteSource,
    /describeDirectOrderReportFilters\(filters\)/,
    "the direct-orders workbook must stamp its own filter context so a forwarded slice cannot read as company-wide",
  );
  assert.match(
    vacationExportRouteSource,
    /filterCompanyVacationReportRows\(rangeRows, filters\)/,
    "the vacation export must narrow by the link's filters instead of always shipping the whole range",
  );
  assert.match(
    vacationExportRouteSource,
    /parseCompanyVacationReportFilters\(url\.searchParams\)/,
    "the vacation export must read the filters off the query string the table builds",
  );
  for (const [name, source] of [
    ["admin direct-orders workspace", directOrdersWorkspaceSource],
    ["portal direct-orders report", directOrdersPortalSource],
  ] as const) {
    assert.match(
      source,
      /body: JSON\.stringify\(filters\)/,
      `the ${name} must post its on-screen filter with the export request — an empty body is what made the file contradict the KPI cards`,
    );
    assert.match(
      source,
      /filterDirectOrderReportRows\(rows, filters\)/,
      `the ${name} must narrow through the shared filter, so screen and file cannot drift apart`,
    );
  }
  assert.match(
    vacationTableSource,
    /companyVacationReportFilterParams\(filters\)/,
    "the vacation Export Excel link must carry the active filters, not just the date range",
  );
  assert.match(
    vacationTableSource,
    /filterCompanyVacationReportRows\(rows, filters\)/,
    "the vacation table must narrow through the shared filter the export route also uses",
  );
}
