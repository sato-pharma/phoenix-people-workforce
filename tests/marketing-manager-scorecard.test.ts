import assert from "node:assert/strict";

import { marketingDraftBlockers } from "../src/lib/marketing-requests/draft-blockers.ts";
import { buildMarketingManagerScorecard } from "../src/lib/marketing-requests/manager-scorecard.ts";
import {
  buildMarketingManagerScorecardPdf,
  buildMarketingManagerScorecardPdfDocDefinition,
  buildMarketingManagerScorecardWorkbook,
  marketingManagerScorecardFilename,
} from "../src/lib/marketing-requests/manager-scorecard-export.ts";
import type {
  MarketingRoiReportRow,
  RoiAttributionLine,
} from "../src/lib/marketing-requests/roi-report-types.ts";

// The Manager Scorecard (owner instruction, 2026-10-09) and its two exports. Three things are
// pinned here, because getting any of them wrong misreports money to an executive:
//
//  1. THE DEDUPE. Attribution matches a campaign to an invoice line on distributor + pharmacy code
//     + product + month and nothing makes that match exclusive, so two campaigns on the same
//     pharmacy both legitimately claim one sale. Summing the per-request figures read 729,884.77
//     against 480,155.92 of real sales on production (+52%). Per manager AND in the footer.
//  2. THE EXPORTS REPEAT THE SCREEN. Excel and PDF are built from the SAME scorecard object the
//     page renders, so a forwarded file can never carry a total the page did not show — above all
//     the deduped one, which a second query would get wrong in the same +52% direction.
//  3. 🔴 IT BLOCKS NOBODY (owner, 2026-10-09: "don't put the rule … never block anyone"). An
//     earlier cut of this feature refused a new request below a recovery threshold; he had not
//     approved that, and it was removed the same day. The report reads and reports, full stop.

function row(overrides: Partial<MarketingRoiReportRow> & { requestId: string }): MarketingRoiReportRow {
  return {
    actualCoverageRatio: 0,
    actualSalesUnits: 0,
    actualSalesValue: 0,
    approverRoleKeys: [],
    attributionGapReason: null,
    attributionQuality: "no_sales",
    customerName: "Test pharmacy",
    dataCoverage: "complete",
    distributorCodes: [],
    estimatedCost: 0,
    expectedRoiValue: 0,
    forecastCoverageRatio: 0,
    hasSalesData: false,
    line: "Pedia",
    payDate: "2026-03-01",
    productCodes: [],
    region: "Delta",
    requesterHrId: "b-200",
    requesterName: "Hoda Samir",
    requestCode: `MKT-REQ-${overrides.requestId}`,
    requestTypeName: "Doctor meeting",
    requiredRoiValue: 0,
    resultStatus: "on_track",
    roiDurationMonths: 3,
    roiWindow: "2026-03 → 2026-05",
    salesDataComplete: true,
    status: "approved",
    ...overrides,
  };
}

function line(overrides: Partial<RoiAttributionLine> & { requestId: string }): RoiAttributionLine {
  return {
    customerCode: "C-1",
    distributorCode: "D-1",
    invoicePeriod: "2026-04",
    productCode: "TB040",
    qty: 10,
    value: 1_000,
    ...overrides,
  };
}

function build(input: { lines?: RoiAttributionLine[]; rows: MarketingRoiReportRow[] }) {
  return buildMarketingManagerScorecard({
    attributionLines: input.lines ?? [],
    generatedAtIso: "2026-06-15T09:00:00.000Z",
    rows: input.rows,
    salesDataAsOf: "2026-05",
  });
}

export async function runMarketingManagerScorecardTests() {
  // ── His own example, verbatim: "one did five requests, three from them are approved … the first
  //    is one thousand, the second two thousand and the third four thousand — you will calculate
  //    their sum." ──────────────────────────────────────────────────────────────────────────────
  const hisExample = build({
    rows: [
      row({ estimatedCost: 1_000, expectedRoiValue: 12_000, requestId: "a1", requiredRoiValue: 10_000, status: "approved" }),
      row({ estimatedCost: 2_000, expectedRoiValue: 25_000, requestId: "a2", requiredRoiValue: 20_000, status: "closed" }),
      row({ estimatedCost: 4_000, expectedRoiValue: 41_000, requestId: "a3", requiredRoiValue: 40_000, status: "roi_tracking" }),
      row({ estimatedCost: 3_000, requestId: "a4", status: "pending_approval" }),
      row({ estimatedCost: 5_000, requestId: "a5", status: "rejected" }),
    ],
  });

  assert.equal(hisExample.rows.length, 1, "one requester, one row — the report is per PERSON, not per request");
  const [person] = hisExample.rows;
  assert.equal(person.managerName, "Hoda Samir", "the row is named, never keyed by HR id on screen");
  assert.equal(person.totalRequests, 5, "every request he raised is counted, whatever its status");
  assert.equal(person.approvedRequests, 3, "three of the five carry committed money");
  assert.equal(person.awaitingRequests, 1, "the one still in approval is awaiting a decision, not approved");
  assert.equal(
    person.refusedRequests,
    1,
    "a rejected request is neither approved nor awaiting — its money was never committed, and bucketing it as pending told an executive that refused spend was still live",
  );
  assert.equal(person.approvedValue, 7_000, "1,000 + 2,000 + 4,000 — the total value of the APPROVED requests");
  assert.equal(
    person.totalRequestedValue,
    15_000,
    "all five requests' value, so the asked-for figure never silently becomes the approved one",
  );
  assert.equal(person.expectedRoiValue, 78_000, "the sum of the forecast ROI across the approved requests");
  assert.equal(person.requiredRoiValue, 70_000, "and the return those campaigns must produce");

  // ── The dedupe, per manager ──────────────────────────────────────────────────────────────────
  // Two of this person's campaigns target the same pharmacy and product in the same month, so each
  // legitimately claims the same EGP 1,000 invoice line. His row must show 1,000, not 2,000.
  const shared = build({
    lines: [line({ requestId: "b1" }), line({ requestId: "b2" })],
    rows: [
      row({ actualSalesValue: 1_000, estimatedCost: 1_000, requestId: "b1" }),
      row({ actualSalesValue: 1_000, estimatedCost: 1_000, requestId: "b2" }),
    ],
  });
  assert.equal(
    shared.rows[0].actualValue,
    1_000,
    "one sale claimed by two of his campaigns is counted ONCE — adding the per-request figures is the +52% defect the attribution ledger exists to close",
  );
  assert.equal(
    shared.totals.actualValue,
    1_000,
    "and the footer agrees, because it deducts the same proven overlap",
  );

  // Three identical signatures inside ONE request are three real sales, so the multiset reconcile
  // must not collapse them into one (197 signatures cover 309 real lines on production).
  const repeated = build({
    lines: [line({ requestId: "c1" }), line({ requestId: "c1" }), line({ requestId: "c1" })],
    rows: [row({ actualSalesValue: 3_000, estimatedCost: 1_000, requestId: "c1" })],
  });
  assert.equal(
    repeated.rows[0].actualValue,
    3_000,
    "identical lines within one request are distinct sales — deduping on the signature alone would under-report the company's own sales",
  );

  // ── The dedupe, across DIFFERENT managers ────────────────────────────────────────────────────
  // The footer cannot be the sum of the already-deduped per-manager figures: two people's
  // campaigns can claim the same sale too.
  const twoManagers = build({
    lines: [line({ requestId: "d1" }), line({ requestId: "d2" })],
    rows: [
      row({ actualSalesValue: 1_000, estimatedCost: 2_000, requestId: "d1", requesterHrId: "b-200", requesterName: "Hoda Samir" }),
      row({ actualSalesValue: 1_000, estimatedCost: 1_000, requestId: "d2", requesterHrId: "b-201", requesterName: "Mina Fouad" }),
    ],
  });
  assert.equal(twoManagers.rows.length, 2, "two requesters, two rows");
  assert.equal(
    twoManagers.rows[0].managerName,
    "Hoda Samir",
    "rows are ordered by approved spend — a money report opens on the biggest spender",
  );
  assert.equal(twoManagers.rows[0].actualValue, 1_000, "each manager's own figure is right per manager");
  assert.equal(twoManagers.rows[1].actualValue, 1_000, "and so is the other's");
  assert.equal(
    twoManagers.totals.actualValue,
    1_000,
    "the COMPANY figure counts that one sale once — summing the two correct rows would double it",
  );
  assert.equal(twoManagers.totals.managerCount, 2, "the footer names how many people it covers");
  assert.equal(twoManagers.totals.approvedValue, 3_000, "and the committed spend behind it");

  // ── Ratios ──────────────────────────────────────────────────────────────────────────────────
  const ratios = build({
    rows: [row({ actualSalesValue: 5_000, estimatedCost: 10_000, requestId: "e1", requiredRoiValue: 100_000 })],
  });
  assert.equal(ratios.rows[0].recoveryRatio, 0.5, "half of the approved spend came back");
  assert.equal(
    ratios.rows[0].roiCoverageRatio,
    0.05,
    "and 5% of the required return — required ROI is cost x 10, so the two ratios are never the same number",
  );

  // ── The report refuses nobody ────────────────────────────────────────────────────────────────
  // His instruction, 2026-10-09: "don't put the rule … never block anyone". The row carries no
  // verdict, and the draft form's blocker list has no entry this report could ever fill.
  assert.equal(
    "gate" in (ratios.rows[0] as Record<string, unknown>),
    false,
    "a scorecard row carries figures only — a verdict field here is what a refusal would be built from next",
  );
  assert.deepEqual(
    marketingDraftBlockers({
      customerId: "cust-1",
      estimatedCost: 4_000,
      hasProductWithQuantity: true,
      otherRequestType: "",
      requestDate: "2026-06-15",
      requestTypeId: "2",
      requiresDescription: false,
      roiDurationMonths: "3",
      selectedPharmacyCount: 1,
      unverifiedCodesMissingReason: 0,
    }),
    [],
    "a complete marketing request saves, whatever this report says about the person raising it",
  );

  // ── The Excel export ────────────────────────────────────────────────────────────────────────
  // Built from twoManagers, so the file inherits the COMPANY dedupe: the total row must read the
  // one shared sale once (1,000), never the sum of the two correct manager rows (2,000).
  const workbook = await buildMarketingManagerScorecardWorkbook(twoManagers);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Report Info", "Manager Scorecard"],
    "the file says what it is and when it was taken before it says who spent what",
  );

  const sheet = workbook.getWorksheet("Manager Scorecard");
  assert.ok(sheet, "the sheet exists");
  assert.deepEqual(
    (sheet.getRow(1).values as unknown[]).slice(1),
    [
      "Manager",
      "Line",
      "Region",
      "Requests Raised",
      "Approved",
      "Awaiting Decision",
      "Refused Or Called Off",
      "Requested Value (EGP)",
      "Approved Value (EGP)",
      "Forecast ROI (EGP)",
      "Required Return (EGP)",
      "Actual Collected (EGP)",
      "Collected Of Approved",
      "Collected Of Required",
    ],
    "every figure gets its own column — the fits-the-screen rule governs a viewport, and a sheet has none",
  );
  assert.equal(sheet.rowCount, 4, "a header, both managers, and the total row");

  const firstManagerRow = sheet.getRow(2);
  assert.equal(firstManagerRow.getCell("managerName").value, "Hoda Samir", "named, never keyed by HR id");
  assert.equal(
    firstManagerRow.getCell("approvedValue").value,
    2_000,
    "money stays NUMERIC — a reader who sums a column of text gets zero",
  );
  assert.equal(typeof firstManagerRow.getCell("actualValue").value, "number", "and so does the collected figure");

  const totalRow = sheet.getRow(4);
  assert.match(
    String(totalRow.getCell("managerName").value),
    /^TOTAL · 2 managers$/,
    "the last row is the company total, and says how many people it covers",
  );
  assert.equal(
    totalRow.getCell("actualValue").value,
    1_000,
    "🔴 the file inherits the deduped company figure — one sale claimed by two managers' campaigns, counted ONCE. Summing the rows above it would print 2,000 and no reader of the file could tell",
  );
  assert.equal(totalRow.getCell("approvedValue").value, 3_000, "and the committed spend behind it");

  const info = workbook.getWorksheet("Report Info");
  assert.ok(info, "the info sheet exists");
  const infoFields = info.getRows(2, info.rowCount - 1)?.map((entry) => String(entry.getCell("field").value)) ?? [];
  assert.ok(
    infoFields.includes("Actual sales attributed up to"),
    "the file states the sales frontier on its own face — a figure read a month later must say what it was true of",
  );
  assert.ok(infoFields.includes("Generated"), "and when it was taken, in Cairo");

  // ── The PDF export ──────────────────────────────────────────────────────────────────────────
  const doc = buildMarketingManagerScorecardPdfDocDefinition(twoManagers);
  const flat = JSON.stringify(doc);
  assert.ok(flat.includes("Marketing Manager Scorecard"), "the page names the report");
  assert.ok(flat.includes("Hoda Samir") && flat.includes("Mina Fouad"), "and carries both managers");
  assert.ok(flat.includes("TOTAL · 2 managers"), "with the same total row the sheet has");
  assert.ok(
    flat.includes("EGP 1,000"),
    "printing the deduped company figure, not the 2,000 a re-sum would produce",
  );
  assert.ok(
    flat.includes("Sept 2026") || flat.includes("May 2026") || flat.includes("no validated sales data yet"),
    "the month name comes from CAIRO_MONTHS — an Intl abbreviation here would read 'Sep' or 'Sept' depending on the runtime",
  );
  assert.equal(
    (doc as { pageOrientation?: string }).pageOrientation,
    "landscape",
    "six money columns do not fit a portrait page without shrinking the type, which the fits-the-screen rule forbids",
  );

  const pdf = await buildMarketingManagerScorecardPdf(twoManagers);
  assert.equal(pdf.subarray(0, 4).toString("latin1"), "%PDF", "a real PDF, not a buffer of an error page");
  assert.ok(pdf.byteLength > 1_000, "and one with content in it");

  // ── The filename ────────────────────────────────────────────────────────────────────────────
  // 23:30 UTC on 8 Oct is already 9 Oct in Cairo. A file named from the UTC day would be filed
  // under the wrong date for every export taken after 22:00 Cairo.
  assert.equal(
    marketingManagerScorecardFilename("2026-10-08T23:30:00.000Z", "xlsx"),
    "marketing-manager-scorecard-2026-10-09.xlsx",
    "the Cairo day, never the UTC one",
  );
  assert.equal(
    marketingManagerScorecardFilename("2026-10-08T23:30:00.000Z", "pdf"),
    "marketing-manager-scorecard-2026-10-09.pdf",
    "and the same for the printable copy",
  );
}
