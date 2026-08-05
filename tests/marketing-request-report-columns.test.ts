import assert from "node:assert/strict";

import {
  APPROVAL_COLUMNS,
  PHARMACY_COLUMNS,
  PRODUCT_COLUMNS,
  REQUEST_COLUMNS,
  approvalRowCells,
  cairoDateTime,
  humanize,
  pharmacyRowCells,
  productRowCells,
  requestPreviewUrl,
  requestRowCells,
  sundayOnOrBefore,
  weekBreakdown,
  type FullReportRequest,
} from "../src/lib/marketing-requests/request-report-columns.ts";

// ─────────────────────────────────────────────────────────────────────────────
// request-report-columns.ts defines what a Marketing Request row IS. It holds no Supabase and no
// ExcelJS import precisely so it can be executed here rather than only read.
//
// The two things worth guarding:
//   1. Every column array and its row builder are positional twins with no compile-time link.
//      One extra label without a matching cell shifts every later column, so "Amount" ends up
//      over ROI money. Nothing but this test notices.
//   2. The Month / Week columns encode a business rule the owner stated by hand: anchored on
//      REQUEST DATE, week runs Sunday → Thursday, W1 is the week containing the 1st. The live
//      request dated Sunday 2 Aug 2026 must read W2, because 1 Aug is a Saturday whose week
//      began Sunday 26 July. That off-by-one is exactly what a future refactor would "fix".
// ─────────────────────────────────────────────────────────────────────────────

function request(overrides: Partial<FullReportRequest> = {}): FullReportRequest {
  return {
    approvalSteps: [],
    approvedAt: "2026-08-04T13:11:24.784Z",
    areaName: "Delta (2)",
    closedAt: null,
    contactCode: null,
    contactCrmCode: null,
    contactMobileNumber: null,
    contactName: null,
    contactNotes: null,
    contactSpecialty: null,
    createdAt: "2026-08-02T19:42:21.566Z",
    createdByName: "Sally Saied Sedhom Mankrios Sedhom",
    currentStepName: null,
    customerCapturedAccuracyMeters: 5.7685,
    customerCapturedAddress: "PQGW+3GR, Radwan Mansour St, Fakous, Al-Sharqia Governorate, Egypt",
    customerCapturedAt: "2026-08-02T14:03:00.000Z",
    customerCapturedLatitude: 30.72513372,
    customerCapturedLongitude: 31.79614512,
    customerCode: "MKT-HCP-20260802-89B44D9B",
    customerCreatedAt: "2026-08-02T14:03:00.000Z",
    customerCreatedByName: "Sally Saied Sedhom Mankrios Sedhom",
    customerEvidenceHasTimestamp: true,
    customerEvidencePhotoCapturedAt: "2026-08-02T14:05:20.772Z",
    customerEvidencePhotoName: "customer-live-2026-08-02T14:05:20.772Z.jpg",
    customerEvidenceStatus: "complete",
    customerExtractedAreaName: "Faqous",
    customerExtractedGovernorateName: "Al-Sharqia Governorate",
    customerManagerName: null,
    customerName: "هيثم خضري",
    customerOtherTypeDescription: null,
    customerOwnerName: "Sally Saied Sedhom Mankrios Sedhom",
    customerRegionName: "Faqous, Al-Sharqia Governorate",
    customerType: "clinic",
    customerValidatedAt: null,
    customerValidatedByName: null,
    customerValidationNotes: null,
    customerValidationStatus: "system_validated",
    estimatedCost: 5500,
    executedAt: null,
    expectedRoiValue: 45531.81,
    financeInvoiceDeadlineDate: null,
    financeInvoiceFileName: null,
    financeInvoiceRequired: null,
    financeInvoiceStatus: null,
    financeInvoiceUploadedAt: null,
    financeInvoiceUploadedByName: null,
    financeNotes: null,
    financeReviewedAt: null,
    financeReviewerName: null,
    financeTransferProofFileName: null,
    financeTransferProofUploadedAt: null,
    financeTransferProofUploadedByName: null,
    lineName: "CNS",
    managerHrId: "B-122",
    managerName: "Amr Mohamed Naguib Elsabey",
    notes: null,
    origin: "phoenix",
    otherRequestType: null,
    payDate: "2026-08-05",
    pharmacies: [],
    products: [],
    rejectedAt: null,
    requestCode: "MKT-REQ-20260802-DCF31EC4",
    requestDate: "2026-08-02",
    requestTypeCode: "special_request",
    requestTypeDescription: null,
    requestTypeName: "Special request",
    requestTypeRequiresDescription: false,
    requesterAreaName: "Delta (2)",
    requesterHrId: "B-184",
    requesterName: "Sally Saied Sedhom Mankrios Sedhom",
    requesterRegionName: "Delta (2)",
    requiredRoiValue: 55000,
    returnedAt: null,
    returnedStepSequence: null,
    roiActualCoverageRatio: null,
    roiActualSalesUnits: null,
    roiActualSalesValue: null,
    roiActualStatus: null,
    roiAttributionQuality: null,
    roiCalculatedAt: null,
    roiCoverageGap: null,
    roiCoverageRatio: 0.8279,
    roiDurationMonths: 5,
    roiExactSalesRows: null,
    roiExpectedGap: null,
    roiFallbackSalesRows: null,
    roiPayMonth: null,
    roiRecommendedAction: null,
    roiSalesRows: null,
    roiStatus: "under_target",
    status: "approved",
    submittedAt: "2026-08-02T19:42:21.566Z",
    trackDirectSales: false,
    updatedAt: "2026-08-04T13:11:24.784Z",
    updatedByName: null,
    ...overrides,
  };
}

export async function runMarketingRequestReportColumnsTests() {
  // ── 1. Positional twins ──
  assert.equal(
    requestRowCells(request(), 1).length,
    REQUEST_COLUMNS.length,
    "Requests: every column label must have exactly one cell, or the header sits over the wrong data",
  );
  assert.equal(
    productRowCells(request(), {
      expectedValue: 24422.5, factoryPriceSnapshot: 97.69, forecastQuantity: 250, lineSnapshot: "CNS",
      productCode: "TB080", productFamily: "Tebofortine", productName: "Tebofortine Forte 80",
      sourceCompany: "Sato", valueShare: 0.536383,
    }).length,
    PRODUCT_COLUMNS.length,
    "Products: column and cell counts must match",
  );
  assert.equal(
    approvalRowCells(request(), {
      allowReject: true, allowReturn: true, assignedHrId: "B-122", assignedName: "Amr Mohamed Naguib Elsabey",
      assignedRole: "National Sales Manager", decidedAt: "2026-08-03T10:46:00.000Z", decidedByHrId: "B-122",
      decidedByName: "Amr Mohamed Naguib Elsabey", decisionNote: null, executedAt: null, isCc: false,
      sequence: 1, status: "approved", stepCode: "nsm", stepKind: "approval",
      stepName: "National Sales Manager Approval", terminalStatus: null,
    }).length,
    APPROVAL_COLUMNS.length,
    "Approval trail: column and cell counts must match",
  );
  assert.equal(
    pharmacyRowCells(request(), {
      capturedAccuracyMeters: null, capturedAddress: null, capturedAt: null, capturedLatitude: null,
      capturedLongitude: null, distributorCode: "IBN", distributorName: "Ibn sina",
      distributorPharmacyCode: "432680", evidenceStatus: null, extractedAreaName: null,
      extractedGovernorateName: null, notes: null, pharmacyCode: "MKT-PHA-20260802-34F34992",
      pharmacyName: "(مصر)حازم", referenceMatchCount: null, referenceStatus: null,
      regionName: "Faqous, Al-Sharqia Governorate", trackingStatus: "pending_validation",
      validatedAt: null, validatedByName: null, validationNotes: null, validationStatus: null,
    }).length,
    PHARMACY_COLUMNS.length,
    "Pharmacies: column and cell counts must match",
  );

  // ── 2. The owner's 16 template columns must stay first, in his exact wording ──
  assert.deepEqual(
    REQUEST_COLUMNS.slice(0, 16).map((column) => column.label),
    [
      "Serial", "Month", "Week Start", "Week End", "Week", "Line", "Type", "Account/Dr.Name",
      "Address", "Region", "Contact for money transfer", "Money transfer Date", "Amount",
      "Estimated ROI", "Notes", "Request Preview",
    ],
    "the owner's template header row must survive verbatim as the first 16 columns",
  );

  // ── 3. The week rule ──
  const week = weekBreakdown("2026-08-02");
  assert.equal(week.month, "August 2026");
  assert.equal(week.weekStart, "02 Aug 2026", "2 Aug 2026 is itself a Sunday, so it starts its own week");
  assert.equal(week.weekEnd, "06 Aug 2026", "the week ends on the Thursday, Sunday + 4");
  assert.equal(
    week.week,
    "W2",
    "1 Aug 2026 is a Saturday whose week began Sunday 26 July, so Sunday 2 Aug is the month's SECOND week",
  );

  // A Saturday belongs to the week that starts the NEXT day, not the previous Sunday.
  assert.equal(sundayOnOrBefore(new Date(Date.UTC(2026, 7, 1))).toISOString().slice(0, 10), "2026-07-26");
  // A request on the 1st when the 1st IS a Sunday must read W1.
  assert.equal(weekBreakdown("2026-03-01").week, "W1", "when the 1st is a Sunday it opens W1");
  // A missing request date must blank all four rather than inventing today's week.
  assert.deepEqual(weekBreakdown(null), { month: null, week: null, weekEnd: null, weekStart: null });

  // ── 4. Values the owner reads ──
  const cells = requestRowCells(request(), 7);
  assert.equal(cells[0], 7, "Serial is the report's own row counter");
  assert.equal(cells[7], "هيثم خضري", "an Arabic account name must survive untouched");
  assert.equal(cells[12], 5500, "Amount must stay a NUMBER so Excel can total it");
  assert.equal(cells[13], 45531.81, "Estimated ROI must stay a number");
  assert.equal(
    cells[15],
    "https://phoenix-hr.satopharma.com/employee-portals/marketing-requests/decision/MKT-REQ-20260802-DCF31EC4",
    "Request Preview must be the deep link into Phoenix",
  );

  // With a contact present, column H carries both halves of "Account/Dr.Name".
  const withDoctor = requestRowCells(request({ contactName: "Dr. Heitham Khedary" }), 1);
  assert.equal(withDoctor[7], "هيثم خضري / Dr. Heitham Khedary");

  // ── 5. Rendering rules ──
  assert.equal(humanize("pending_validation"), "Pending validation");
  assert.equal(humanize(null), null, "a null enum stays blank rather than becoming the string 'null'");
  assert.equal(
    cairoDateTime("2026-08-02T19:42:21.566Z"),
    "02 Aug 2026, 22:42",
    "instants render in Africa/Cairo (UTC+3 in August), never raw UTC",
  );
  assert.equal(cairoDateTime(null), null);
  assert.equal(requestPreviewUrl("A B"), "https://phoenix-hr.satopharma.com/employee-portals/marketing-requests/decision/A%20B");

  // ── 6. Clickable files ──
  // The three link columns are the last three, and they are the SAME columns in the .xlsx and in
  // the live sheet — only the URL base differs. A link is emitted ONLY when the file exists.
  assert.deepEqual(
    REQUEST_COLUMNS.slice(-3).map((column) => column.label),
    ["Evidence photo link", "Money transfer proof link", "Invoice link"],
  );

  const links = { evidence: "https://x/e", invoice: "https://x/i", transferProof: "https://x/p" };

  // The live request HAS an evidence photo name but no finance files: exactly one link, two blanks.
  const partial = requestRowCells(request(), 1, links);
  assert.equal(partial.at(-3), "https://x/e", "an evidence photo that exists must link");
  assert.equal(partial.at(-2), null, "no transfer proof on file means NO link, not a dead one");
  assert.equal(partial.at(-1), null, "no invoice on file means NO link, not a dead one");

  // All three present.
  const full = requestRowCells(
    request({ financeInvoiceFileName: "inv.pdf", financeTransferProofFileName: "proof.jpg" }),
    1,
    links,
  );
  assert.deepEqual(full.slice(-3), ["https://x/e", "https://x/p", "https://x/i"]);

  // Omitting the links argument (the plain .xlsx download) must blank all three rather than throw
  // or emit "undefined" into a cell the owner reads.
  assert.deepEqual(requestRowCells(request(), 1).slice(-3), [null, null, null]);
}
